import 'server-only';

import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_DOMAIN = 'analysis-canonical:v1\0';

export type AnalysisCanonicalWriteFamily = 'jobs' | 'evidence' | 'cost' | 'cache' | 'audit';

export const ANALYSIS_CANONICAL_WRITE_FLAGS: Readonly<
    Record<AnalysisCanonicalWriteFamily, 'ANALYSIS_CANONICAL_JOBS_WRITE'
        | 'ANALYSIS_CANONICAL_EVIDENCE_WRITE'
        | 'ANALYSIS_CANONICAL_COST_WRITE'
        | 'ANALYSIS_CANONICAL_CACHE_WRITE'
        | 'ANALYSIS_CANONICAL_AUDIT_WRITE'>
> = Object.freeze({
    jobs: 'ANALYSIS_CANONICAL_JOBS_WRITE',
    evidence: 'ANALYSIS_CANONICAL_EVIDENCE_WRITE',
    cost: 'ANALYSIS_CANONICAL_COST_WRITE',
    cache: 'ANALYSIS_CANONICAL_CACHE_WRITE',
    audit: 'ANALYSIS_CANONICAL_AUDIT_WRITE',
});

export type AnalysisCanonicalWriteStatus =
    | 'disabled'
    | 'appended'
    | 'retry_queued'
    | 'blocked';

export type AnalysisCanonicalWriteResult =
    | Readonly<{ status: 'disabled' }>
    | Readonly<{ status: 'appended' }>
    | Readonly<{ status: 'retry_queued'; family: AnalysisCanonicalWriteFamily }>
    | Readonly<{ status: 'blocked'; family: AnalysisCanonicalWriteFamily }>;

export type AnalysisCanonicalCostResult =
    | Readonly<{ status: 'disabled'; usageUnknown: boolean }>
    | Readonly<{ status: 'appended'; usageUnknown: boolean }>
    | Readonly<{
        status: 'retry_queued';
        family: 'cost';
        usageUnknown: boolean;
    }>
    | Readonly<{
        status: 'blocked';
        family: 'cost';
        usageUnknown: boolean;
    }>;

export type AnalysisCanonicalLateCostAuditResult =
    | Readonly<{ status: 'disabled'; usageUnknown: boolean }>
    | Readonly<{ status: 'appended'; usageUnknown: boolean; version: number }>
    | Readonly<{
        status: 'retry_queued';
        family: 'audit';
        usageUnknown: boolean;
    }>
    | Readonly<{
        status: 'blocked';
        family: 'audit';
        usageUnknown: boolean;
    }>;

export type AnalysisCanonicalPayload = Record<string, unknown>;

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisCanonicalSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export type AnalysisCanonicalJobKind =
    | 'coordinator'
    | 'collection'
    | 'ai'
    | 'finalize'
    | 'recovery';

export type AnalysisCanonicalJobState =
    | 'queued'
    | 'leased'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'blocked';

export interface RecordAnalysisCanonicalJobInput {
    requestId: string;
    jobKey: string;
    kind: AnalysisCanonicalJobKind;
    state: AnalysisCanonicalJobState;
    generation?: number;
    attemptCount?: number;
    dependencyCount?: number;
    nextAttemptAt?: Date | string;
    leaseExpiresAt?: Date | string | null;
    completionHash?: string | null;
    payload?: AnalysisCanonicalPayload;
    retentionClass?: string;
}

export interface AppendAnalysisCanonicalEventInput {
    requestId: string;
    jobId?: string | null;
    kind: 'progress' | 'lifecycle' | 'operational';
    state: string;
    payload?: AnalysisCanonicalPayload;
    contentHash?: string;
    retentionClass?: string;
}

export interface AppendAnalysisCanonicalArtifactInput {
    requestId: string;
    jobId?: string | null;
    kind: 'evidence' | 'manifest' | 'media_ref' | 'replay';
    artifactKey: string;
    state: 'staged' | 'retained' | 'expired' | 'blocked';
    contentHash?: string;
    payload?: AnalysisCanonicalPayload;
    retentionClass: string;
}

export interface AppendAnalysisCanonicalCostInput {
    requestId: string;
    provider: string;
    operationKey: string;
    stage: string;
    currency?: string;
    amountKnown: number | null;
    amountConservative: number | null;
    usageUnknown: boolean;
    sourceHash?: string;
    payload?: AnalysisCanonicalPayload;
    retentionClass?: string;
}

export interface UpsertAnalysisCanonicalCacheInput {
    scope: 'ai' | 'profile' | 'anonymous' | 'blite';
    cacheKeyHash: string;
    state: 'pending' | 'ready' | 'failed' | 'expired';
    expiresAt: Date | string;
    singleFlightTokenHash?: string | null;
    payload?: AnalysisCanonicalPayload;
}

export interface AppendAnalysisCanonicalAuditInput {
    requestId: string;
    version: number;
    kind: 'bundle' | 'candidate' | 'interaction';
    candidateKey?: string | null;
    ordinal?: number | null;
    state: 'complete' | 'partial' | 'inconsistent' | 'failed';
    contentHash?: string;
    retentionClass?: string;
    payload?: AnalysisCanonicalPayload;
}

export interface AppendAnalysisCanonicalLateCostAuditInput {
    requestId: string;
    provider: string;
    operationKey: string;
    stage: string;
    currency?: string;
    amountKnown: number | null;
    amountConservative: number | null;
    usageUnknown: boolean;
    sourceHash?: string;
    costPayload?: AnalysisCanonicalPayload;
    costRetentionClass?: string;
    auditPayload?: AnalysisCanonicalPayload;
    auditRetentionClass?: string;
}

export interface AnalysisCanonicalStore {
    recordJob(input: RecordAnalysisCanonicalJobInput): Promise<AnalysisCanonicalWriteResult>;
    appendEvent(input: AppendAnalysisCanonicalEventInput): Promise<AnalysisCanonicalWriteResult>;
    appendArtifact(input: AppendAnalysisCanonicalArtifactInput): Promise<AnalysisCanonicalWriteResult>;
    appendCost(input: AppendAnalysisCanonicalCostInput): Promise<AnalysisCanonicalCostResult>;
    appendLateCostAudit(
        input: AppendAnalysisCanonicalLateCostAuditInput,
    ): Promise<AnalysisCanonicalLateCostAuditResult>;
    upsertCache(input: UpsertAnalysisCanonicalCacheInput): Promise<AnalysisCanonicalWriteResult>;
    appendAuditRow(input: AppendAnalysisCanonicalAuditInput): Promise<AnalysisCanonicalWriteResult>;
    loadAuditVersions(requestId: string): Promise<readonly number[]>;
    enqueueRetry(
        requestId: string,
        family: AnalysisCanonicalWriteFamily,
    ): Promise<Readonly<{
        status: 'retry_queued' | 'blocked';
        family: AnalysisCanonicalWriteFamily;
    }>>;
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
    'providerToken',
    'provider_token',
    'accessToken',
    'access_token',
    'cookie',
    'cookies',
    'rawProviderPayload',
    'raw_provider_payload',
    'authorization',
    'secret',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertUuid(value: string, label: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
}

function assertHash(value: string, label: string): void {
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
}

function assertPayload(value: AnalysisCanonicalPayload | undefined, path = 'payload'): AnalysisCanonicalPayload {
    const payload = value ?? {};
    if (!isRecord(payload)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: ${path} must be an object.`);
    }
    const visit = (candidate: unknown, location: string): void => {
        if (Array.isArray(candidate)) {
            candidate.forEach((item, index) => visit(item, `${location}[${index}]`));
            return;
        }
        if (!isRecord(candidate)) return;
        for (const [key, child] of Object.entries(candidate)) {
            if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
                throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: forbidden payload key ${key}.`);
            }
            visit(child, `${location}.${key}`);
        }
    };
    visit(payload, path);
    return payload;
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value instanceof Date) return value.toISOString();
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, stableValue(value[key])])
        );
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
}

export function stableAnalysisCanonicalJson(value: unknown): string {
    const stable = JSON.stringify(stableValue(value));
    if (stable === undefined) {
        throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: value is not serializable.');
    }
    return stable;
}

export function hashAnalysisCanonicalValue(value: unknown): string {
    return createHash('sha256')
        .update(SHA256_DOMAIN, 'utf8')
        .update(stableAnalysisCanonicalJson(value), 'utf8')
        .digest('hex');
}

function asRpcDate(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid date.');
        }
        return value.toISOString();
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid date.');
    }
    return value;
}

function flagEnabled(value: string | undefined): boolean {
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
        || value?.toLowerCase() === 'on';
}

export function analysisCanonicalWriteEnabled(
    family: AnalysisCanonicalWriteFamily,
    env: Record<string, string | undefined> = process.env,
): boolean {
    return flagEnabled(env[ANALYSIS_CANONICAL_WRITE_FLAGS[family]]);
}

function ensureInteger(value: number | undefined, label: string, min: number, max: number): number {
    const resolved = value ?? 0;
    if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
    return resolved;
}

function ensureFiniteNonNegative(value: number | null, label: string): void {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
}

function errorMessage(error: RpcError | null): string {
    return error?.message || error?.code || 'canonical RPC failed';
}

interface AnalysisCanonicalRetryMarker {
    id: number;
    request_id: string;
    kind: 'operational';
    state: 'canonical_retry';
    payload: {
        family: AnalysisCanonicalWriteFamily;
        retryKey: string;
    };
    content_hash: string;
    retention_class: 'standard';
    created_at: string;
}

function expectedRetryMarkerHash(requestId: string, family: AnalysisCanonicalWriteFamily): string {
    return createHash('sha256').update(`${requestId}:${family}`, 'utf8').digest('hex');
}

function parseRetryMarker(
    value: unknown,
    requestId: string,
    family: AnalysisCanonicalWriteFamily,
): AnalysisCanonicalRetryMarker {
    if (!isRecord(value)) throw new Error('invalid retry marker');
    const payload = value.payload;
    if (
        typeof value.id !== 'number'
        || !Number.isSafeInteger(value.id)
        || value.id < 1
        || value.request_id !== requestId
        || value.kind !== 'operational'
        || value.state !== 'canonical_retry'
        || !isRecord(payload)
        || payload.family !== family
        || payload.retryKey !== `${requestId}:${family}`
        || value.content_hash !== expectedRetryMarkerHash(requestId, family)
        || value.retention_class !== 'standard'
        || typeof value.created_at !== 'string'
        || !Number.isFinite(Date.parse(value.created_at))
    ) {
        throw new Error('invalid retry marker');
    }
    return {
        id: value.id,
        request_id: value.request_id,
        kind: 'operational',
        state: 'canonical_retry',
        payload: { family, retryKey: `${requestId}:${family}` },
        content_hash: value.content_hash,
        retention_class: 'standard',
        created_at: value.created_at,
    };
}

function parseLateCostAuditVersion(value: unknown): number {
    if (!isRecord(value)) throw new Error('invalid late cost audit response');
    const version = value.version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 100_000) {
        throw new Error('invalid late cost audit version');
    }
    return version;
}

export function createAnalysisCanonicalStore(
    client: AnalysisCanonicalSupabaseClient = supabaseAdmin,
    options: { env?: Record<string, string | undefined> } = {},
): AnalysisCanonicalStore {
    const env = options.env ?? process.env;

    async function enqueueRetry(
        requestId: string,
        family: AnalysisCanonicalWriteFamily,
    ): Promise<Readonly<{
        status: 'retry_queued' | 'blocked';
        family: AnalysisCanonicalWriteFamily;
    }>> {
        assertUuid(requestId, 'request id');
        try {
            const result = await client.rpc('enqueue_analysis_canonical_retry', {
                p_request_id: requestId,
                p_family: family,
            });
            if (result.error) return { status: 'blocked', family };
            parseRetryMarker(result.data, requestId, family);
            return { status: 'retry_queued', family };
        } catch {
            return { status: 'blocked', family };
        }
    }

    async function write(
        family: AnalysisCanonicalWriteFamily,
        requestId: string | null,
        rpcName: string,
        params: Record<string, unknown>,
    ): Promise<AnalysisCanonicalWriteResult> {
        if (!analysisCanonicalWriteEnabled(family, env)) return { status: 'disabled' };
        if (requestId !== null) assertUuid(requestId, 'request id');
        try {
            const result = await client.rpc(rpcName, params);
            if (result.error) throw new Error(errorMessage(result.error));
            return { status: 'appended' };
        } catch {
            return requestId === null
                ? { status: 'blocked', family }
                : enqueueRetry(requestId, family);
        }
    }

    return {
        async loadAuditVersions(requestId) {
            assertUuid(requestId, 'request id');
            const result = await client.rpc('load_analysis_canonical_family', {
                p_request_id: requestId,
                p_family: 'audit',
            });
            if (result.error) throw new Error(errorMessage(result.error));
            if (!isRecord(result.data)) {
                throw new Error('ANALYSIS_CANONICAL_PERSISTENCE_ERROR: invalid audit load.');
            }
            const rows = result.data.audits;
            if (!Array.isArray(rows) || rows.length > 100) {
                throw new Error('ANALYSIS_CANONICAL_PERSISTENCE_ERROR: invalid audit load.');
            }
            const versions = rows.map(row => {
                if (!isRecord(row)) {
                    throw new Error('ANALYSIS_CANONICAL_PERSISTENCE_ERROR: invalid audit row.');
                }
                for (const field of [
                    'id', 'request_id', 'version', 'kind', 'candidate_key', 'ordinal', 'state',
                    'content_hash', 'retention_class', 'payload', 'created_at',
                ]) {
                    if (!Object.prototype.hasOwnProperty.call(row, field)) {
                        throw new Error('ANALYSIS_CANONICAL_PERSISTENCE_ERROR: invalid audit row.');
                    }
                }
                return ensureInteger(
                    typeof row.version === 'number' ? row.version : undefined,
                    'audit version',
                    1,
                    100_000,
                );
            });
            return Object.freeze(versions);
        },

        async recordJob(input) {
            assertUuid(input.requestId, 'request id');
            if (!JOB_KEY_PATTERN.test(input.jobKey)) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid job key.');
            }
            const payload = assertPayload(input.payload);
            const generation = ensureInteger(input.generation, 'generation', 0, 9_000_000_000);
            const attemptCount = ensureInteger(input.attemptCount, 'attempt count', 0, 1_000);
            const dependencyCount = ensureInteger(input.dependencyCount, 'dependency count', 0, 9_000_000_000);
            if (input.completionHash !== undefined && input.completionHash !== null) {
                assertHash(input.completionHash, 'completion hash');
            }
            return write('jobs', input.requestId, 'record_analysis_canonical_job', {
                p_request_id: input.requestId,
                p_job_key: input.jobKey,
                p_kind: input.kind,
                p_state: input.state,
                p_generation: generation,
                p_attempt_count: attemptCount,
                p_dependency_count: dependencyCount,
                p_next_attempt_at: asRpcDate(input.nextAttemptAt) ?? new Date().toISOString(),
                p_lease_expires_at: asRpcDate(input.leaseExpiresAt),
                p_completion_hash: input.completionHash ?? null,
                p_payload: payload,
                p_retention_class: input.retentionClass ?? 'standard',
            });
        },

        async appendEvent(input) {
            assertUuid(input.requestId, 'request id');
            if (input.jobId !== undefined && input.jobId !== null) assertUuid(input.jobId, 'job id');
            const payload = assertPayload(input.payload);
            const contentHash = input.contentHash ?? hashAnalysisCanonicalValue({
                requestId: input.requestId,
                jobId: input.jobId ?? null,
                kind: input.kind,
                state: input.state,
                payload,
            });
            assertHash(contentHash, 'content hash');
            return write('evidence', input.requestId, 'append_analysis_canonical_event', {
                p_request_id: input.requestId,
                p_job_id: input.jobId ?? null,
                p_kind: input.kind,
                p_state: input.state,
                p_payload: payload,
                p_content_hash: contentHash,
                p_retention_class: input.retentionClass ?? 'standard',
            });
        },

        async appendArtifact(input) {
            assertUuid(input.requestId, 'request id');
            if (input.jobId !== undefined && input.jobId !== null) assertUuid(input.jobId, 'job id');
            if (input.artifactKey.length < 1 || input.artifactKey.length > 512) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid artifact key.');
            }
            const payload = assertPayload(input.payload);
            const contentHash = input.contentHash ?? hashAnalysisCanonicalValue({
                requestId: input.requestId,
                artifactKey: input.artifactKey,
                kind: input.kind,
                payload,
            });
            assertHash(contentHash, 'content hash');
            return write('evidence', input.requestId, 'append_analysis_canonical_artifact', {
                p_request_id: input.requestId,
                p_job_id: input.jobId ?? null,
                p_kind: input.kind,
                p_artifact_key: input.artifactKey,
                p_state: input.state,
                p_content_hash: contentHash,
                p_payload: payload,
                p_retention_class: input.retentionClass,
            });
        },

        async appendCost(input) {
            assertUuid(input.requestId, 'request id');
            if (!input.provider || input.provider.length > 128 || !input.operationKey || input.operationKey.length > 512) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid cost identity.');
            }
            ensureFiniteNonNegative(input.amountKnown, 'known amount');
            ensureFiniteNonNegative(input.amountConservative, 'conservative amount');
            if (input.usageUnknown && input.amountKnown !== null) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: unknown usage must not have a known amount.');
            }
            if (
                input.amountKnown !== null
                && input.amountConservative !== null
                && input.amountConservative < input.amountKnown
            ) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: conservative amount is below known amount.');
            }
            const payload = assertPayload(input.payload);
            const sourceHash = input.sourceHash ?? hashAnalysisCanonicalValue({
                requestId: input.requestId,
                provider: input.provider,
                operationKey: input.operationKey,
                stage: input.stage,
                amountKnown: input.amountKnown,
                amountConservative: input.amountConservative,
                usageUnknown: input.usageUnknown,
                payload,
            });
            assertHash(sourceHash, 'source hash');
            if (!analysisCanonicalWriteEnabled('cost', env)) {
                return { status: 'disabled', usageUnknown: input.usageUnknown };
            }
            try {
                const result = await client.rpc('append_analysis_canonical_cost', {
                    p_request_id: input.requestId,
                    p_provider: input.provider,
                    p_operation_key: input.operationKey,
                    p_stage: input.stage,
                    p_currency: input.currency ?? 'USD',
                    p_amount_known: input.amountKnown,
                    p_amount_conservative: input.amountConservative,
                    p_usage_unknown: input.usageUnknown,
                    p_source_hash: sourceHash,
                    p_payload: payload,
                    p_retention_class: input.retentionClass ?? 'permanent',
                });
                if (result.error) throw new Error(errorMessage(result.error));
                return { status: 'appended', usageUnknown: input.usageUnknown };
            } catch {
                const retry = await enqueueRetry(input.requestId, 'cost');
                return {
                    status: retry.status,
                    family: 'cost',
                    usageUnknown: input.usageUnknown,
                };
            }
        },

        async appendLateCostAudit(input) {
            assertUuid(input.requestId, 'request id');
            if (!input.provider || input.provider.length > 128 || !input.operationKey || input.operationKey.length > 512) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid cost identity.');
            }
            ensureFiniteNonNegative(input.amountKnown, 'known amount');
            ensureFiniteNonNegative(input.amountConservative, 'conservative amount');
            if (input.usageUnknown && input.amountKnown !== null) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: unknown usage must not have a known amount.');
            }
            if (
                input.amountKnown !== null
                && input.amountConservative !== null
                && input.amountConservative < input.amountKnown
            ) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: conservative amount is below known amount.');
            }
            const costPayload = assertPayload(input.costPayload, 'costPayload');
            const auditPayload = assertPayload(input.auditPayload, 'auditPayload');
            const sourceHash = input.sourceHash ?? hashAnalysisCanonicalValue({
                requestId: input.requestId,
                provider: input.provider,
                operationKey: input.operationKey,
                stage: input.stage,
                amountKnown: input.amountKnown,
                amountConservative: input.amountConservative,
                usageUnknown: input.usageUnknown,
                payload: costPayload,
            });
            assertHash(sourceHash, 'source hash');
            if (
                !analysisCanonicalWriteEnabled('cost', env)
                || !analysisCanonicalWriteEnabled('audit', env)
            ) {
                return { status: 'disabled', usageUnknown: input.usageUnknown };
            }
            const auditContentHash = hashAnalysisCanonicalValue({
                requestId: input.requestId,
                kind: 'bundle',
                state: 'complete',
                payload: auditPayload,
            });
            try {
                const result = await client.rpc('append_analysis_canonical_late_cost_audit', {
                    p_request_id: input.requestId,
                    p_provider: input.provider,
                    p_operation_key: input.operationKey,
                    p_stage: input.stage,
                    p_currency: input.currency ?? 'USD',
                    p_amount_known: input.amountKnown,
                    p_amount_conservative: input.amountConservative,
                    p_usage_unknown: input.usageUnknown,
                    p_source_hash: sourceHash,
                    p_cost_payload: costPayload,
                    p_cost_retention_class: input.costRetentionClass ?? 'permanent',
                    p_audit_content_hash: auditContentHash,
                    p_audit_payload: auditPayload,
                    p_audit_retention_class: input.auditRetentionClass ?? 'permanent',
                });
                if (result.error) throw new Error(errorMessage(result.error));
                const version = parseLateCostAuditVersion(result.data);
                return { status: 'appended', usageUnknown: input.usageUnknown, version };
            } catch {
                const retry = await enqueueRetry(input.requestId, 'audit');
                return {
                    status: retry.status,
                    family: 'audit',
                    usageUnknown: input.usageUnknown,
                };
            }
        },

        async upsertCache(input) {
            const payload = assertPayload(input.payload);
            assertHash(input.cacheKeyHash, 'cache key hash');
            if (input.singleFlightTokenHash !== undefined && input.singleFlightTokenHash !== null) {
                assertHash(input.singleFlightTokenHash, 'single-flight token hash');
            }
            const expiresAt = asRpcDate(input.expiresAt);
            if (!expiresAt) throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid expiry.');
            return write('cache', null, 'upsert_analysis_canonical_cache', {
                p_scope: input.scope,
                p_cache_key_hash: input.cacheKeyHash,
                p_state: input.state,
                p_expires_at: expiresAt,
                p_single_flight_token_hash: input.singleFlightTokenHash ?? null,
                p_payload: payload,
            });
        },

        async appendAuditRow(input) {
            assertUuid(input.requestId, 'request id');
            const version = ensureInteger(input.version, 'audit version', 1, 100_000);
            const payload = assertPayload(input.payload);
            const contentHash = input.contentHash ?? hashAnalysisCanonicalValue({
                requestId: input.requestId,
                version,
                kind: input.kind,
                candidateKey: input.candidateKey ?? null,
                ordinal: input.ordinal ?? null,
                state: input.state,
                payload,
            });
            assertHash(contentHash, 'content hash');
            return write('audit', input.requestId, 'append_analysis_canonical_audit', {
                p_request_id: input.requestId,
                p_version: version,
                p_kind: input.kind,
                p_candidate_key: input.candidateKey ?? null,
                p_ordinal: input.ordinal ?? null,
                p_state: input.state,
                p_content_hash: contentHash,
                p_retention_class: input.retentionClass ?? 'permanent',
                p_payload: payload,
            });
        },

        enqueueRetry,
    };
}

export const analysisCanonicalStore = createAnalysisCanonicalStore();
