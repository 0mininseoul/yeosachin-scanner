import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    ApifyCredentialSlot,
    ProviderCostRunFinished,
    ProviderCostRunStarted,
    ProviderCostTerminalStatus,
    ProviderRunCheckpoint,
} from '@/lib/services/instagram/providers/types';
import {
    APIFY_PROFILE_ACTOR_ID,
    APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
} from '@/lib/services/instagram/providers/apify';
import { getApifyClient } from '@/lib/services/instagram/providers/apify-relationship';
import type { ClaimedPreflight } from './preflight';

export type PreflightProviderRunClaim = Pick<
    ClaimedPreflight,
    'preflightId' | 'claimToken'
>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export const PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES = Object.freeze({
    loadRpc: 'load_analysis_preflight_provider_run',
    reserveRpc: 'reserve_analysis_preflight_provider_run',
    checkpointStartedRpc: 'checkpoint_analysis_preflight_provider_run_started',
    checkpointRejectedRpc: 'reject_analysis_preflight_provider_run_start',
    checkpointTerminalRpc: 'checkpoint_analysis_preflight_provider_run_terminal',
    listUnreconciledRpc: 'list_analysis_preflight_unreconciled_provider_runs',
    reconcileUsageRpc: 'reconcile_analysis_preflight_provider_run_usage',
});

export const FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES = Object.freeze({
    loadRpc: 'load_analysis_v2_fresh_admission_provider_run',
    reserveRpc: 'reserve_analysis_v2_fresh_admission_provider_run',
    checkpointStartedRpc: 'checkpoint_analysis_v2_fresh_admission_provider_run_started',
    checkpointRejectedRpc: 'reject_analysis_v2_fresh_admission_provider_run_start',
    checkpointTerminalRpc: 'checkpoint_analysis_v2_fresh_admission_provider_run_terminal',
    markReusableProfileSchemaV1Rpc:
        'mark_analysis_v2_fresh_admission_profile_run_reusable_v1',
});

const INITIAL_PROFILE_OPERATION_KEY = 'target-profile-fallback';
const FRESH_PROFILE_OPERATION_KEY_PATTERN = /^target-profile-fresh-admission:g(?:[1-9]|[1-9][0-9]|100)$/;

export const PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT = 16;
export const PREFLIGHT_PROVIDER_RECONCILIATION_CALL_TIMEOUT_MS = 8_000;
export const PREFLIGHT_PROVIDER_FINISH_STABILITY_MS = 30_000;
const PREFLIGHT_PROVIDER_RECONCILIATION_QUERY_LIMIT =
    PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT + 1;
const PREFLIGHT_PROVIDER_RECONCILIATION_CONCURRENCY = 4;

export type PreflightProviderRunStatus =
    | 'starting'
    | 'running'
    | 'rejected'
    | 'succeeded'
    | 'failed'
    | 'aborted'
    | 'timed_out';

export interface StoredPreflightProviderRun {
    preflightId: string;
    operationKey: string;
    inputHash: string;
    logicalProvider: 'apify';
    actorId: typeof APIFY_PROFILE_ACTOR_ID;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: typeof APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD;
    status: PreflightProviderRunStatus;
    runId: string | null;
    actualUsageUsd: number | null;
    reservedAt: string;
    runStartedAt: string | null;
    terminalizedAt: string | null;
    usageReconciledAt: string | null;
}

interface RpcResult {
    data: unknown;
    error: { code?: string; message?: string } | null;
}

interface PreflightProviderRunClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

interface ProviderIdentity {
    logicalProvider: 'apify';
    actorId: typeof APIFY_PROFILE_ACTOR_ID;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: typeof APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD;
}

export interface PreflightProviderRunStore {
    load(input: RunClaimInput): Promise<StoredPreflightProviderRun | null>;
    reserve(input: RunClaimInput & ProviderIdentity): Promise<{
        created: boolean;
        run: StoredPreflightProviderRun;
    }>;
    checkpointStarted(input: RunClaimInput & ProviderIdentity & {
        runId: string;
    }): Promise<StoredPreflightProviderRun>;
    checkpointRejected(input: RunClaimInput & ProviderIdentity):
        Promise<StoredPreflightProviderRun>;
    checkpointTerminal(input: RunClaimInput & ProviderIdentity & {
        runId: string;
        status: ProviderCostTerminalStatus;
        actualUsageUsd: number | null;
    }): Promise<StoredPreflightProviderRun>;
}

export interface FreshAdmissionProviderRunStore extends PreflightProviderRunStore {
    markReusableProfileSchemaV1(input: RunClaimInput & {
        runId: string;
    }): Promise<'marked' | 'already_marked'>;
}

interface PreflightProviderRunUsageReconciliationInput extends ProviderIdentity {
    preflightId: string;
    inputHash: string;
    runId: string;
    status: ProviderCostTerminalStatus;
    actualUsageUsd: number;
    providerFinishedAt: string;
}

export interface PreflightProviderRunReconciliationStore {
    listUnreconciled(limit?: number): Promise<StoredPreflightProviderRun[]>;
    reconcileUsage(
        input: PreflightProviderRunUsageReconciliationInput
    ): Promise<StoredPreflightProviderRun>;
}

export interface PreflightProviderCostReconciliationResult {
    eligible: number;
    finalized: number;
    failed: number;
    hasMore: boolean;
}

export interface ReconciliationApifyClient {
    run(runId: string): {
        get(): Promise<{
            status?: unknown;
            usageTotalUsd?: unknown;
            finishedAt?: unknown;
        } | undefined>;
    };
}

interface RunClaimInput {
    preflightId: string;
    claimToken: string;
    inputHash: string;
}

function safeRpcCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function assertClaimInput(input: RunClaimInput): void {
    if (
        !UUID_PATTERN.test(input.preflightId)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.inputHash)
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
    }
}

function parseMoney(value: unknown, nullable: boolean): number | null {
    if (nullable && (value === null || value === undefined)) return null;
    if (
        typeof value !== 'number'
        && !(typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid money.');
    }
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0 || result > APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid money.');
    }
    return result;
}

function strictIsoTimestampMs(value: string): number {
    const match = ISO_TIMESTAMP_PATTERN.exec(value);
    if (!match) return Number.NaN;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
    const maximumDay = month >= 1 && month <= 12
        ? new Date(Date.UTC(year, month, 0)).getUTCDate()
        : 0;
    if (
        day < 1
        || day > maximumDay
        || hour > 23
        || minute > 59
        || second > 59
        || offsetHour > 23
        || offsetMinute > 59
    ) {
        return Number.NaN;
    }
    return Date.parse(value);
}

function parseTimestamp(value: unknown, nullable: boolean): string | null {
    if (nullable && (value === null || value === undefined)) return null;
    if (typeof value !== 'string') {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid timestamp.');
    }
    const parsed = strictIsoTimestampMs(value);
    if (!Number.isFinite(parsed)) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid timestamp.');
    }
    return new Date(parsed).toISOString();
}

function parseRun(value: unknown): StoredPreflightProviderRun {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid run.');
    }
    const row = value as Record<string, unknown>;
    const status = row.status;
    const credentialSlot = row.credentialSlot;
    if (
        !UUID_PATTERN.test(String(row.preflightId))
        || (
            row.operationKey !== INITIAL_PROFILE_OPERATION_KEY
            && !FRESH_PROFILE_OPERATION_KEY_PATTERN.test(String(row.operationKey))
        )
        || typeof row.inputHash !== 'string'
        || !SHA256_PATTERN.test(row.inputHash)
        || row.logicalProvider !== 'apify'
        || row.actorId !== APIFY_PROFILE_ACTOR_ID
        || !['primary', 'secondary', 'tertiary', 'quaternary', 'quinary']
            .includes(String(credentialSlot))
        || !['starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted', 'timed_out']
            .includes(String(status))
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid run identity.');
    }
    const runId = row.runId;
    if (
        (['starting', 'rejected'].includes(String(status)) && runId !== null)
        || (
            !['starting', 'rejected'].includes(String(status))
            && (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId))
        )
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid run state.');
    }
    const maxChargeUsd = parseMoney(row.maxChargeUsd, false);
    if (maxChargeUsd !== APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid charge identity.');
    }
    const reservedAt = parseTimestamp(row.reservedAt, false)!;
    const runStartedAt = parseTimestamp(row.runStartedAt, true);
    const terminalizedAt = parseTimestamp(row.terminalizedAt, true);
    const actualUsageUsd = parseMoney(row.actualUsageUsd, true);
    const usageReconciledAt = parseTimestamp(row.usageReconciledAt, true);
    if (
        (status === 'starting' && (
            runStartedAt !== null
            || terminalizedAt !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
        ))
        || (status === 'running' && (
            runStartedAt === null
            || terminalizedAt !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
        ))
        || (status === 'rejected' && (
            runStartedAt !== null
            || terminalizedAt === null
            || actualUsageUsd !== 0
            || usageReconciledAt === null
        ))
        || (
            ['succeeded', 'failed', 'aborted', 'timed_out'].includes(String(status))
            && (
                runStartedAt === null
                || terminalizedAt === null
                || ((actualUsageUsd === null) !== (usageReconciledAt === null))
            )
        )
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid timestamps.');
    }
    return Object.freeze({
        preflightId: String(row.preflightId).toLowerCase(),
        operationKey: String(row.operationKey),
        inputHash: row.inputHash,
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot: credentialSlot as ApifyCredentialSlot,
        maxChargeUsd: APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
        status: status as PreflightProviderRunStatus,
        runId: runId as string | null,
        actualUsageUsd,
        reservedAt,
        runStartedAt,
        terminalizedAt,
        usageReconciledAt,
    });
}

function parseRunList(value: unknown, maximum: number): StoredPreflightProviderRun[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid reconciliation list.');
    }
    return value.map(item => {
        const run = parseRun(item);
        if (
            !['running', 'succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)
            || run.actualUsageUsd !== null
            || run.runId === null
        ) {
            throw new Error(
                'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid reconciliation candidate.'
            );
        }
        return run;
    });
}

function terminalStatus(value: unknown): ProviderCostTerminalStatus | null {
    switch (value) {
        case 'SUCCEEDED': return 'succeeded';
        case 'FAILED': return 'failed';
        case 'ABORTED': return 'aborted';
        case 'TIMED-OUT': return 'timed_out';
        default: return null;
    }
}

function providerFinishedAt(
    value: unknown,
    run: StoredPreflightProviderRun,
    nowMs = Date.now()
): string {
    const timestamp = value instanceof Date
        ? value.getTime()
        : typeof value === 'string'
            ? strictIsoTimestampMs(value)
            : Number.NaN;
    const lowerBound = Date.parse(run.runStartedAt ?? run.reservedAt);
    if (
        !Number.isFinite(timestamp)
        || !Number.isFinite(lowerBound)
        || timestamp < lowerBound
        || timestamp > nowMs - PREFLIGHT_PROVIDER_FINISH_STABILITY_MS
    ) {
        throw new Error('provider finish timestamp is not stable');
    }
    return new Date(timestamp).toISOString();
}

function assertIdentity(
    actual: {
        logicalProvider: 'apify' | 'coderx';
        actorId: string;
        credentialSlot: ApifyCredentialSlot;
        maxChargeUsd: number;
    },
    expected: ProviderIdentity
): void {
    if (
        actual.logicalProvider !== expected.logicalProvider
        || actual.actorId !== expected.actorId
        || actual.credentialSlot !== expected.credentialSlot
        || actual.maxChargeUsd !== expected.maxChargeUsd
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
    }
}

function assertRunClaim(
    run: StoredPreflightProviderRun,
    input: Pick<RunClaimInput, 'preflightId' | 'inputHash'>
): void {
    if (
        run.preflightId !== input.preflightId.toLowerCase()
        || run.inputHash !== input.inputHash
    ) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
    }
}

export function createPreflightProviderRunStore(
    client: PreflightProviderRunClient
): PreflightProviderRunStore & PreflightProviderRunReconciliationStore {
    async function rpc(name: string, params: Record<string, unknown>, label: string) {
        const { data, error } = await client.rpc(name, params);
        if (error) {
            throw new Error(
                `PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: ${label} (${safeRpcCode(error)}).`
            );
        }
        return data;
    }

    const params = (input: RunClaimInput) => ({
        p_preflight_id: input.preflightId,
        p_claim_token: input.claimToken,
        p_input_hash: input.inputHash,
    });
    const identityParams = (input: RunClaimInput & ProviderIdentity) => ({
        ...params(input),
        p_credential_slot: input.credentialSlot,
        p_max_charge_usd: input.maxChargeUsd,
    });

    return {
        async load(input) {
            assertClaimInput(input);
            const data = await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
                params(input),
                'load failed'
            );
            if (data === null) return null;
            const run = parseRun(data);
            assertRunClaim(run, input);
            return run;
        },
        async reserve(input) {
            assertClaimInput(input);
            const data = await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
                identityParams(input),
                'reserve failed'
            );
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid reservation.');
            }
            const value = data as Record<string, unknown>;
            if (typeof value.created !== 'boolean') {
                throw new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid reservation.');
            }
            const run = parseRun(value.run);
            assertRunClaim(run, input);
            assertIdentity(run, input);
            return { created: value.created, run };
        },
        async checkpointStarted(input) {
            assertClaimInput(input);
            if (!RUN_ID_PATTERN.test(input.runId)) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
            }
            const run = parseRun(await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.checkpointStartedRpc,
                { ...identityParams(input), p_run_id: input.runId },
                'start checkpoint failed'
            ));
            assertRunClaim(run, input);
            assertIdentity(run, input);
            if (run.runId !== input.runId) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },
        async checkpointRejected(input) {
            assertClaimInput(input);
            const run = parseRun(await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.checkpointRejectedRpc,
                identityParams(input),
                'start rejection checkpoint failed'
            ));
            assertRunClaim(run, input);
            assertIdentity(run, input);
            if (
                run.status !== 'rejected'
                || run.runId !== null
                || run.actualUsageUsd !== 0
                || run.usageReconciledAt === null
            ) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },
        async checkpointTerminal(input) {
            assertClaimInput(input);
            if (!RUN_ID_PATTERN.test(input.runId)) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
            }
            if (
                input.actualUsageUsd !== null
                && (
                    !Number.isFinite(input.actualUsageUsd)
                    || input.actualUsageUsd < 0
                    || input.actualUsageUsd > input.maxChargeUsd
                )
            ) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
            }
            const run = parseRun(await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.checkpointTerminalRpc,
                {
                    ...identityParams(input),
                    p_run_id: input.runId,
                    p_status: input.status,
                    p_actual_usage_usd: input.actualUsageUsd,
                },
                'terminal checkpoint failed'
            ));
            assertRunClaim(run, input);
            assertIdentity(run, input);
            if (run.runId !== input.runId || run.status !== input.status) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },
        async listUnreconciled(limit = PREFLIGHT_PROVIDER_RECONCILIATION_QUERY_LIMIT) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
            }
            const data = await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.listUnreconciledRpc,
                { p_limit: limit },
                'reconciliation list failed'
            );
            return parseRunList(data, limit);
        },
        async reconcileUsage(input) {
            if (
                !UUID_PATTERN.test(input.preflightId)
                || !SHA256_PATTERN.test(input.inputHash)
                || !RUN_ID_PATTERN.test(input.runId)
                || !['succeeded', 'failed', 'aborted', 'timed_out'].includes(input.status)
                || !Number.isFinite(input.actualUsageUsd)
                || input.actualUsageUsd < 0
                || input.actualUsageUsd > input.maxChargeUsd
                || !Number.isFinite(strictIsoTimestampMs(input.providerFinishedAt))
                || strictIsoTimestampMs(input.providerFinishedAt)
                    > Date.now() - PREFLIGHT_PROVIDER_FINISH_STABILITY_MS
            ) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
            }
            const data = await rpc(
                PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.reconcileUsageRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_input_hash: input.inputHash,
                    p_run_id: input.runId,
                    p_logical_provider: input.logicalProvider,
                    p_actor_id: input.actorId,
                    p_credential_slot: input.credentialSlot,
                    p_max_charge_usd: input.maxChargeUsd,
                    p_status: input.status,
                    p_actual_usage_usd: input.actualUsageUsd,
                    p_provider_finished_at: input.providerFinishedAt,
                },
                'usage reconciliation failed'
            );
            const run = parseRun(data);
            assertRunClaim(run, {
                preflightId: input.preflightId,
                inputHash: input.inputHash,
            });
            assertIdentity(run, input);
            if (
                run.runId !== input.runId
                || run.status !== input.status
                || run.actualUsageUsd !== input.actualUsageUsd
            ) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },
    };
}

export function freshAdmissionProviderOperationKey(generation: number): string {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 100) {
        throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
    }
    return `target-profile-fresh-admission:g${generation}`;
}

export function createFreshAdmissionProviderRunStore(
    client: PreflightProviderRunClient,
    generation: number
): FreshAdmissionProviderRunStore {
    const operationKey = freshAdmissionProviderOperationKey(generation);
    const rpcNames = new Map<string, string>([
        [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.loadRpc],
        [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.reserveRpc],
        [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.checkpointStartedRpc,
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.checkpointStartedRpc],
        [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.checkpointRejectedRpc,
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.checkpointRejectedRpc],
        [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.checkpointTerminalRpc,
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.checkpointTerminalRpc],
    ]);
    const store = createPreflightProviderRunStore({
        rpc(name, params) {
            const freshName = rpcNames.get(name);
            if (!freshName) {
                return Promise.resolve({
                    data: null,
                    error: { code: 'INVALID_RPC' },
                });
            }
            return client.rpc(freshName, {
                ...params,
                p_admission_generation: generation,
            });
        },
    });
    const assertOperation = (run: StoredPreflightProviderRun) => {
        if (run.operationKey !== operationKey) {
            throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
        }
        return run;
    };
    return {
        async load(input) {
            const run = await store.load(input);
            return run === null ? null : assertOperation(run);
        },
        async reserve(input) {
            const reserved = await store.reserve(input);
            return { ...reserved, run: assertOperation(reserved.run) };
        },
        async checkpointStarted(input) {
            return assertOperation(await store.checkpointStarted(input));
        },
        async checkpointRejected(input) {
            return assertOperation(await store.checkpointRejected(input));
        },
        async checkpointTerminal(input) {
            return assertOperation(await store.checkpointTerminal(input));
        },
        async markReusableProfileSchemaV1(input) {
            assertClaimInput(input);
            if (!RUN_ID_PATTERN.test(input.runId)) {
                throw new Error('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR');
            }
            const { data, error } = await client.rpc(
                FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.markReusableProfileSchemaV1Rpc,
                {
                    p_preflight_id: input.preflightId,
                    p_admission_generation: generation,
                    p_claim_token: input.claimToken,
                    p_input_hash: input.inputHash,
                    p_run_id: input.runId,
                }
            );
            if (error) {
                throw new Error(
                    `PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: reusable profile attestation failed (${safeRpcCode(error)}).`
                );
            }
            if (typeof data !== 'boolean') {
                throw new Error(
                    'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid reusable profile attestation.'
                );
            }
            return data ? 'marked' : 'already_marked';
        },
    };
}

export const preflightProviderRunStore = createPreflightProviderRunStore(supabaseAdmin);

async function runWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    task: (value: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (nextIndex < values.length) {
                const index = nextIndex++;
                results[index] = await task(values[index]);
            }
        }
    ));
    return results;
}

async function withinReconciliationTimeout<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('PREFLIGHT_PROVIDER_RECONCILIATION_TIMEOUT')),
                    PREFLIGHT_PROVIDER_RECONCILIATION_CALL_TIMEOUT_MS
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function reconcileSettledPreflightProviderCosts(
    store: PreflightProviderRunReconciliationStore = preflightProviderRunStore,
    dependencies: {
        clientForSlot?: (slot: ApifyCredentialSlot) => ReconciliationApifyClient;
        env?: Record<string, string | undefined>;
    } = {}
): Promise<PreflightProviderCostReconciliationResult> {
    const candidates = await store.listUnreconciled(
        PREFLIGHT_PROVIDER_RECONCILIATION_QUERY_LIMIT
    );
    const rows = candidates.slice(0, PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT);
    const outcomes = await runWithConcurrency(
        rows,
        PREFLIGHT_PROVIDER_RECONCILIATION_CONCURRENCY,
        async run => {
            try {
                if (!run.runId) throw new Error('missing terminal run id');
                const apify = dependencies.clientForSlot?.(run.credentialSlot)
                    ?? getApifyClient(dependencies.env ?? process.env, run.credentialSlot);
                const snapshot = await withinReconciliationTimeout(
                    apify.run(run.runId).get()
                );
                const usageTotalUsd = snapshot?.usageTotalUsd;
                const remoteStatus = terminalStatus(snapshot?.status);
                const remoteFinishedAt = providerFinishedAt(snapshot?.finishedAt, run);
                if (
                    remoteStatus === null
                    || (run.status !== 'running' && remoteStatus !== run.status)
                    || typeof usageTotalUsd !== 'number'
                    || !Number.isFinite(usageTotalUsd)
                    || usageTotalUsd < 0
                ) {
                    throw new Error('provider usage is not stable');
                }
                const actualUsageUsd = Number(usageTotalUsd.toFixed(12));
                if (
                    !Number.isFinite(actualUsageUsd)
                    || actualUsageUsd < 0
                    || actualUsageUsd > run.maxChargeUsd
                ) {
                    throw new Error('provider usage exceeds its fixed charge');
                }
                await store.reconcileUsage({
                    preflightId: run.preflightId,
                    inputHash: run.inputHash,
                    logicalProvider: run.logicalProvider,
                    actorId: run.actorId,
                    credentialSlot: run.credentialSlot,
                    maxChargeUsd: run.maxChargeUsd,
                    runId: run.runId,
                    status: remoteStatus,
                    actualUsageUsd,
                    providerFinishedAt: remoteFinishedAt,
                });
                return true;
            } catch {
                return false;
            }
        }
    );
    const finalized = outcomes.filter(Boolean).length;
    return Object.freeze({
        eligible: rows.length,
        finalized,
        failed: rows.length - finalized,
        hasMore: candidates.length > PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT,
    });
}

export function preflightProviderIdentity(
    credentialSlot: ApifyCredentialSlot
): ProviderIdentity {
    return Object.freeze({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot,
        maxChargeUsd: APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
    });
}

export async function bindPreflightProviderRunCheckpoint(input: {
    store: PreflightProviderRunStore;
    claim: PreflightProviderRunClaim;
    inputHash: string;
    identity: ProviderIdentity;
}): Promise<{
    stored: StoredPreflightProviderRun | null;
    checkpoint: ProviderRunCheckpoint;
}> {
    const claimInput: RunClaimInput = {
        preflightId: input.claim.preflightId,
        claimToken: input.claim.claimToken,
        inputHash: input.inputHash,
    };
    let current = await input.store.load(claimInput);
    if (current) {
        assertRunClaim(current, claimInput);
        assertIdentity(current, input.identity);
    }

    const requireCurrent = (): StoredPreflightProviderRun => {
        if (!current) throw new Error('PREFLIGHT_PROVIDER_RUN_NOT_RESERVED');
        return current;
    };
    const assertCostEvent = (event: ProviderCostRunStarted): StoredPreflightProviderRun => {
        const stored = requireCurrent();
        assertIdentity(event, input.identity);
        if (!stored.runId || event.runId !== stored.runId) {
            throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
        }
        return stored;
    };
    const costCallbacks: Pick<
        ProviderRunCheckpoint,
        'onCostRunStarted' | 'onCostRunFinished'
    > = {
        onCostRunStarted: async event => {
            assertCostEvent(event);
        },
        onCostRunFinished: async (event: ProviderCostRunFinished) => {
            assertCostEvent(event);
            current = await input.store.checkpointTerminal({
                ...claimInput,
                ...input.identity,
                runId: event.runId,
                status: event.status,
                actualUsageUsd: event.usageTotalUsd,
            });
        },
    };

    if (current) {
        return {
            stored: current,
            checkpoint: {
                ...costCallbacks,
                logicalProvider: current.logicalProvider,
                actorId: current.actorId,
                credentialSlot: current.credentialSlot,
                maxChargeUsd: current.maxChargeUsd,
                ...(current.runId ? { resumeRunId: current.runId } : { startReserved: true }),
            },
        };
    }

    return {
        stored: null,
        checkpoint: {
            ...costCallbacks,
            ...input.identity,
            onBeforeRunStart: async actual => {
                assertIdentity(actual, input.identity);
                const reserved = await input.store.reserve({
                    ...claimInput,
                    ...input.identity,
                });
                current = reserved.run;
                if (!reserved.created) {
                    throw new Error('PREFLIGHT_PROVIDER_RUN_ALREADY_RESERVED');
                }
            },
            onRunStarted: async runId => {
                requireCurrent();
                current = await input.store.checkpointStarted({
                    ...claimInput,
                    ...input.identity,
                    runId,
                });
            },
            onRunStartRejected: async event => {
                const reserved = requireCurrent();
                assertIdentity(event, input.identity);
                if (reserved.runId !== null || reserved.status !== 'starting') {
                    throw new Error('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT');
                }
                current = await input.store.checkpointRejected({
                    ...claimInput,
                    ...input.identity,
                });
            },
        },
    };
}
