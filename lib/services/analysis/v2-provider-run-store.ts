import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    ApifyCredentialSlot,
    ProviderCostRunFinished,
    ProviderCostRunStarted,
    ProviderCostTerminalStatus,
    ProviderRunCheckpoint,
} from '@/lib/services/instagram/providers/types';
import { isApifyCredentialSlot } from '@/lib/services/instagram/providers/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CANONICAL_HASH_INPUT_BYTES = 65_536;
const MAX_PROVIDER_CHARGE_USD = 100_000;

export const ANALYSIS_V2_PROVIDER_OPERATION_KINDS = [
    'target-profile',
    'profile-fallback',
    'relationship-followers',
    'relationship-following',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const;

export type AnalysisV2ProviderOperationKind =
    typeof ANALYSIS_V2_PROVIDER_OPERATION_KINDS[number];

const OPERATION_KEY_PATTERN = new RegExp(
    `^(?:${ANALYSIS_V2_PROVIDER_OPERATION_KINDS.join('|')}):[0-9a-f]{64}$`
);

export const ANALYSIS_V2_PROVIDER_RUN_STATUSES = [
    'starting',
    'running',
    'succeeded',
    'failed',
    'aborted',
    'timed_out',
] as const;

export type AnalysisV2ProviderRunStatus =
    typeof ANALYSIS_V2_PROVIDER_RUN_STATUSES[number];

export type AnalysisV2LogicalPaidProvider = Extract<
    ProviderCostRunStarted['logicalProvider'],
    'apify' | 'coderx'
>;

export interface AnalysisV2ProviderRunIdentity {
    requestId: string;
    jobKey: string;
    claimToken: string;
    operationKey: string;
    inputHash: string;
}

export interface AnalysisV2ProviderRunImmutableIdentity {
    logicalProvider: AnalysisV2LogicalPaidProvider;
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: number;
}

export type AnalysisV2ProviderRunReservationInput = AnalysisV2ProviderRunIdentity
    & AnalysisV2ProviderRunImmutableIdentity;

export interface StoredAnalysisV2ProviderRun
    extends Omit<AnalysisV2ProviderRunIdentity, 'claimToken'>,
    AnalysisV2ProviderRunImmutableIdentity {
    reservationToken: string;
    status: AnalysisV2ProviderRunStatus;
    runId: string | null;
    actualUsageUsd: number | null;
    reservedAt: string;
    runStartedAt: string | null;
    terminalizedAt: string | null;
    usageReconciledAt: string | null;
}

export interface AnalysisV2ProviderRunReservation {
    created: boolean;
    run: StoredAnalysisV2ProviderRun;
}

export interface AnalysisV2ProviderRunUsageReconciliationInput {
    reservationToken: string;
    runId: string;
    logicalProvider: AnalysisV2LogicalPaidProvider;
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: number;
    status: ProviderCostTerminalStatus;
    actualUsageUsd: number;
}

export interface AnalysisV2ProviderRunCleanupTerminalInput
    extends Omit<AnalysisV2ProviderRunUsageReconciliationInput, 'actualUsageUsd'> {
    actualUsageUsd: number | null;
}

export interface AnalysisV2ProviderRunCleanupIntentInput {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
    errorCode: string;
}

export interface StoredAnalysisV2ProviderRunCleanupIntent {
    requestId: string;
    jobKey: string;
    jobInputHash: string;
    errorCode: string;
}

export interface AnalysisV2ActiveProviderRunBatch {
    startingCount: number;
    runs: readonly StoredAnalysisV2ProviderRun[];
}

export interface AnalysisV2ProviderRunAdapterBinding {
    /** The durable row before this binding; null means onBeforeRunStart will reserve it. */
    stored: StoredAnalysisV2ProviderRun | null;
    checkpoint: ProviderRunCheckpoint;
}

export interface AnalysisV2ProviderRunStore {
    reserve(input: AnalysisV2ProviderRunReservationInput):
        Promise<AnalysisV2ProviderRunReservation>;
    checkpointStarted(input: AnalysisV2ProviderRunIdentity & {
        reservationToken: string;
        runId: string;
    }): Promise<StoredAnalysisV2ProviderRun>;
    checkpointTerminal(input: AnalysisV2ProviderRunIdentity & {
        reservationToken: string;
        runId: string;
        status: ProviderCostTerminalStatus;
        actualUsageUsd: number | null;
    }): Promise<StoredAnalysisV2ProviderRun>;
    load(input: Pick<AnalysisV2ProviderRunIdentity, 'requestId' | 'jobKey' | 'operationKey'>):
        Promise<StoredAnalysisV2ProviderRun | null>;
    listUnreconciled(limit?: number): Promise<StoredAnalysisV2ProviderRun[]>;
    reconcileUsage(input: AnalysisV2ProviderRunUsageReconciliationInput):
        Promise<StoredAnalysisV2ProviderRun>;
    requestCleanup(input: AnalysisV2ProviderRunCleanupIntentInput): Promise<void>;
    loadCleanupIntent(requestId: string):
        Promise<StoredAnalysisV2ProviderRunCleanupIntent | null>;
    listActiveForCleanup(input?: {
        requestId?: string;
        limit?: number;
    }): Promise<AnalysisV2ActiveProviderRunBatch>;
    settleForCleanup(input: AnalysisV2ProviderRunCleanupTerminalInput):
        Promise<StoredAnalysisV2ProviderRun>;
    bindAdapterCheckpoint(input: AnalysisV2ProviderRunReservationInput):
        Promise<AnalysisV2ProviderRunAdapterBinding>;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2ProviderRunSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export const ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_provider_runs',
    reserveRpc: 'reserve_analysis_v2_provider_run',
    startedRpc: 'checkpoint_analysis_v2_provider_run_started',
    terminalRpc: 'checkpoint_analysis_v2_provider_run_terminal',
    loadRpc: 'load_analysis_v2_provider_run',
    listUnreconciledRpc: 'list_analysis_v2_unreconciled_provider_runs',
    reconcileUsageRpc: 'reconcile_analysis_v2_provider_run_usage',
    requestCleanupRpc: 'request_analysis_v2_provider_run_cleanup',
    loadCleanupIntentRpc: 'load_analysis_v2_provider_run_cleanup_intent',
    listActiveCleanupRpc: 'list_analysis_v2_active_provider_runs_for_cleanup',
    settleCleanupRpc: 'settle_analysis_v2_provider_run_for_cleanup',
});

export class AnalysisV2ProviderRunFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH');
        this.name = 'AnalysisV2ProviderRunFenceError';
    }
}

export class AnalysisV2ProviderRunConflictError extends Error {
    constructor(message = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT') {
        super(message);
        this.name = 'AnalysisV2ProviderRunConflictError';
    }
}

export class AnalysisV2ProviderRunAlreadyReservedError extends Error {
    constructor() {
        super('ANALYSIS_V2_PROVIDER_RUN_ALREADY_RESERVED');
        this.name = 'AnalysisV2ProviderRunAlreadyReservedError';
    }
}

export class AnalysisV2ProviderRunReconciliationNotReadyError extends Error {
    constructor() {
        super('ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_NOT_READY');
        this.name = 'AnalysisV2ProviderRunReconciliationNotReadyError';
    }
}

function canonicalHashInput(value: string): string {
    if (
        typeof value !== 'string'
        || value.length === 0
        || Buffer.byteLength(value, 'utf8') > MAX_CANONICAL_HASH_INPUT_BYTES
    ) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid hash input.');
    }
    return value;
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Builds a PII-free logical operation identity. Dynamic usernames or URLs may be part of the
 * canonical identity material, but only their domain-separated SHA-256 digest is returned.
 */
export function createAnalysisV2ProviderOperationKey(
    kind: AnalysisV2ProviderOperationKind,
    canonicalIdentity: string
): string {
    if (!ANALYSIS_V2_PROVIDER_OPERATION_KINDS.includes(kind)) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid operation kind.');
    }
    return `${kind}:${sha256(
        `analysis-v2-provider-operation-v1\n${kind}\n${canonicalHashInput(canonicalIdentity)}`
    )}`;
}

export const analysisV2ProviderOperationKey = createAnalysisV2ProviderOperationKey;

/** Hashes bounded canonical Actor input without retaining usernames, URLs, or evidence. */
export function createAnalysisV2ProviderInputHash(canonicalInput: string): string {
    return sha256(
        `analysis-v2-provider-input-v1\n${canonicalHashInput(canonicalInput)}`
    );
}

export const analysisV2ProviderInputHash = createAnalysisV2ProviderInputHash;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rpcObject(data: unknown, operation: string): Record<string, unknown> {
    if (isRecord(data)) return data;
    if (Array.isArray(data) && data.length === 1 && isRecord(data[0])) return data[0];
    throw new Error(
        `ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid ${operation} response.`
    );
}

function requiredString(
    value: unknown,
    pattern: RegExp,
    field: string
): string {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new Error(`ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return value;
}

function requiredUuid(value: unknown, field: string): string {
    return requiredString(value, UUID_PATTERN, field).toLowerCase();
}

function nullableTimestamp(value: unknown, field: string): string | null {
    if (value === null) return null;
    return requiredString(value, ISO_TIMESTAMP_PATTERN, field);
}

function requiredTimestamp(value: unknown, field: string): string {
    const timestamp = nullableTimestamp(value, field);
    if (timestamp === null) {
        throw new Error(`ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: missing ${field}.`);
    }
    return timestamp;
}

function canonicalMoney(value: number, field: string): number {
    if (!Number.isFinite(value) || value < 0 || value > MAX_PROVIDER_CHARGE_USD) {
        throw new Error(`ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid ${field}.`);
    }
    return Number(value.toFixed(12));
}

function storedMoney(value: unknown, field: string): number {
    if (
        typeof value !== 'number'
        && !(typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value))
    ) {
        throw new Error(`ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_PROVIDER_CHARGE_USD) {
        throw new Error(`ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return Number(parsed.toFixed(12));
}

function nullableStoredMoney(value: unknown, field: string): number | null {
    return value === null ? null : storedMoney(value, field);
}

function requiredStatus(value: unknown): AnalysisV2ProviderRunStatus {
    if (!ANALYSIS_V2_PROVIDER_RUN_STATUSES.includes(value as AnalysisV2ProviderRunStatus)) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid run status.');
    }
    return value as AnalysisV2ProviderRunStatus;
}

function parseStoredRun(data: unknown, operation: string): StoredAnalysisV2ProviderRun {
    const row = rpcObject(data, operation);
    const status = requiredStatus(row.status);
    const runId = row.runId === null
        ? null
        : requiredString(row.runId, RUN_ID_PATTERN, 'run id');
    const actualUsageUsd = nullableStoredMoney(row.actualUsageUsd, 'actual usage');
    const runStartedAt = nullableTimestamp(row.runStartedAt, 'run start timestamp');
    const terminalizedAt = nullableTimestamp(row.terminalizedAt, 'terminal timestamp');
    const usageReconciledAt = nullableTimestamp(
        row.usageReconciledAt,
        'usage reconciliation timestamp'
    );
    if (
        (status === 'starting' && (
            runId !== null
            || runStartedAt !== null
            || terminalizedAt !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
        ))
        || (status === 'running' && (
            runId === null
            || runStartedAt === null
            || terminalizedAt !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
        ))
        || (!['starting', 'running'].includes(status) && (
            runId === null
            || runStartedAt === null
            || terminalizedAt === null
            || ((actualUsageUsd === null) !== (usageReconciledAt === null))
        ))
    ) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid run state.');
    }
    const logicalProvider = row.logicalProvider;
    const credentialSlot = row.credentialSlot;
    if (logicalProvider !== 'apify' && logicalProvider !== 'coderx') {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid provider.');
    }
    if (!isApifyCredentialSlot(credentialSlot)) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid credential slot.');
    }
    return {
        requestId: requiredUuid(row.requestId, 'request id'),
        jobKey: requiredString(row.jobKey, JOB_KEY_PATTERN, 'job key'),
        operationKey: requiredString(row.operationKey, OPERATION_KEY_PATTERN, 'operation key'),
        inputHash: requiredString(row.inputHash, SHA256_PATTERN, 'input hash'),
        reservationToken: requiredUuid(row.reservationToken, 'reservation token'),
        logicalProvider,
        actorId: requiredString(row.actorId, ACTOR_ID_PATTERN, 'actor id'),
        credentialSlot,
        maxChargeUsd: storedMoney(row.maxChargeUsd, 'maximum charge'),
        status,
        runId,
        actualUsageUsd,
        reservedAt: requiredTimestamp(row.reservedAt, 'reservation timestamp'),
        runStartedAt,
        terminalizedAt,
        usageReconciledAt,
    };
}

function parseReservation(
    data: unknown,
    operation: string
): AnalysisV2ProviderRunReservation {
    const envelope = rpcObject(data, operation);
    if (typeof envelope.created !== 'boolean') {
        throw new Error(
            `ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid ${operation} creation flag.`
        );
    }
    return {
        created: envelope.created,
        run: parseStoredRun(envelope.run, operation),
    };
}

function parseUnreconciledRuns(data: unknown, limit: number): StoredAnalysisV2ProviderRun[] {
    if (!Array.isArray(data) || data.length > limit) {
        throw new Error(
            'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid reconciliation list.'
        );
    }
    return data.map((value) => {
        const run = parseStoredRun(value, 'reconciliation list');
        if (
            !['succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)
            || run.actualUsageUsd !== null
            || run.usageReconciledAt !== null
        ) {
            throw new Error(
                'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid unreconciled run.'
            );
        }
        return run;
    });
}

function parseActiveCleanupBatch(
    data: unknown,
    limit: number
): AnalysisV2ActiveProviderRunBatch {
    const envelope = rpcObject(data, 'active cleanup list');
    if (
        !Number.isSafeInteger(envelope.startingCount)
        || (envelope.startingCount as number) < 0
        || (envelope.startingCount as number) > 10_000
        || !Array.isArray(envelope.runs)
        || envelope.runs.length > limit
    ) {
        throw new Error(
            'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid active cleanup list.'
        );
    }
    const runs = envelope.runs.map(value => parseStoredRun(value, 'active cleanup list'));
    if (runs.some(run => run.status !== 'running' || run.runId === null)) {
        throw new Error(
            'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid active cleanup run.'
        );
    }
    return Object.freeze({
        startingCount: envelope.startingCount as number,
        runs: Object.freeze(runs),
    });
}

function parseCleanupIntent(data: unknown): StoredAnalysisV2ProviderRunCleanupIntent {
    const intent = rpcObject(data, 'cleanup intent');
    const errorCode = requiredString(
        intent.errorCode,
        /^[A-Z][A-Z0-9_]{2,63}$/,
        'cleanup error code'
    );
    return Object.freeze({
        requestId: requiredUuid(intent.requestId, 'cleanup request id'),
        jobKey: requiredString(intent.jobKey, JOB_KEY_PATTERN, 'cleanup job key'),
        jobInputHash: requiredString(
            intent.jobInputHash,
            SHA256_PATTERN,
            'cleanup input hash'
        ),
        errorCode,
    });
}

function validateLookupIdentity(input: {
    requestId: string;
    jobKey: string;
    operationKey: string;
}): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !OPERATION_KEY_PATTERN.test(input.operationKey)
    ) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid run identity.');
    }
}

function validateClaimedIdentity(input: AnalysisV2ProviderRunIdentity): void {
    validateLookupIdentity(input);
    if (!UUID_PATTERN.test(input.claimToken) || !SHA256_PATTERN.test(input.inputHash)) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid claim identity.');
    }
}

function validateCleanupIntentIdentity(input: AnalysisV2ProviderRunCleanupIntentInput): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
    ) {
        throw new Error(
            'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid cleanup identity.'
        );
    }
}

function canonicalProviderIdentity(
    input: AnalysisV2ProviderRunImmutableIdentity
): AnalysisV2ProviderRunImmutableIdentity {
    if (input.logicalProvider !== 'apify' && input.logicalProvider !== 'coderx') {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid provider.');
    }
    if (!ACTOR_ID_PATTERN.test(input.actorId)) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid actor id.');
    }
    if (!isApifyCredentialSlot(input.credentialSlot)) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid credential slot.');
    }
    return {
        logicalProvider: input.logicalProvider,
        actorId: input.actorId,
        credentialSlot: input.credentialSlot,
        maxChargeUsd: canonicalMoney(input.maxChargeUsd, 'maximum charge'),
    };
}

function assertStoredIdentity(
    stored: StoredAnalysisV2ProviderRun,
    expected: AnalysisV2ProviderRunReservationInput
): void {
    if (
        stored.requestId !== expected.requestId.toLowerCase()
        || stored.jobKey !== expected.jobKey
        || stored.operationKey !== expected.operationKey
        || stored.inputHash !== expected.inputHash
        || stored.logicalProvider !== expected.logicalProvider
        || stored.actorId !== expected.actorId
        || stored.credentialSlot !== expected.credentialSlot
        || stored.maxChargeUsd !== canonicalMoney(expected.maxChargeUsd, 'maximum charge')
    ) {
        throw new AnalysisV2ProviderRunConflictError();
    }
}

function assertReconciliationIdentity(
    stored: StoredAnalysisV2ProviderRun,
    expected: AnalysisV2ProviderRunUsageReconciliationInput
): void {
    if (
        stored.reservationToken !== expected.reservationToken.toLowerCase()
        || stored.runId !== expected.runId
        || stored.logicalProvider !== expected.logicalProvider
        || stored.actorId !== expected.actorId
        || stored.credentialSlot !== expected.credentialSlot
        || stored.maxChargeUsd !== canonicalMoney(expected.maxChargeUsd, 'maximum charge')
        || stored.status !== expected.status
        || stored.actualUsageUsd !== canonicalMoney(expected.actualUsageUsd, 'actual usage')
        || stored.usageReconciledAt === null
    ) {
        throw new AnalysisV2ProviderRunConflictError(
            'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT'
        );
    }
}

function assertCleanupTerminalIdentity(
    stored: StoredAnalysisV2ProviderRun,
    expected: AnalysisV2ProviderRunCleanupTerminalInput
): void {
    if (
        stored.reservationToken !== expected.reservationToken.toLowerCase()
        || stored.runId !== expected.runId
        || stored.logicalProvider !== expected.logicalProvider
        || stored.actorId !== expected.actorId
        || stored.credentialSlot !== expected.credentialSlot
        || stored.maxChargeUsd !== canonicalMoney(expected.maxChargeUsd, 'maximum charge')
        || stored.status !== expected.status
        || (
            expected.actualUsageUsd !== null
            && stored.actualUsageUsd !== canonicalMoney(
                expected.actualUsageUsd,
                'actual usage'
            )
        )
        || stored.terminalizedAt === null
    ) {
        throw new AnalysisV2ProviderRunConflictError(
            'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT'
        );
    }
}

function assertCostEventIdentity(
    event: ProviderCostRunStarted,
    expected: StoredAnalysisV2ProviderRun
): void {
    const identity = canonicalProviderIdentity(event);
    if (
        identity.logicalProvider !== expected.logicalProvider
        || identity.actorId !== expected.actorId
        || identity.credentialSlot !== expected.credentialSlot
        || identity.maxChargeUsd !== expected.maxChargeUsd
        || event.runId !== expected.runId
        || !RUN_ID_PATTERN.test(event.runId)
    ) {
        throw new AnalysisV2ProviderRunConflictError(
            'ANALYSIS_V2_PROVIDER_RUN_COST_IDENTITY_CONFLICT'
        );
    }
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH') {
        throw new AnalysisV2ProviderRunFenceError();
    }
    if (
        error.message === 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_RUN_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_STATE_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_TERMINAL_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_INTENT_CONFLICT'
    ) {
        throw new AnalysisV2ProviderRunConflictError(error.message);
    }
    if (error.message === 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_NOT_READY') {
        throw new AnalysisV2ProviderRunReconciliationNotReadyError();
    }
    if (
        error.message === 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY'
    ) {
        throw new Error(error.message);
    }
    throw new Error(
        `ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

export function createAnalysisV2ProviderRunStore(
    client: AnalysisV2ProviderRunSupabaseClient = supabaseAdmin
): AnalysisV2ProviderRunStore {
    const load = async (input: Pick<
        AnalysisV2ProviderRunIdentity,
        'requestId' | 'jobKey' | 'operationKey'
    >): Promise<StoredAnalysisV2ProviderRun | null> => {
        validateLookupIdentity(input);
        const { data, error } = await client.rpc(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            {
                p_request_id: input.requestId.toLowerCase(),
                p_job_key: input.jobKey,
                p_operation_key: input.operationKey,
            }
        );
        if (error) throwRpcError(error, 'load');
        return data === null ? null : parseStoredRun(data, 'load');
    };

    const store: AnalysisV2ProviderRunStore = {
        async reserve(input) {
            validateClaimedIdentity(input);
            const provider = canonicalProviderIdentity(input);
            const expected = { ...input, ...provider };
            const proposedReservationToken = randomUUID();
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_operation_key: input.operationKey,
                    p_input_hash: input.inputHash,
                    p_logical_provider: provider.logicalProvider,
                    p_actor_id: provider.actorId,
                    p_credential_slot: provider.credentialSlot,
                    p_max_charge_usd: provider.maxChargeUsd,
                    p_reservation_token: proposedReservationToken,
                }
            );
            if (error) throwRpcError(error, 'reserve');
            const reservation = parseReservation(data, 'reserve');
            assertStoredIdentity(reservation.run, expected);
            if (
                reservation.created
                && (
                    reservation.run.reservationToken !== proposedReservationToken
                    || reservation.run.status !== 'starting'
                    || reservation.run.runId !== null
                )
            ) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid new reservation.'
                );
            }
            return reservation;
        },

        async checkpointStarted(input) {
            validateClaimedIdentity(input);
            const reservationToken = requiredUuid(
                input.reservationToken,
                'reservation token'
            );
            const runId = requiredString(input.runId, RUN_ID_PATTERN, 'run id');
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.startedRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_operation_key: input.operationKey,
                    p_reservation_token: reservationToken,
                    p_run_id: runId,
                }
            );
            if (error) throwRpcError(error, 'run checkpoint');
            const stored = parseStoredRun(data, 'run checkpoint');
            if (
                stored.reservationToken !== reservationToken
                || stored.runId !== runId
                || stored.status === 'starting'
            ) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid run checkpoint.'
                );
            }
            return stored;
        },

        async checkpointTerminal(input) {
            validateClaimedIdentity(input);
            if (!['succeeded', 'failed', 'aborted', 'timed_out'].includes(input.status)) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid terminal status.'
                );
            }
            const reservationToken = requiredUuid(
                input.reservationToken,
                'reservation token'
            );
            const runId = requiredString(input.runId, RUN_ID_PATTERN, 'run id');
            const actualUsageUsd = input.actualUsageUsd === null
                ? null
                : canonicalMoney(input.actualUsageUsd, 'actual usage');
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.terminalRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_operation_key: input.operationKey,
                    p_reservation_token: reservationToken,
                    p_run_id: runId,
                    p_status: input.status,
                    p_actual_usage_usd: actualUsageUsd,
                }
            );
            if (error) throwRpcError(error, 'terminal checkpoint');
            const stored = parseStoredRun(data, 'terminal checkpoint');
            if (
                stored.reservationToken !== reservationToken
                || stored.runId !== runId
                || stored.status !== input.status
                || (
                    actualUsageUsd !== null
                    && stored.actualUsageUsd !== actualUsageUsd
                )
            ) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid terminal checkpoint.'
                );
            }
            return stored;
        },

        load,

        async listUnreconciled(limit = 64) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid reconciliation limit.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.listUnreconciledRpc,
                { p_limit: limit }
            );
            if (error) throwRpcError(error, 'reconciliation list');
            return parseUnreconciledRuns(data, limit);
        },

        async reconcileUsage(input) {
            const reservationToken = requiredUuid(
                input.reservationToken,
                'reservation token'
            );
            const runId = requiredString(input.runId, RUN_ID_PATTERN, 'run id');
            const provider = canonicalProviderIdentity(input);
            if (!['succeeded', 'failed', 'aborted', 'timed_out'].includes(input.status)) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid terminal status.'
                );
            }
            const actualUsageUsd = canonicalMoney(input.actualUsageUsd, 'actual usage');
            if (actualUsageUsd > provider.maxChargeUsd + 0.000000001) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: actual usage exceeds maximum charge.'
                );
            }
            const expected: AnalysisV2ProviderRunUsageReconciliationInput = {
                ...provider,
                reservationToken,
                runId,
                status: input.status,
                actualUsageUsd,
            };
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reconcileUsageRpc,
                {
                    p_reservation_token: reservationToken,
                    p_run_id: runId,
                    p_logical_provider: provider.logicalProvider,
                    p_actor_id: provider.actorId,
                    p_credential_slot: provider.credentialSlot,
                    p_max_charge_usd: provider.maxChargeUsd,
                    p_status: input.status,
                    p_actual_usage_usd: actualUsageUsd,
                }
            );
            if (error) throwRpcError(error, 'usage reconciliation');
            const stored = parseStoredRun(data, 'usage reconciliation');
            assertReconciliationIdentity(stored, expected);
            return stored;
        },

        async requestCleanup(input) {
            validateCleanupIntentIdentity(input);
            if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(input.errorCode)) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid cleanup error code.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.requestCleanupRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_error_code: input.errorCode,
                }
            );
            if (error) throwRpcError(error, 'cleanup intent');
            if (data !== true) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: invalid cleanup intent response.'
                );
            }
        },

        async loadCleanupIntent(requestId) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid cleanup request id.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadCleanupIntentRpc,
                { p_request_id: requestId.toLowerCase() }
            );
            if (error) throwRpcError(error, 'cleanup intent load');
            return data === null ? null : parseCleanupIntent(data);
        },

        async listActiveForCleanup(input = {}) {
            const limit = input.limit ?? 64;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid cleanup list limit.'
                );
            }
            if (input.requestId !== undefined && !UUID_PATTERN.test(input.requestId)) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid cleanup request id.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.listActiveCleanupRpc,
                {
                    p_request_id: input.requestId?.toLowerCase() ?? null,
                    p_limit: limit,
                }
            );
            if (error) throwRpcError(error, 'active cleanup list');
            return parseActiveCleanupBatch(data, limit);
        },

        async settleForCleanup(input) {
            const reservationToken = requiredUuid(
                input.reservationToken,
                'reservation token'
            );
            const runId = requiredString(input.runId, RUN_ID_PATTERN, 'run id');
            const provider = canonicalProviderIdentity(input);
            if (!['succeeded', 'failed', 'aborted', 'timed_out'].includes(input.status)) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: invalid cleanup terminal status.'
                );
            }
            const actualUsageUsd = input.actualUsageUsd === null
                ? null
                : canonicalMoney(input.actualUsageUsd, 'actual usage');
            if (
                actualUsageUsd !== null
                && actualUsageUsd > provider.maxChargeUsd + 0.000000001
            ) {
                throw new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR: actual usage exceeds maximum charge.'
                );
            }
            const expected: AnalysisV2ProviderRunCleanupTerminalInput = {
                ...provider,
                reservationToken,
                runId,
                status: input.status,
                actualUsageUsd,
            };
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.settleCleanupRpc,
                {
                    p_reservation_token: reservationToken,
                    p_run_id: runId,
                    p_logical_provider: provider.logicalProvider,
                    p_actor_id: provider.actorId,
                    p_credential_slot: provider.credentialSlot,
                    p_max_charge_usd: provider.maxChargeUsd,
                    p_status: input.status,
                    p_actual_usage_usd: actualUsageUsd,
                }
            );
            if (error) throwRpcError(error, 'provider cleanup settlement');
            const stored = parseStoredRun(data, 'provider cleanup settlement');
            assertCleanupTerminalIdentity(stored, expected);
            return stored;
        },

        async bindAdapterCheckpoint(input) {
            validateClaimedIdentity(input);
            const expectedProvider = canonicalProviderIdentity(input);
            const expected = { ...input, ...expectedProvider };
            const loaded = await load(input);
            let reserved: StoredAnalysisV2ProviderRun | null = null;
            if (loaded !== null) {
                const replay = await store.reserve(expected);
                if (replay.created) {
                    throw new Error(
                        'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: loaded reservation was replaced.'
                    );
                }
                reserved = replay.run;
            }
            if (reserved) assertStoredIdentity(reserved, expected);

            const requireReserved = (): StoredAnalysisV2ProviderRun => {
                if (!reserved) {
                    throw new Error(
                        'ANALYSIS_V2_PROVIDER_RUN_ERROR: provider run was not reserved.'
                    );
                }
                return reserved;
            };

            const assertStarted = (event: ProviderCostRunStarted): StoredAnalysisV2ProviderRun => {
                const current = requireReserved();
                if (!current.runId) {
                    throw new Error(
                        'ANALYSIS_V2_PROVIDER_RUN_ERROR: provider run was not checkpointed.'
                    );
                }
                assertCostEventIdentity(event, current);
                return current;
            };

            const costCallbacks: Pick<
                ProviderRunCheckpoint,
                'onCostRunStarted' | 'onCostRunFinished'
            > = {
                onCostRunStarted: async (event) => {
                    assertStarted(event);
                },
                onCostRunFinished: async (event: ProviderCostRunFinished) => {
                    const current = assertStarted(event);
                    reserved = await store.checkpointTerminal({
                        ...input,
                        reservationToken: current.reservationToken,
                        runId: event.runId,
                        status: event.status,
                        actualUsageUsd: event.usageTotalUsd,
                    });
                },
            };

            if (reserved) {
                const checkpoint: ProviderRunCheckpoint = {
                    ...costCallbacks,
                    logicalProvider: reserved.logicalProvider,
                    actorId: reserved.actorId,
                    credentialSlot: reserved.credentialSlot,
                    maxChargeUsd: reserved.maxChargeUsd,
                    ...(reserved.runId
                        ? { resumeRunId: reserved.runId }
                        : {
                            startReserved: true,
                        }),
                };
                return { stored: loaded, checkpoint };
            }

            return {
                stored: null,
                checkpoint: {
                    ...costCallbacks,
                    onBeforeRunStart: async (providerIdentity) => {
                        const actual = canonicalProviderIdentity(providerIdentity);
                        if (
                            actual.logicalProvider !== expectedProvider.logicalProvider
                            || actual.actorId !== expectedProvider.actorId
                            || actual.credentialSlot !== expectedProvider.credentialSlot
                            || actual.maxChargeUsd !== expectedProvider.maxChargeUsd
                        ) {
                            throw new AnalysisV2ProviderRunConflictError();
                        }
                        const reservation = await store.reserve(expected);
                        reserved = reservation.run;
                        if (!reservation.created) {
                            throw new AnalysisV2ProviderRunAlreadyReservedError();
                        }
                    },
                    onRunStarted: async (runId) => {
                        const current = requireReserved();
                        reserved = await store.checkpointStarted({
                            ...input,
                            reservationToken: current.reservationToken,
                            runId,
                        });
                    },
                },
            };
        },
    };

    return store;
}

export const analysisV2ProviderRunStore = createAnalysisV2ProviderRunStore();
