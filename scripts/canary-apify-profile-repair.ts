import { pathToFileURL } from 'node:url';
import { supabaseAdmin } from '../lib/supabase/admin';
import {
    PROFILE_REPAIR_CANARY_ACTOR_ID,
    PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES,
    profileRepairCanaryRunStore,
    type ProfileRepairCanaryRepetition,
    type ProfileRepairCanaryRunStore,
    type StoredProfileRepairCanaryRun,
} from '../lib/services/analysis/profile-repair-canary-run-store';
import {
    type ApifyCredentialSlot,
    type ProfileAttemptResult,
    type ProviderCallContext,
} from '../lib/services/instagram/providers/types';
import { validateProfileAttemptResults } from '../lib/services/instagram/providers/profile-attempt';
import { makeApifyProvider } from '../lib/services/instagram/providers/apify';
import {
    getApifyClient,
    selectApifyApiToken,
    type ApifyClientLike,
} from '../lib/services/instagram/providers/apify-relationship';
import {
    PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT,
    PROFILE_REPAIR_CANARY_MAX_RUN_USD,
    PROFILE_REPAIR_CANARY_MAX_TOTAL_USD,
    type ProfileRepairCanaryOptions,
    parseProfileRepairCanaryArgs,
    sanitizeProfileRepairCanaryResult,
    type SafeProfileRepairCanaryReport,
    type SafeProfileRepairCanaryRunReport,
} from './canary-apify-profile-repair-options';
import {
    PROFILE_REPAIR_CANARY_SOURCE_RUN_COUNT,
    countProfileRepairCanaryResults,
    parseProfileRepairCanarySourceInput,
    profileRepairCanaryReportCost,
    requireProfileRepairCanaryOperatorIdentity,
    validateProfileRepairCanarySource,
    type ProfileRepairCanarySourceBundle,
} from './canary-apify-profile-repair-validation';
export type {
    ProfileRepairCanarySourceBundle,
    ProfileRepairCanarySourceRequest,
    ProfileRepairCanarySourceRun,
} from './canary-apify-profile-repair-validation';

const ACCOUNTING_RECONCILIATION_LIMIT_MS = 180_000;
const ACCOUNTING_POLL_INTERVAL_MS = 5_000;
const ACCOUNTING_MAX_POLLS = 37;
const ACCOUNTING_FINISH_STABILITY_MS = 30_000;

interface ProfileRepairCanaryRunClient {
    keyValueStore(): {
        getRecord(key: string): Promise<unknown>;
    };
    get(): Promise<{
        status?: unknown;
        usageTotalUsd?: unknown;
        finishedAt?: unknown;
    } | undefined>;
}

interface ProfileRepairCanaryAccountingSnapshot {
    status?: unknown;
    usageTotalUsd?: unknown;
    finishedAt?: unknown;
}

interface ProfileRepairCanaryAccountingLookup {
    credentialSlot: ApifyCredentialSlot;
    signal: AbortSignal;
}

export interface ProfileRepairCanaryApifyClient {
    actor(actorId: string): unknown;
    dataset(datasetId: string): unknown;
    run(runId: string): ProfileRepairCanaryRunClient;
}

interface LoadSourceInput {
    sourceRequestId: string;
    ownerId: string;
    ownerEmail: string;
    credentialSlot: ApifyCredentialSlot;
}

export interface ProfileRepairCanaryDependencies {
    env: Record<string, string | undefined>;
    loadSource(input: LoadSourceInput): Promise<unknown>;
    getClient(slot: ApifyCredentialSlot): ProfileRepairCanaryApifyClient;
    getAccountingSnapshot(
        runId: string,
        input: ProfileRepairCanaryAccountingLookup
    ): Promise<ProfileRepairCanaryAccountingSnapshot | undefined>;
    getProfilesBatchOutcomes(
        usernames: readonly string[],
        context: ProviderCallContext,
        client: ProfileRepairCanaryApifyClient
    ): Promise<ProfileAttemptResult[]>;
    runStore: ProfileRepairCanaryRunStore;
    now(): number;
    sleep(ms: number): Promise<void>;
    writeStdout?(value: string): void;
}

interface ReplayedSource {
    usernames: readonly string[];
    criticalUsernames: ReadonlySet<string>;
    criticalIncompleteCount: number;
}

function safeError(code: string): Error {
    return new Error(code);
}

function callContext(input: {
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: number;
    resumeRunId?: string;
}): ProviderCallContext {
    return {
        logicalProvider: 'apify',
        actorId: PROFILE_REPAIR_CANARY_ACTOR_ID,
        credentialSlot: input.credentialSlot,
        maxChargeUsd: input.maxChargeUsd,
        ...(input.resumeRunId ? { resumeRunId: input.resumeRunId } : {}),
        recordUsage: () => undefined,
    };
}

async function replaySource(
    source: ProfileRepairCanarySourceBundle,
    options: ProfileRepairCanaryOptions,
    client: ProfileRepairCanaryApifyClient,
    dependencies: ProfileRepairCanaryDependencies
): Promise<ReplayedSource> {
    const allInputUsernames = new Set<string>();
    const incompleteUsernames: string[] = [];
    const incompleteSet = new Set<string>();
    const criticalUsernames = new Set<string>();

    for (const sourceRun of source.runs) {
        const inputRecord = await client
            .run(sourceRun.runId as string)
            .keyValueStore()
            .getRecord('INPUT');
        const usernames = parseProfileRepairCanarySourceInput(inputRecord);
        for (const username of usernames) {
            if (allInputUsernames.has(username)) {
                throw safeError('PROFILE_REPAIR_CANARY_SOURCE_INPUT_INVALID');
            }
            allInputUsernames.add(username);
        }
        let results: ProfileAttemptResult[];
        try {
            results = validateProfileAttemptResults(
                usernames,
                'apify',
                await dependencies.getProfilesBatchOutcomes(
                    usernames,
                    callContext({
                        credentialSlot: options.credentialSlot,
                        maxChargeUsd: sourceRun.maxChargeUsd,
                        resumeRunId: sourceRun.runId as string,
                    }),
                    client
                )
            );
        } catch {
            throw safeError('PROFILE_REPAIR_CANARY_SOURCE_OUTCOME_INVALID');
        }
        for (const result of results) {
            const outcome = result.outcome;
            if (outcome.status === 'failed' && outcome.failureCategory !== 'incomplete') {
                throw safeError('PROFILE_REPAIR_CANARY_SOURCE_OUTCOME_INVALID');
            }
            if (outcome.status === 'failed') {
                if (incompleteSet.has(outcome.requestedUsername)) {
                    throw safeError('PROFILE_REPAIR_CANARY_SOURCE_OUTCOME_INVALID');
                }
                incompleteSet.add(outcome.requestedUsername);
                incompleteUsernames.push(outcome.requestedUsername);
                if (sourceRun.jobKey === options.criticalJobKey) {
                    criticalUsernames.add(outcome.requestedUsername);
                }
            }
        }
    }

    if (
        incompleteUsernames.length !== PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
        || criticalUsernames.size < 1
    ) {
        throw safeError('PROFILE_REPAIR_CANARY_SOURCE_OUTCOME_INVALID');
    }
    return Object.freeze({
        usernames: Object.freeze(incompleteUsernames),
        criticalUsernames,
        criticalIncompleteCount: criticalUsernames.size,
    });
}

function validateProviderIdentity(
    value: {
        logicalProvider: 'apify' | 'coderx';
        actorId: string;
        credentialSlot: ApifyCredentialSlot;
        maxChargeUsd: number;
    },
    slot: ApifyCredentialSlot
): void {
    if (
        value.logicalProvider !== 'apify'
        || value.actorId !== PROFILE_REPAIR_CANARY_ACTOR_ID
        || value.credentialSlot !== slot
        || value.maxChargeUsd !== PROFILE_REPAIR_CANARY_MAX_RUN_USD
    ) {
        throw safeError('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
    }
}

function pendingReport(run: StoredProfileRepairCanaryRun): SafeProfileRepairCanaryRunReport {
    if (run.state === 'ambiguous') {
        return {
            repetition: run.repetition,
            lifecycle_status: 'ambiguous',
            terminal_count: 0,
            success_count: 0,
            unavailable_count: 0,
            incomplete_count: 0,
            other_failure_count: 0,
            latency_ms: 0,
            actual_cost_usd: null,
            cost_status: 'unknown',
            gate_passed: false,
        };
    }
    return {
        repetition: run.repetition,
        lifecycle_status: 'not_started',
        terminal_count: 0,
        success_count: 0,
        unavailable_count: 0,
        incomplete_count: 0,
        other_failure_count: 0,
        latency_ms: 0,
        actual_cost_usd: null,
        cost_status: 'conservative',
        gate_passed: false,
    };
}

function terminalReport(run: StoredProfileRepairCanaryRun): SafeProfileRepairCanaryRunReport {
    if (run.state !== 'succeeded' && run.state !== 'failed') return pendingReport(run);
    return {
        repetition: run.repetition,
        lifecycle_status: run.state,
        terminal_count: run.terminalCount as number,
        success_count: run.successCount as number,
        unavailable_count: run.unavailableCount as number,
        incomplete_count: run.incompleteCount as number,
        other_failure_count: run.otherFailureCount as number,
        latency_ms: run.latencyMs as number,
        actual_cost_usd: run.actualUsageUsd,
        cost_status: run.costStatus,
        gate_passed: Boolean(run.gatePassed && run.costStatus === 'actual'),
    };
}

function isPendingLifecycleError(error: unknown): boolean {
    return error instanceof Error
        && (
            error.message.startsWith('SCRAPING_RUN_PENDING_ERROR:')
            || error.message.startsWith('SCRAPING_DATASET_TRANSIENT_ERROR:')
            || error.message.startsWith('SCRAPING_INVOCATION_DEADLINE_ERROR')
        );
}

function stableProviderFinish(value: unknown, nowMs: number): boolean {
    const finishedAtMs = value instanceof Date
        ? value.getTime()
        : typeof value === 'string'
            ? Date.parse(value)
            : Number.NaN;
    return Number.isFinite(finishedAtMs)
        && finishedAtMs <= nowMs - ACCOUNTING_FINISH_STABILITY_MS;
}

async function accountingSnapshotWithinDeadline(
    run: StoredProfileRepairCanaryRun,
    remainingMs: number,
    dependencies: ProfileRepairCanaryDependencies
): Promise<ProfileRepairCanaryAccountingSnapshot | undefined> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>(resolve => {
        timeout = setTimeout(() => {
            controller.abort();
            resolve(undefined);
        }, remainingMs);
    });
    const lookup = dependencies.getAccountingSnapshot(run.runId as string, {
        credentialSlot: run.credentialSlot,
        signal: controller.signal,
    }).catch(() => undefined);
    try {
        return await Promise.race([lookup, deadline]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

async function reconcileUsage(
    run: StoredProfileRepairCanaryRun,
    dependencies: ProfileRepairCanaryDependencies
): Promise<StoredProfileRepairCanaryRun> {
    if (
        run.actualUsageUsd !== null
        || run.runId === null
        || (run.state !== 'succeeded' && run.state !== 'failed')
    ) {
        return run;
    }
    const startedAt = dependencies.now();
    const deadline = startedAt + ACCOUNTING_RECONCILIATION_LIMIT_MS;
    for (let poll = 0; poll < ACCOUNTING_MAX_POLLS; poll++) {
        const beforeLookupRemaining = deadline - dependencies.now();
        if (beforeLookupRemaining <= 0) break;
        const snapshot = await accountingSnapshotWithinDeadline(
            run,
            beforeLookupRemaining,
            dependencies
        );
        const terminalStatus = snapshot?.status;
        const actualUsageUsd = snapshot?.usageTotalUsd;
        if (
            ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(String(terminalStatus))
            && stableProviderFinish(snapshot?.finishedAt, dependencies.now())
            && typeof actualUsageUsd === 'number'
            && Number.isFinite(actualUsageUsd)
            && actualUsageUsd >= 0
            && actualUsageUsd <= PROFILE_REPAIR_CANARY_MAX_RUN_USD + Number.EPSILON
        ) {
            return dependencies.runStore.reconcileUsage({
                sourceRequestId: run.sourceRequestId,
                repetition: run.repetition,
                reservationToken: run.reservationToken,
                runId: run.runId,
                actualUsageUsd: Number(actualUsageUsd.toFixed(12)),
            });
        }
        const remaining = deadline - dependencies.now();
        if (remaining <= 0 || poll === ACCOUNTING_MAX_POLLS - 1) break;
        await dependencies.sleep(Math.min(ACCOUNTING_POLL_INTERVAL_MS, remaining));
    }
    return run;
}

async function executeRepetition(
    repetition: ProfileRepairCanaryRepetition,
    replay: ReplayedSource,
    options: ProfileRepairCanaryOptions,
    client: ProfileRepairCanaryApifyClient,
    dependencies: ProfileRepairCanaryDependencies
): Promise<StoredProfileRepairCanaryRun> {
    let run = await dependencies.runStore.load({
        sourceRequestId: options.sourceRequestId,
        repetition,
    });
    let created = false;
    if (run === null) {
        const reservation = await dependencies.runStore.reserve({
            sourceRequestId: options.sourceRequestId,
            repetition,
            credentialSlot: options.credentialSlot,
        });
        run = reservation.run;
        created = reservation.created;
    }
    if (
        run.sourceRequestId !== options.sourceRequestId
        || run.repetition !== repetition
        || run.actorId !== PROFILE_REPAIR_CANARY_ACTOR_ID
        || run.credentialSlot !== options.credentialSlot
        || run.requestedCount !== PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
        || run.maxChargeUsd !== PROFILE_REPAIR_CANARY_MAX_RUN_USD
    ) {
        throw safeError('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
    }
    if (run.state === 'starting' && !created) {
        return dependencies.runStore.markAmbiguous({
            sourceRequestId: run.sourceRequestId,
            repetition,
            reservationToken: run.reservationToken,
        });
    }
    if (run.state === 'ambiguous') return run;
    if (run.state === 'succeeded' || run.state === 'failed') {
        return reconcileUsage(run, dependencies);
    }

    const attemptStartedAt = dependencies.now();
    const durableStartedAt = run.runStartedAt === null
        ? Number.NaN
        : Date.parse(run.runStartedAt);
    const startedAt = Number.isFinite(durableStartedAt)
        ? Math.min(attemptStartedAt, durableStartedAt)
        : attemptStartedAt;
    let checkpointed = run;
    let terminalObserved = false;
    const fresh = created;
    const context: ProviderCallContext = {
        ...callContext({
            credentialSlot: options.credentialSlot,
            maxChargeUsd: PROFILE_REPAIR_CANARY_MAX_RUN_USD,
            ...(run.runId ? { resumeRunId: run.runId } : {}),
        }),
        ...(fresh
            ? {
                onBeforeRunStart: async identity => {
                    validateProviderIdentity(identity, options.credentialSlot);
                },
                onRunStarted: async confirmedRunId => {
                    checkpointed = await dependencies.runStore.checkpointStarted({
                        sourceRequestId: run!.sourceRequestId,
                        repetition,
                        reservationToken: run!.reservationToken,
                        runId: confirmedRunId,
                    });
                },
            }
            : {}),
        onCostRunStarted: async identity => {
            validateProviderIdentity(identity, options.credentialSlot);
            if (
                checkpointed.runId === null
                || checkpointed.runId !== identity.runId
            ) {
                throw safeError('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
        },
        onCostRunFinished: async identity => {
            validateProviderIdentity(identity, options.credentialSlot);
            if (
                checkpointed.runId === null
                || checkpointed.runId !== identity.runId
            ) {
                throw safeError('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
            terminalObserved = true;
        },
    };

    let results: ProfileAttemptResult[];
    try {
        results = validateProfileAttemptResults(
            replay.usernames,
            'apify',
            await dependencies.getProfilesBatchOutcomes(
                replay.usernames,
                context,
                client
            )
        );
    } catch (error) {
        if (checkpointed.runId === null) {
            return dependencies.runStore.markAmbiguous({
                sourceRequestId: checkpointed.sourceRequestId,
                repetition,
                reservationToken: checkpointed.reservationToken,
            });
        }
        if (isPendingLifecycleError(error) || !terminalObserved) return checkpointed;
        const latencyMs = Math.max(
            0,
            Math.min(300_000, Math.trunc(dependencies.now() - startedAt))
        );
        const terminal = await dependencies.runStore.terminalize({
            sourceRequestId: checkpointed.sourceRequestId,
            repetition,
            reservationToken: checkpointed.reservationToken,
            runId: checkpointed.runId,
            state: 'failed',
            terminalCount: PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT,
            successCount: 0,
            unavailableCount: 0,
            incompleteCount: 0,
            otherFailureCount: PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT,
            criticalRecoveredCount: 0,
            latencyMs,
            gatePassed: false,
        });
        return reconcileUsage(terminal, dependencies);
    }
    if (checkpointed.runId === null) {
        throw safeError('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
    }
    const counts = countProfileRepairCanaryResults(results, replay.criticalUsernames);
    const latencyMs = Math.max(
        0,
        Math.min(300_000, Math.trunc(dependencies.now() - startedAt))
    );
    const terminal = await dependencies.runStore.terminalize({
        sourceRequestId: checkpointed.sourceRequestId,
        repetition,
        reservationToken: checkpointed.reservationToken,
        runId: checkpointed.runId,
        state: counts.gatePassed ? 'succeeded' : 'failed',
        ...counts,
        latencyMs,
    });
    return reconcileUsage(terminal, dependencies);
}

export async function runProfileRepairCanary(
    options: ProfileRepairCanaryOptions,
    dependencies: ProfileRepairCanaryDependencies
): Promise<SafeProfileRepairCanaryReport> {
    const operator = requireProfileRepairCanaryOperatorIdentity(dependencies.env);
    const source = validateProfileRepairCanarySource(
        await dependencies.loadSource({
            sourceRequestId: options.sourceRequestId,
            ownerId: operator.ownerId,
            ownerEmail: operator.ownerEmail,
            credentialSlot: options.credentialSlot,
        }),
        options,
        operator.ownerId,
        operator.ownerEmail
    );
    const client = dependencies.getClient(options.credentialSlot);
    const replay = await replaySource(source, options, client, dependencies);

    if (!options.confirmPaidApiCall) {
        return sanitizeProfileRepairCanaryResult({
            mode: 'replay',
            sourceRunCount: PROFILE_REPAIR_CANARY_SOURCE_RUN_COUNT,
            requestedCount: replay.usernames.length,
            criticalIncompleteCount: replay.criticalIncompleteCount,
            runs: [],
            totalActualCostUsd: 0,
            sessionMaximumExposureUsd: 0,
            costStatus: 'actual',
            gatePassed: false,
        });
    }

    const runReports: SafeProfileRepairCanaryRunReport[] = [];
    for (let repetition = 1; repetition <= options.repeats; repetition++) {
        const stored = await executeRepetition(
            repetition as ProfileRepairCanaryRepetition,
            replay,
            options,
            client,
            dependencies
        );
        const report = terminalReport(stored);
        runReports.push(report);
        if (!report.gate_passed || report.cost_status !== 'actual') break;
    }
    const cost = profileRepairCanaryReportCost(runReports);
    const gatePassed = runReports.length === options.repeats
        && runReports.every(run => run.gate_passed && run.cost_status === 'actual')
        && cost.totalActualCostUsd !== null
        && cost.totalActualCostUsd <= PROFILE_REPAIR_CANARY_MAX_TOTAL_USD + Number.EPSILON;
    return sanitizeProfileRepairCanaryResult({
        mode: 'paid_canary',
        sourceRunCount: PROFILE_REPAIR_CANARY_SOURCE_RUN_COUNT,
        requestedCount: replay.usernames.length,
        criticalIncompleteCount: replay.criticalIncompleteCount,
        runs: runReports.map(run => ({
            repetition: run.repetition,
            lifecycleStatus: run.lifecycle_status,
            terminalCount: run.terminal_count,
            successCount: run.success_count,
            unavailableCount: run.unavailable_count,
            incompleteCount: run.incomplete_count,
            otherFailureCount: run.other_failure_count,
            latencyMs: run.latency_ms,
            actualCostUsd: run.actual_cost_usd,
            costStatus: run.cost_status,
            gatePassed: run.gate_passed,
        })),
        totalActualCostUsd: cost.totalActualCostUsd,
        sessionMaximumExposureUsd: options.maximumTotalChargeUsd,
        costStatus: cost.costStatus,
        gatePassed,
    });
}

async function defaultLoadSource(input: LoadSourceInput): Promise<unknown> {
    const { data, error } = await supabaseAdmin.rpc(
        PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.sourceRpc,
        {
            p_source_request_id: input.sourceRequestId,
            p_owner_id: input.ownerId,
            p_owner_email: input.ownerEmail,
            p_credential_slot: input.credentialSlot,
        }
    );
    if (error) {
        throw safeError('PROFILE_REPAIR_CANARY_SOURCE_LOAD_FAILED');
    }
    return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function fetchProfileRepairCanaryAccountingSnapshot(
    runId: string,
    input: ProfileRepairCanaryAccountingLookup,
    env: Record<string, string | undefined> = process.env,
    request: typeof fetch = fetch
): Promise<ProfileRepairCanaryAccountingSnapshot | undefined> {
    if (!/^[A-Za-z0-9]{8,64}$/.test(runId)) {
        throw safeError('PROFILE_REPAIR_CANARY_ACCOUNTING_INVALID');
    }
    const token = selectApifyApiToken(env, input.credentialSlot);
    const response = await request(
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`,
        {
            method: 'GET',
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
            },
            redirect: 'error',
            cache: 'no-store',
            signal: input.signal,
        }
    );
    if (!response.ok) {
        try {
            await response.body?.cancel();
        } catch {
            // A failed accounting read stays conservative even if body cleanup also fails.
        }
        return undefined;
    }
    const envelope: unknown = await response.json();
    if (!isRecord(envelope) || !isRecord(envelope.data)) return undefined;
    return {
        status: envelope.data.status,
        usageTotalUsd: envelope.data.usageTotalUsd,
        finishedAt: envelope.data.finishedAt,
    };
}

function defaultDependencies(): ProfileRepairCanaryDependencies {
    return {
        env: process.env,
        loadSource: defaultLoadSource,
        getClient: slot => getApifyClient(process.env, slot) as ProfileRepairCanaryApifyClient,
        getAccountingSnapshot: fetchProfileRepairCanaryAccountingSnapshot,
        async getProfilesBatchOutcomes(usernames, context, client) {
            const provider = makeApifyProvider({
                client: client as unknown as ApifyClientLike,
                env: {},
            });
            if (!provider.getProfilesBatchOutcomes) {
                throw safeError('PROFILE_REPAIR_CANARY_PROFILE_CAPABILITY_INVALID');
            }
            return provider.getProfilesBatchOutcomes(
                [...usernames],
                usernames.length,
                context
            );
        },
        runStore: profileRepairCanaryRunStore,
        now: () => Date.now(),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runProfileRepairCanaryCli(
    args: readonly string[],
    dependencies: ProfileRepairCanaryDependencies = defaultDependencies()
): Promise<SafeProfileRepairCanaryReport> {
    const report = await runProfileRepairCanary(
        parseProfileRepairCanaryArgs(args),
        dependencies
    );
    (dependencies.writeStdout ?? (value => process.stdout.write(value)))(
        `${JSON.stringify(report)}\n`
    );
    return report;
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runProfileRepairCanaryCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            error_code: 'profile_repair_canary_failed',
        })}\n`);
        process.exitCode = 1;
    });
}
