import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
    PROFILE_PROVIDER_CANARY_ACTOR,
    PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD,
    PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD,
    profileProviderCanaryRunStore,
    type ProfileProviderCanaryRunStore,
    type StoredProfileProviderCanaryRun,
} from '../lib/services/analysis/profile-provider-canary-run-store';
import { isAnalysisV2RecoveryAvailable } from '../lib/services/analysis/v2-execution-gate';
import { makeApifyProvider } from '../lib/services/instagram/providers/apify';
import { runReplacementProfileDetails } from '../lib/services/instagram/providers/apify-profile-details';
import {
    getApifyClient,
    type ApifyClientLike,
} from '../lib/services/instagram/providers/apify-relationship';
import { validateProfileAttemptResults } from '../lib/services/instagram/providers/profile-attempt';
import type {
    ApifyCredentialSlot,
    ProfileAttemptResult,
    ProviderCallContext,
} from '../lib/services/instagram/providers/types';
import {
    parseProfileRepairCanarySourceInput,
    requireProfileRepairCanaryOperatorIdentity,
    validateProfileRepairCanarySource,
    type ProfileRepairCanarySourceBundle,
} from './canary-apify-profile-repair-validation';
import type {
    InstagramProfileProviderCanaryDependencies,
    InstagramProfileProviderCanaryRunRecord,
    InstagramProfileProviderCanarySource,
    ProfileProviderCanaryApifyClient,
    ProfileProviderCanaryOutcome,
    ProfileProviderCanaryRunEvidence,
    ProfileProviderCanaryStorage,
} from './canary-instagram-profile-provider';
import type {
    FinalizeProfileProviderCanaryContext,
    FinalizeProfileProviderCanaryDependencies,
} from './finalize-profile-provider-canary';
import { PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT } from './canary-instagram-profile-provider-options';

const ORDERED_SET_HMAC_DOMAIN =
    'yeosachin:profile-provider-canary:ordered-public-incomplete:v1\0';
const HMAC_SECRET_ENV = 'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET';
const CRITICAL_JOB_KEY = 'track:profiles:batch:7';
const ACCOUNTING_MAX_POLLS = 37;
const ACCOUNTING_POLL_MS = 5_000;
const ACCOUNTING_STABILITY_MS = 30_000;
const ACCOUNT_ACCESS_ATTESTATION_MIN_AGE_MS = 60_000;
const ACCOUNT_ACCESS_ATTESTATION_MAX_AGE_MS = 5 * 60_000;
const FAIL_CLOSED_LATENCY_MS = 300_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const APIFY_PRICING_TIERS = new Set([
    'FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND',
]);
const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');

interface RuntimeStorageClient {
    delete(): Promise<unknown>;
    get(): Promise<unknown | undefined>;
}

interface RuntimeRunClient {
    get(): Promise<{
        status?: unknown;
        usageTotalUsd?: unknown;
        startedAt?: unknown;
        finishedAt?: unknown;
        buildNumber?: unknown;
        generalAccess?: unknown;
    } | undefined>;
    keyValueStore(): RuntimeStorageClient & {
        getRecord(key: string): Promise<unknown>;
    };
    dataset(): RuntimeStorageClient;
    requestQueue(): RuntimeStorageClient;
}

interface RuntimeActorClient {
    get(): Promise<{
        isPublic?: unknown;
        isDeprecated?: unknown;
        actorPermissionLevel?: unknown;
        pricingInfos?: unknown;
        taggedBuilds?: unknown;
    } | undefined>;
}

interface RuntimeUserClient {
    get(): Promise<{
        isPaying?: unknown;
        plan?: { monthlyUsageCreditsUsd?: unknown; tier?: unknown };
    }>;
    limits(): Promise<{
        limits?: {
            maxConcurrentActorJobs?: unknown;
            maxMonthlyUsageUsd?: unknown;
        };
        current?: { activeActorJobCount?: unknown; monthlyUsageUsd?: unknown };
    } | undefined>;
}

export interface ProfileProviderCanaryRuntimeClient extends ApifyClientLike {
    actor(actorId: string): ReturnType<ApifyClientLike['actor']> & RuntimeActorClient;
    run(runId: string): ReturnType<ApifyClientLike['run']> & RuntimeRunClient;
    user(id?: string): RuntimeUserClient;
}

interface RuntimeOverrides {
    env?: Record<string, string | undefined>;
    store?: ProfileProviderCanaryRunStore;
    clientForSlot?: (slot: ApifyCredentialSlot) => ProfileProviderCanaryRuntimeClient;
    getSourceProfilesBatchOutcomes?: (
        usernames: readonly string[],
        context: ProviderCallContext,
        client: ProfileProviderCanaryRuntimeClient
    ) => Promise<ProfileAttemptResult[]>;
    runReplacement?: typeof runReplacementProfileDetails;
    paidReadiness?: (input: {
        env: Record<string, string | undefined>;
        client: ProfileProviderCanaryRuntimeClient;
        commandRunner: NonNullable<RuntimeOverrides['commandRunner']>;
        now: () => number;
    }) => Promise<void>;
    commandRunner?: (input: {
        file: string;
        args: readonly string[];
        env: Record<string, string | undefined>;
    }) => Promise<void>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

interface ReplayedSource extends InstagramProfileProviderCanarySource {
    sourceRunCount: 8;
    candidateCount: 15;
    uniqueCandidateCount: 15;
    publicCandidateCount: 15;
    incompleteCandidateCount: 15;
    unavailableCandidateCount: 0;
    primarySuccessCandidateCount: 0;
    criticalCandidateCount: 3;
    criticalUsernames: ReadonlySet<string>;
    sourceSlots: ReadonlyMap<string, ApifyCredentialSlot>;
    orderedSetHmac: string;
}

function safeError(code: string): Error {
    return new Error(code);
}

function decodeHmacKey(env: Record<string, string | undefined>): Buffer {
    const value = env[HMAC_SECRET_ENV]?.trim() ?? '';
    if (!BASE64_PATTERN.test(value) || value.length % 4 === 1) {
        throw safeError('PROFILE_PROVIDER_CANARY_HMAC_CONFIGURATION_INVALID');
    }
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64');
    if (decoded.length < 32
        || decoded.toString('base64').replace(/=+$/, '') !== normalized) {
        throw safeError('PROFILE_PROVIDER_CANARY_HMAC_CONFIGURATION_INVALID');
    }
    return decoded;
}

export function orderedProfileProviderCanaryHmac(
    usernames: readonly string[],
    env: Record<string, string | undefined> = process.env
): string {
    if (usernames.length !== 15) throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_INVALID');
    const canonical = usernames.map(username => username.trim().toLowerCase());
    if (canonical.some(username => username.length === 0)
        || new Set(canonical).size !== canonical.length) {
        throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_INVALID');
    }
    const hmac = createHmac('sha256', decodeHmacKey(env));
    hmac.update(ORDERED_SET_HMAC_DOMAIN, 'utf8');
    for (const username of canonical) {
        const bytes = Buffer.from(username, 'utf8');
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(bytes.length);
        hmac.update(length);
        hmac.update(bytes);
    }
    return hmac.digest('hex');
}

function fixedSourceValidationOptions(sourceRequestId: string) {
    return {
        sourceRequestId,
        criticalJobKey: CRITICAL_JOB_KEY,
        credentialSlot: 'primary' as const,
        confirmPaidApiCall: false,
        repeats: 0 as const,
        maximumRunChargeUsd: 0 as const,
        maximumTotalChargeUsd: 0 as const,
    };
}

function sourceContext(run: ProfileRepairCanarySourceBundle['runs'][number]): ProviderCallContext {
    return {
        logicalProvider: 'apify',
        actorId: run.actorId,
        credentialSlot: run.credentialSlot as ApifyCredentialSlot,
        maxChargeUsd: run.maxChargeUsd,
        resumeRunId: run.runId as string,
        recordUsage: () => undefined,
    };
}

async function defaultSourceOutcomes(
    usernames: readonly string[],
    context: ProviderCallContext,
    client: ProfileProviderCanaryRuntimeClient
): Promise<ProfileAttemptResult[]> {
    const provider = makeApifyProvider({
        client: client as ApifyClientLike,
        env: {},
    });
    if (!provider.getProfilesBatchOutcomes) {
        throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_CAPABILITY_INVALID');
    }
    return provider.getProfilesBatchOutcomes([...usernames], usernames.length, context);
}

export async function replayProfileProviderCanarySourceBundle(input: {
    source: ProfileRepairCanarySourceBundle;
    env: Record<string, string | undefined>;
    clientForSlot(slot: ApifyCredentialSlot): ProfileProviderCanaryRuntimeClient;
    getOutcomes: NonNullable<RuntimeOverrides['getSourceProfilesBatchOutcomes']>;
}): Promise<ReplayedSource> {
    const allInputs = new Set<string>();
    const incomplete: string[] = [];
    const incompleteSet = new Set<string>();
    const critical = new Set<string>();
    const sourceSlots = new Map<string, ApifyCredentialSlot>();

    for (const sourceRun of input.source.runs) {
        const slot = sourceRun.credentialSlot as ApifyCredentialSlot;
        const runId = sourceRun.runId as string;
        sourceSlots.set(runId, slot);
        const client = input.clientForSlot(slot);
        const record = await client.run(runId).keyValueStore().getRecord('INPUT');
        const usernames = parseProfileRepairCanarySourceInput(record);
        if (usernames.some(username => allInputs.has(username))) {
            throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_INPUT_INVALID');
        }
        usernames.forEach(username => allInputs.add(username));
        let results: ProfileAttemptResult[];
        try {
            results = validateProfileAttemptResults(
                usernames,
                'apify',
                await input.getOutcomes(usernames, sourceContext(sourceRun), client)
            );
        } catch {
            throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_OUTCOME_INVALID');
        }
        for (const result of results) {
            const outcome = result.outcome;
            if (outcome.status === 'failed' && outcome.failureCategory === 'incomplete') {
                if (incompleteSet.has(outcome.requestedUsername)) {
                    throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_OUTCOME_INVALID');
                }
                incompleteSet.add(outcome.requestedUsername);
                incomplete.push(outcome.requestedUsername);
                if (sourceRun.jobKey === CRITICAL_JOB_KEY) critical.add(outcome.requestedUsername);
            } else if (outcome.status === 'failed') {
                throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_OUTCOME_INVALID');
            }
        }
    }
    if (incomplete.length !== 15 || critical.size !== 3) {
        throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_OUTCOME_INVALID');
    }
    return Object.freeze({
        sourceRunIds: Object.freeze(input.source.runs.map(run => run.runId as string)),
        usernames: Object.freeze(incomplete),
        criticalIncompleteCount: 3,
        sourceRunCount: 8,
        candidateCount: 15,
        uniqueCandidateCount: 15,
        publicCandidateCount: 15,
        incompleteCandidateCount: 15,
        unavailableCandidateCount: 0,
        primarySuccessCandidateCount: 0,
        criticalCandidateCount: 3,
        criticalUsernames: critical,
        sourceSlots,
        orderedSetHmac: orderedProfileProviderCanaryHmac(incomplete, input.env),
    });
}

function outcomeCategory(result: ProfileAttemptResult): ProfileProviderCanaryOutcome {
    if (result.outcome.status === 'success') return 'success';
    if (result.outcome.status === 'unavailable') return 'unavailable';
    return result.outcome.failureCategory === 'incomplete' ? 'incomplete' : 'other_failure';
}

function storedEvidence(run: StoredProfileProviderCanaryRun): ProfileProviderCanaryRunEvidence | null {
    if (run.state !== 'succeeded' && run.state !== 'failed') return null;
    const outcomes: ProfileProviderCanaryOutcome[] = [
        ...Array(run.successCount ?? 0).fill('success' as const),
        ...Array(run.unavailableCount ?? 0).fill('unavailable' as const),
        ...Array(run.incompleteCount ?? 0).fill('incomplete' as const),
        ...Array(run.otherFailureCount ?? 0).fill('other_failure' as const),
    ];
    return {
        outcomes,
        criticalSuccessCount: run.criticalSuccessCount ?? 0,
        latencyMs: run.latencyMs ?? 0,
        buildMatched: run.buildVerified === true,
        restrictedAccess: run.restrictedAccessVerified,
    };
}

function mappedRun(run: StoredProfileProviderCanaryRun): InstagramProfileProviderCanaryRunRecord {
    const state = (() => {
        switch (run.state) {
            case 'starting': return 'reserved' as const;
            case 'ambiguous': return 'ambiguous' as const;
            case 'running': return 'running' as const;
            case 'succeeded':
            case 'failed': return 'terminal' as const;
            case 'verified_no_run': return 'ambiguous' as const;
        }
    })();
    return {
        repetition: run.repetition,
        state,
        runId: run.runId,
        runStartedAtMs: typeof run.runStartedAt === 'string'
            && Number.isFinite(Date.parse(run.runStartedAt))
            ? Date.parse(run.runStartedAt)
            : null,
        evidence: storedEvidence(run),
        terminalSucceeded: run.state === 'succeeded'
            ? true
            : run.state === 'failed' ? false : null,
        actualCostUsd: run.actualUsageUsd,
        costStatus: run.costStatus,
        cleanup: {
            keyValueStore: run.kvsCleanupState === 'verified_absent',
            dataset: run.datasetCleanupState === 'verified_absent',
            requestQueue: run.requestQueueCleanupState === 'verified_absent',
        },
        gatePassed: run.gatePassed,
    };
}

function storeStorage(storage: ProfileProviderCanaryStorage) {
    switch (storage) {
        case 'keyValueStore': return 'kvs' as const;
        case 'dataset': return 'dataset' as const;
        case 'requestQueue': return 'request_queue' as const;
    }
}

function terminalSnapshotStable(snapshot: {
    status?: unknown;
    usageTotalUsd?: unknown;
    finishedAt?: unknown;
}, now: number): number | null {
    if (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(String(snapshot.status))) {
        return null;
    }
    const finishedAt = snapshot.finishedAt instanceof Date
        ? snapshot.finishedAt.getTime()
        : typeof snapshot.finishedAt === 'string' ? Date.parse(snapshot.finishedAt) : Number.NaN;
    if (Number.isFinite(finishedAt) && finishedAt <= now - ACCOUNTING_STABILITY_MS
        && typeof snapshot.usageTotalUsd === 'number'
        && Number.isFinite(snapshot.usageTotalUsd)
        && snapshot.usageTotalUsd > PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD) {
        throw safeError('PROFILE_PROVIDER_CANARY_ACTUAL_COST_OUT_OF_BOUNDS');
    }
    if (!Number.isFinite(finishedAt) || finishedAt > now - ACCOUNTING_STABILITY_MS
        || typeof snapshot.usageTotalUsd !== 'number'
        || !Number.isFinite(snapshot.usageTotalUsd)
        || snapshot.usageTotalUsd < 0
        || snapshot.usageTotalUsd
            > PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD + Number.EPSILON) {
        return null;
    }
    return Number(snapshot.usageTotalUsd.toFixed(12));
}

function timestampMs(value: unknown): number | null {
    const parsed = value instanceof Date
        ? value.getTime()
        : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function terminalRunLatencyMs(
    snapshot: { startedAt?: unknown; finishedAt?: unknown } | undefined,
    durableRunStartedAtMs: number | null | undefined
): number {
    const actorStartedAtMs = timestampMs(snapshot?.startedAt);
    const finishedAtMs = timestampMs(snapshot?.finishedAt);
    const durableStartedAtMs = typeof durableRunStartedAtMs === 'number'
        && Number.isFinite(durableRunStartedAtMs)
        ? durableRunStartedAtMs
        : null;
    if (finishedAtMs === null
        || (actorStartedAtMs === null && durableStartedAtMs === null)
        || (actorStartedAtMs !== null && actorStartedAtMs > finishedAtMs)
        || (durableStartedAtMs !== null && durableStartedAtMs > finishedAtMs)) {
        return FAIL_CLOSED_LATENCY_MS;
    }
    const startedAtMs = Math.min(...[actorStartedAtMs, durableStartedAtMs]
        .filter((value): value is number => value !== null));
    return Math.min(
        FAIL_CLOSED_LATENCY_MS,
        Math.max(0, Math.trunc(finishedAtMs - startedAtMs))
    );
}

async function terminalResourcesRestricted(run: RuntimeRunClient): Promise<boolean> {
    for (const resource of [run.keyValueStore(), run.dataset(), run.requestQueue()]) {
        try {
            const metadata = await resource.get();
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
                || (metadata as Record<string, unknown>).generalAccess !== 'RESTRICTED') {
                return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

async function defaultCommandRunner(input: {
    file: string;
    args: readonly string[];
    env: Record<string, string | undefined>;
}): Promise<void> {
    await execFileAsync(input.file, [...input.args], {
        cwd: REPOSITORY_ROOT,
        env: input.env as NodeJS.ProcessEnv,
        maxBuffer: 1024 * 1024,
    });
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function priceFitsExactCanary(price: unknown): price is number {
    return typeof price === 'number' && Number.isFinite(price) && price > 0
        && price <= PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD
            / PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT;
}

function payPerEventPriceIsAllowed(events: unknown, accountTier: unknown): boolean {
    if (!isUnknownRecord(events) || Object.keys(events).length !== 1) return false;

    if (Object.hasOwn(events, 'profile-result')) {
        const profileResult = events['profile-result'];
        if (!isUnknownRecord(profileResult)
            || Object.hasOwn(profileResult, 'eventTieredPricingUsd')) return false;
        return priceFitsExactCanary(profileResult.eventPriceUsd);
    }

    if (!Object.hasOwn(events, 'result')
        || typeof accountTier !== 'string'
        || !APIFY_PRICING_TIERS.has(accountTier)) return false;
    const result = events.result;
    if (!isUnknownRecord(result)
        || result.isPrimaryEvent !== true
        || result.isOneTimeEvent !== false
        || Object.hasOwn(result, 'eventPriceUsd')) return false;
    const tiered = result.eventTieredPricingUsd;
    if (!isUnknownRecord(tiered)) return false;
    const tiers = Object.keys(tiered);
    if (tiers.length === 0
        || !tiers.every(tier => APIFY_PRICING_TIERS.has(tier))) return false;
    const prices = tiers.map(tier => {
        const entry = tiered[tier];
        return isUnknownRecord(entry) ? entry.tieredEventPriceUsd : undefined;
    });
    return Object.hasOwn(tiered, accountTier)
        && prices.every(priceFitsExactCanary)
        && priceFitsExactCanary(
            isUnknownRecord(tiered[accountTier])
                ? tiered[accountTier].tieredEventPriceUsd
                : undefined
        );
}

function currentPricingIsAllowed(
    value: unknown,
    nowMs: number,
    accountTier: unknown
): boolean {
    if (!Array.isArray(value) || value.length === 0) return false;
    const candidates = value.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const startedAt = (item as Record<string, unknown>).startedAt;
        const timestamp = startedAt instanceof Date
            ? startedAt.getTime()
            : typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
        return Number.isFinite(timestamp) && timestamp <= nowMs;
    }).sort((left, right) => Date.parse(String(right.startedAt)) - Date.parse(String(left.startedAt)));
    const current = candidates[0];
    if (!current) return false;
    if (current.pricingModel === 'PRICE_PER_DATASET_ITEM') {
        return priceFitsExactCanary(current.pricePerUnitUsd);
    }
    if (current.pricingModel !== 'PAY_PER_EVENT') return false;
    const minimum = current.minimalMaxTotalChargeUsd;
    const pricingPerEvent = current.pricingPerEvent;
    if (!pricingPerEvent || typeof pricingPerEvent !== 'object' || Array.isArray(pricingPerEvent)
        || typeof minimum !== 'number' || !Number.isFinite(minimum)
        || minimum < 0 || minimum > PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD) return false;
    const events = (pricingPerEvent as Record<string, unknown>).actorChargeEvents;
    return payPerEventPriceIsAllowed(events, accountTier);
}

export async function assertProfileProviderCanaryPaidReadiness(input: {
    env: Record<string, string | undefined>;
    client: ProfileProviderCanaryRuntimeClient;
    commandRunner: NonNullable<RuntimeOverrides['commandRunner']>;
    now?: () => number;
}): Promise<void> {
    const nowMs = (input.now ?? Date.now)();
    const accessVerifiedAt = Date.parse(
        input.env.PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS_VERIFIED_AT ?? ''
    );
    const accessAttestationAgeMs = nowMs - accessVerifiedAt;
    const checkEnv = {
        ...input.env,
        ANALYSIS_V2_RECOVERY_ENABLED: 'true',
    };
    if (!isAnalysisV2RecoveryAvailable(checkEnv)
        || input.env.PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS !== 'RESTRICTED'
        || input.env.PROFILE_PROVIDER_CANARY_SHARE_RUN_DATA_WITH_DEVELOPERS !== 'DISABLED'
        || !Number.isFinite(nowMs)
        || !Number.isFinite(accessVerifiedAt)
        || accessAttestationAgeMs < ACCOUNT_ACCESS_ATTESTATION_MIN_AGE_MS
        || accessAttestationAgeMs > ACCOUNT_ACCESS_ATTESTATION_MAX_AGE_MS) {
        throw safeError('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    }
    try {
        await input.commandRunner({
            file: '/bin/bash',
            args: [join(SCRIPT_DIRECTORY, 'deploy-analysis-v2-worker.sh'), '--check'],
            env: checkEnv,
        });
        await input.commandRunner({
            file: '/bin/bash',
            args: [join(SCRIPT_DIRECTORY, 'configure-analysis-v2-maintenance.sh'), '--check'],
            env: checkEnv,
        });
    } catch {
        throw safeError('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    }
    const actor = await input.client.actor(PROFILE_PROVIDER_CANARY_ACTOR.actorId).get();
    const user = await input.client.user('me').get();
    const taggedBuilds = actor?.taggedBuilds;
    const exactBuildAvailable = taggedBuilds !== null && typeof taggedBuilds === 'object'
        && !Array.isArray(taggedBuilds)
        && Object.values(taggedBuilds as Record<string, unknown>).some(value => (
            value !== null && typeof value === 'object' && !Array.isArray(value)
            && (value as Record<string, unknown>).buildNumber
                === PROFILE_PROVIDER_CANARY_ACTOR.build
        ));
    if (!actor || actor.isPublic !== true || actor.isDeprecated === true
        || actor.actorPermissionLevel !== 'LIMITED_PERMISSIONS'
        || !exactBuildAvailable
        || !currentPricingIsAllowed(actor.pricingInfos, nowMs, user.plan?.tier)) {
        throw safeError('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    }
    const limits = await input.client.user('me').limits();
    const maximum = limits?.limits?.maxConcurrentActorJobs;
    const active = limits?.current?.activeActorJobCount;
    const monthlyMaximum = limits?.limits?.maxMonthlyUsageUsd;
    const monthlyUsed = limits?.current?.monthlyUsageUsd;
    const credits = user.plan?.monthlyUsageCreditsUsd;
    if (!Number.isInteger(maximum) || !Number.isInteger(active)
        || Number(active) !== 0 || Number(maximum) <= Number(active)
        || typeof monthlyMaximum !== 'number' || !Number.isFinite(monthlyMaximum)
        || typeof monthlyUsed !== 'number' || !Number.isFinite(monthlyUsed)
        || monthlyUsed < 0
        || monthlyMaximum - monthlyUsed < PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD
        || typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0
        || (credits - monthlyUsed < PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD
            && user.isPaying !== true)) {
        throw safeError('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    }
}

function cleanupClientForRuns(
    sourceSlots: ReadonlyMap<string, ApifyCredentialSlot>,
    clientForSlot: (slot: ApifyCredentialSlot) => ProfileProviderCanaryRuntimeClient
): ProfileProviderCanaryApifyClient {
    return {
        run(runId: string) {
            const slot = sourceSlots.get(runId) ?? 'primary';
            return clientForSlot(slot).run(runId);
        },
    };
}

function runtimeStorage(
    run: RuntimeRunClient,
    storage: 'kvs' | 'dataset' | 'request_queue'
): RuntimeStorageClient {
    switch (storage) {
        case 'kvs': return run.keyValueStore();
        case 'dataset': return run.dataset();
        case 'request_queue': return run.requestQueue();
    }
}

async function deleteAndVerifyRuntimeStorage(storage: RuntimeStorageClient): Promise<void> {
    try {
        await storage.delete();
    } catch {
        // A missing resource is accepted only after the authenticated GET below confirms it.
    }
    let remaining: unknown;
    try {
        remaining = await storage.get();
    } catch {
        throw safeError('PROFILE_PROVIDER_CANARY_STORAGE_CLEANUP_UNVERIFIED');
    }
    if (remaining !== undefined) {
        throw safeError('PROFILE_PROVIDER_CANARY_STORAGE_CLEANUP_UNVERIFIED');
    }
}

export function createInstagramProfileProviderCanaryRuntimeDependencies(
    overrides: RuntimeOverrides = {}
): InstagramProfileProviderCanaryDependencies {
    const env = overrides.env ?? process.env;
    const store = overrides.store ?? profileProviderCanaryRunStore;
    const now = overrides.now ?? (() => Date.now());
    const sleep = overrides.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const clientForSlot = overrides.clientForSlot
        ?? (slot => getApifyClient(env, slot) as ProfileProviderCanaryRuntimeClient);
    const getOutcomes = overrides.getSourceProfilesBatchOutcomes ?? defaultSourceOutcomes;
    const replacement = overrides.runReplacement ?? runReplacementProfileDetails;
    const readiness = overrides.paidReadiness ?? assertProfileProviderCanaryPaidReadiness;
    const commandRunner = overrides.commandRunner ?? defaultCommandRunner;
    let replayed: ReplayedSource | null = null;
    let cleanupClaimToken: string | null = null;

    const requireStored = async (repetition: 1 | 2) => {
        const stored = await store.loadRun({
            sourceRequestId: replayed?.sourceRunIds ? currentSourceRequestId : '',
            repetition,
        });
        if (!stored) throw safeError('PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND');
        return stored;
    };
    let currentSourceRequestId = '';

    return {
        async resumeTerminalization({ sourceRequestId }) {
            const experiment = await store.loadExperiment({ sourceRequestId });
            if (!experiment || !['terminalizing', 'experiment_terminal']
                .includes(experiment.state)) return null;

            if (experiment.state === 'terminalizing') {
                const claim = experiment.cleanupClaimToken;
                if (!claim) {
                    throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
                }
                const inventory = await store.loadCleanupInventory({
                    sourceRequestId,
                    cleanupClaimToken: claim,
                });
                for (const storage of ['kvs', 'dataset', 'request_queue'] as const) {
                    for (const sourceRun of inventory.sourceRuns) {
                        await deleteAndVerifyRuntimeStorage(runtimeStorage(
                            clientForSlot(sourceRun.credentialSlot).run(sourceRun.runId),
                            storage
                        ));
                    }
                    await store.markSourceStorageClean({
                        sourceRequestId,
                        cleanupClaimToken: claim,
                        storage,
                    });
                }
                for (const canaryRun of inventory.canaryRuns) {
                    for (const storage of ['kvs', 'dataset', 'request_queue'] as const) {
                        await deleteAndVerifyRuntimeStorage(runtimeStorage(
                            clientForSlot(canaryRun.credentialSlot).run(canaryRun.runId),
                            storage
                        ));
                        await store.markRunStorageClean({
                            sourceRequestId,
                            repetition: canaryRun.repetition,
                            reservationToken: canaryRun.reservationToken,
                            runId: canaryRun.runId,
                            storage,
                        });
                    }
                }
                const completed = await store.completeExperimentCleanup({
                    sourceRequestId,
                    cleanupClaimToken: claim,
                });
                if (completed.state !== 'experiment_terminal'
                    || completed.orderedSetHmac !== null) {
                    throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_INCOMPLETE');
                }
            }

            const runs: InstagramProfileProviderCanaryRunRecord[] = [];
            for (const repetition of [1, 2] as const) {
                const run = await store.loadRun({ sourceRequestId, repetition });
                if (run) runs.push(mappedRun(run));
            }
            return { runs };
        },
        async loadSource({ sourceRequestId }) {
            const operator = requireProfileRepairCanaryOperatorIdentity(env);
            decodeHmacKey(env);
            const raw = await store.loadSource({
                sourceRequestId,
                ownerId: operator.ownerId,
                ownerEmail: operator.ownerEmail,
            });
            const source = validateProfileRepairCanarySource(
                raw,
                fixedSourceValidationOptions(sourceRequestId),
                operator.ownerId,
                operator.ownerEmail
            );
            const next = await replayProfileProviderCanarySourceBundle({
                source,
                env,
                clientForSlot,
                getOutcomes,
            });
            currentSourceRequestId = sourceRequestId;
            replayed = next;
            return next;
        },
        async assertPaidReadiness() {
            await readiness({ env, client: clientForSlot('primary'), commandRunner, now });
        },
        async loadRun(repetition) {
            if (!currentSourceRequestId) throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_INVALID');
            const run = await store.loadRun({ sourceRequestId: currentSourceRequestId, repetition });
            return run ? mappedRun(run) : null;
        },
        async reserveRun({ sourceRequestId, repetition }) {
            if (!replayed || sourceRequestId !== currentSourceRequestId) {
                throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_INVALID');
            }
            const reserved = await store.reserve({
                sourceRequestId,
                repetition,
                sourceRunCount: replayed.sourceRunCount,
                candidateCount: replayed.candidateCount,
                uniqueCandidateCount: replayed.uniqueCandidateCount,
                publicCandidateCount: replayed.publicCandidateCount,
                incompleteCandidateCount: replayed.incompleteCandidateCount,
                unavailableCandidateCount: replayed.unavailableCandidateCount,
                primarySuccessCandidateCount: replayed.primarySuccessCandidateCount,
                criticalCandidateCount: replayed.criticalCandidateCount,
                orderedSetHmac: replayed.orderedSetHmac,
                restrictedAccessVerified: true,
            });
            return { created: reserved.created, run: mappedRun(reserved.run) };
        },
        async checkpointStarted({ repetition, runId }) {
            const stored = await requireStored(repetition);
            return mappedRun(await store.checkpointStarted({
                sourceRequestId: currentSourceRequestId,
                repetition,
                reservationToken: stored.reservationToken,
                runId,
            }));
        },
        async markAmbiguous({ repetition }) {
            const stored = await requireStored(repetition);
            return mappedRun(await store.markAmbiguous({
                sourceRequestId: currentSourceRequestId,
                repetition,
                reservationToken: stored.reservationToken,
            }));
        },
        async terminalize({ repetition, runId, evidence }) {
            const stored = await requireStored(repetition);
            const count = (outcome: ProfileProviderCanaryOutcome) =>
                evidence.outcomes.filter(value => value === outcome).length;
            return mappedRun(await store.terminalize({
                sourceRequestId: currentSourceRequestId,
                repetition,
                reservationToken: stored.reservationToken,
                runId,
                terminalCount: 15,
                successCount: count('success'),
                unavailableCount: count('unavailable'),
                incompleteCount: count('incomplete'),
                otherFailureCount: count('other_failure'),
                criticalSuccessCount: evidence.criticalSuccessCount,
                latencyMs: evidence.latencyMs,
                buildVerified: evidence.buildMatched,
                restrictedAccessVerified: evidence.restrictedAccess,
            }));
        },
        async reconcileActualCost({ repetition, actualCostUsd }) {
            const stored = await requireStored(repetition);
            if (!stored.runId) throw safeError('PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT');
            return mappedRun(await store.reconcileUsage({
                sourceRequestId: currentSourceRequestId,
                repetition,
                reservationToken: stored.reservationToken,
                runId: stored.runId,
                actualUsageUsd: actualCostUsd,
            }));
        },
        async markStorageCleaned({ repetition, storage }) {
            const stored = await requireStored(repetition);
            if (!stored.runId) throw safeError('PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT');
            return mappedRun(await store.markRunStorageClean({
                sourceRequestId: currentSourceRequestId,
                repetition,
                reservationToken: stored.reservationToken,
                runId: stored.runId,
                storage: storeStorage(storage),
            }));
        },
        async beginTerminalization({ sourceRequestId, status }) {
            const experiment = await store.beginTerminalization({
                sourceRequestId,
                reason: status === 'completed' ? 'completed' : 'strict_failure',
            });
            if (!experiment.cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            cleanupClaimToken = experiment.cleanupClaimToken;
        },
        async markSourceStorageCleaned({ sourceRequestId, storage }) {
            if (!cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            await store.markSourceStorageClean({
                sourceRequestId,
                cleanupClaimToken,
                storage: storeStorage(storage),
            });
        },
        async markExperimentTerminal({ sourceRequestId }) {
            if (!cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            const completed = await store.completeExperimentCleanup({
                sourceRequestId,
                cleanupClaimToken,
            });
            if (completed.state !== 'experiment_terminal' || completed.orderedSetHmac !== null) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_INCOMPLETE');
            }
        },
        async executeRun({
            usernames,
            resumeRunId,
            durableRunStartedAtMs,
            maximumRunChargeUsd,
            onRunStarted,
        }) {
            if (!replayed) throw safeError('PROFILE_PROVIDER_CANARY_SOURCE_INVALID');
            let confirmedRunId = resumeRunId;
            let durablyCheckpointed = Boolean(resumeRunId);
            let durableStartedAtMs = durableRunStartedAtMs ?? null;
            const client = clientForSlot('primary');
            let results: ProfileAttemptResult[];
            try {
                results = await replacement({
                    client,
                    usernames,
                    credentialSlot: 'primary',
                    maxTotalChargeUsd: maximumRunChargeUsd,
                    context: {
                        logicalProvider: 'apify',
                        actorId: PROFILE_PROVIDER_CANARY_ACTOR.actorId,
                        credentialSlot: 'primary',
                        maxChargeUsd: maximumRunChargeUsd,
                        ...(resumeRunId ? { resumeRunId } : {}),
                        onRunStarted: async runId => {
                            confirmedRunId = runId;
                            const checkpoint = await onRunStarted(runId);
                            durableStartedAtMs = checkpoint.runStartedAtMs;
                            durablyCheckpointed = true;
                        },
                        recordUsage: () => undefined,
                    },
                });
            } catch {
                if (!confirmedRunId || !durablyCheckpointed) {
                    throw safeError('PROFILE_PROVIDER_CANARY_RUN_EXECUTION_INTERRUPTED');
                }
                const failedSnapshot = await client.run(confirmedRunId).get();
                if (!failedSnapshot || !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']
                    .includes(String(failedSnapshot.status))) {
                    throw safeError('PROFILE_PROVIDER_CANARY_RUN_EXECUTION_INTERRUPTED');
                }
                return {
                    outcomes: Array.from({ length: 15 }, () => 'other_failure' as const),
                    criticalSuccessCount: 0,
                    latencyMs: terminalRunLatencyMs(failedSnapshot, durableStartedAtMs),
                    buildMatched:
                        failedSnapshot.buildNumber === PROFILE_PROVIDER_CANARY_ACTOR.build,
                    restrictedAccess: failedSnapshot.generalAccess === 'RESTRICTED'
                        && await terminalResourcesRestricted(client.run(confirmedRunId)),
                };
            }
            if (!confirmedRunId) throw safeError('PROFILE_PROVIDER_CANARY_RUN_ID_MISSING');
            const snapshot = await client.run(confirmedRunId).get();
            const resultByUsername = new Map(results.map(result => [
                result.outcome.requestedUsername,
                result,
            ]));
            return {
                outcomes: usernames.map(username => {
                    const result = resultByUsername.get(username.toLowerCase());
                    return result ? outcomeCategory(result) : 'other_failure';
                }),
                criticalSuccessCount: results.filter(result => (
                    result.outcome.status === 'success'
                    && replayed?.criticalUsernames.has(result.outcome.requestedUsername)
                )).length,
                latencyMs: terminalRunLatencyMs(snapshot, durableStartedAtMs),
                buildMatched: snapshot?.buildNumber === PROFILE_PROVIDER_CANARY_ACTOR.build,
                restrictedAccess: snapshot?.generalAccess === 'RESTRICTED'
                    && await terminalResourcesRestricted(client.run(confirmedRunId)),
            };
        },
        async getStableActualCost(runId) {
            const client = clientForSlot('primary');
            for (let poll = 0; poll < ACCOUNTING_MAX_POLLS; poll += 1) {
                const snapshot = await client.run(runId).get();
                if (!snapshot) return null;
                const actual = terminalSnapshotStable(snapshot, now());
                if (actual !== null) return actual;
                if (poll < ACCOUNTING_MAX_POLLS - 1) await sleep(ACCOUNTING_POLL_MS);
            }
            return null;
        },
        getApifyClient() {
            return cleanupClientForRuns(replayed?.sourceSlots ?? new Map(), clientForSlot);
        },
        writeStdout: value => process.stdout.write(value),
    };
}

interface FinalizerRuntimeState {
    sourceSlots: Map<string, ApifyCredentialSlot>;
    canaryByRepetition: Map<1 | 2, StoredProfileProviderCanaryRun>;
    cleanupClaimToken: string | null;
    sourceRequestId: string;
}

export function createFinalizeProfileProviderCanaryRuntimeDependencies(
    overrides: Pick<RuntimeOverrides, 'env' | 'store' | 'clientForSlot'> = {}
): FinalizeProfileProviderCanaryDependencies {
    const env = overrides.env ?? process.env;
    const store = overrides.store ?? profileProviderCanaryRunStore;
    const clientForSlot = overrides.clientForSlot
        ?? (slot => getApifyClient(env, slot) as ProfileProviderCanaryRuntimeClient);
    const state: FinalizerRuntimeState = {
        sourceSlots: new Map(),
        canaryByRepetition: new Map(),
        cleanupClaimToken: null,
        sourceRequestId: '',
    };
    return {
        async resumeFinalization({ sourceRequestId }) {
            const experiment = await store.loadExperiment({ sourceRequestId });
            if (!experiment || !['terminalizing', 'experiment_terminal']
                .includes(experiment.state)) return null;
            if (!experiment.terminalReason) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            if (experiment.state === 'experiment_terminal') {
                let canaryRunCount = 0;
                for (const repetition of [1, 2] as const) {
                    const run = await store.loadRun({ sourceRequestId, repetition });
                    if (run?.runId) canaryRunCount += 1;
                }
                return {
                    state: 'experiment_terminal',
                    terminalReason: experiment.terminalReason,
                    canaryRunCount,
                };
            }
            if (!experiment.cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            const inventory = await store.loadCleanupInventory({
                sourceRequestId,
                cleanupClaimToken: experiment.cleanupClaimToken,
            });
            state.sourceRequestId = sourceRequestId;
            state.cleanupClaimToken = experiment.cleanupClaimToken;
            state.sourceSlots = new Map(inventory.sourceRuns.map(run => [
                run.runId,
                run.credentialSlot,
            ]));
            const canaryRuns: FinalizeProfileProviderCanaryContext['canaryRuns'] = [];
            for (const inventoryRun of inventory.canaryRuns) {
                const stored = await store.loadRun({
                    sourceRequestId,
                    repetition: inventoryRun.repetition,
                });
                if (!stored?.runId || stored.runId !== inventoryRun.runId) {
                    throw safeError('FINALIZATION_CONTEXT_INVALID');
                }
                state.canaryByRepetition.set(inventoryRun.repetition, stored);
                canaryRuns.push({
                    repetition: inventoryRun.repetition,
                    runId: inventoryRun.runId,
                    actualCostSettled: stored.costStatus === 'actual'
                        && stored.actualUsageUsd !== null,
                    cleanup: {
                        keyValueStore: stored.kvsCleanupState === 'verified_absent',
                        dataset: stored.datasetCleanupState === 'verified_absent',
                        requestQueue: stored.requestQueueCleanupState === 'verified_absent',
                    },
                });
            }
            return {
                state: 'terminalizing',
                terminalReason: experiment.terminalReason,
                context: {
                    canaryRuns,
                    sourceRunIds: inventory.sourceRuns.map(run => run.runId),
                    sourceCleanup: {
                        keyValueStore: experiment.sourceKvsCleanupState === 'verified_absent',
                        dataset: experiment.sourceDatasetCleanupState === 'verified_absent',
                        requestQueue:
                            experiment.sourceRequestQueueCleanupState === 'verified_absent',
                    },
                },
            };
        },
        async loadFinalizationContext({ sourceRequestId }) {
            const operator = requireProfileRepairCanaryOperatorIdentity(env);
            decodeHmacKey(env);
            const raw = await store.loadSource({
                sourceRequestId,
                ownerId: operator.ownerId,
                ownerEmail: operator.ownerEmail,
            });
            const source = validateProfileRepairCanarySource(
                raw,
                fixedSourceValidationOptions(sourceRequestId),
                operator.ownerId,
                operator.ownerEmail
            );
            state.sourceRequestId = sourceRequestId;
            state.sourceSlots = new Map(source.runs.map(run => [
                run.runId as string,
                run.credentialSlot as ApifyCredentialSlot,
            ]));
            const runs: FinalizeProfileProviderCanaryContext['canaryRuns'] = [];
            for (const repetition of [1, 2] as const) {
                const stored = await store.loadRun({ sourceRequestId, repetition });
                if (!stored) continue;
                state.canaryByRepetition.set(repetition, stored);
                if (!stored.runId) throw safeError('FINALIZATION_CONTEXT_INVALID');
                runs.push({
                    repetition,
                    runId: stored.runId,
                    actualCostSettled: stored.costStatus === 'actual'
                        && stored.actualUsageUsd !== null,
                    cleanup: {
                        keyValueStore: stored.kvsCleanupState === 'verified_absent',
                        dataset: stored.datasetCleanupState === 'verified_absent',
                        requestQueue: stored.requestQueueCleanupState === 'verified_absent',
                    },
                });
            }
            return {
                canaryRuns: runs,
                sourceRunIds: source.runs.map(run => run.runId as string),
                sourceCleanup: {
                    keyValueStore: false,
                    dataset: false,
                    requestQueue: false,
                },
            };
        },
        async beginTerminalization({ sourceRequestId }) {
            const experiment = await store.beginTerminalization({
                sourceRequestId,
                reason: 'aborted_by_operator',
            });
            if (!experiment.cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            state.cleanupClaimToken = experiment.cleanupClaimToken;
        },
        getApifyClient() {
            const slots = new Map(state.sourceSlots);
            for (const run of state.canaryByRepetition.values()) {
                if (run.runId) slots.set(run.runId, run.credentialSlot);
            }
            return cleanupClientForRuns(slots, clientForSlot);
        },
        async markCanaryStorageCleaned({ sourceRequestId, repetition, storage }) {
            const run = state.canaryByRepetition.get(repetition);
            if (!run?.runId) throw safeError('FINALIZATION_CONTEXT_INVALID');
            const updated = await store.markRunStorageClean({
                sourceRequestId,
                repetition,
                reservationToken: run.reservationToken,
                runId: run.runId,
                storage: storeStorage(storage),
            });
            state.canaryByRepetition.set(repetition, updated);
        },
        async markSourceStorageCleaned({ sourceRequestId, storage }) {
            if (!state.cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            await store.markSourceStorageClean({
                sourceRequestId,
                cleanupClaimToken: state.cleanupClaimToken,
                storage: storeStorage(storage),
            });
        },
        async markExperimentTerminal({ sourceRequestId }) {
            if (!state.cleanupClaimToken) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
            }
            const completed = await store.completeExperimentCleanup({
                sourceRequestId,
                cleanupClaimToken: state.cleanupClaimToken,
            });
            if (completed.state !== 'experiment_terminal' || completed.orderedSetHmac !== null) {
                throw safeError('PROFILE_PROVIDER_CANARY_CLEANUP_INCOMPLETE');
            }
        },
        writeStdout: value => process.stdout.write(value),
    };
}
