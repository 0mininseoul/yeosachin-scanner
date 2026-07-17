import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    GeminiAttemptStartTelemetry,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import {
    AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX,
} from '@/lib/services/ai/gemini-generation-policy';
import {
    analysisV2AiAttemptStore,
    type AnalysisV2AiAttemptRecord,
    type AnalysisV2AiAttemptReservation,
    type AnalysisV2AiAttemptStore,
} from '@/lib/services/analysis/v2-ai-attempt-store';
import { AnalysisV2AiResultRateLimitExhaustedError } from './v2-ai-fallback-policy';
import { z } from 'zod';

export { AnalysisV2AiResultRateLimitExhaustedError } from './v2-ai-fallback-policy';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const LOCATION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const OPERATION_KEY_PATTERN = /^(gender-triage|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$/;
const MAX_HASH_MATERIAL_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 64;

export const ANALYSIS_V2_AI_RESULT_DATABASE_NAMES = Object.freeze({
    requestTable: 'analysis_v2_ai_result_checkpoints',
    globalCacheTable: 'analysis_v2_ai_global_result_cache',
    terminalizeSuccessRpc: 'terminalize_analysis_v2_ai_attempt_with_result',
    checkpointGlobalHitRpc: 'checkpoint_analysis_v2_ai_global_cache_hit',
    loadRequestRpc: 'load_analysis_v2_ai_result_checkpoint',
    purgeRequestRpc: 'purge_analysis_v2_ai_result_checkpoints',
    maintainGlobalCacheRpc: 'maintain_analysis_v2_ai_global_result_cache',
});

export const ANALYSIS_V2_AI_RESULT_STAGES = [
    'genderTriage',
    'featureAnalysis',
    'highRiskNarrative',
    'privateAccountName',
    'partnerSafety',
] as const;

export const ANALYSIS_V2_AI_RESULT_CACHE_SCOPES = ['request', 'global_ttl'] as const;

export type AnalysisV2AiResultStage = typeof ANALYSIS_V2_AI_RESULT_STAGES[number];
export type AnalysisV2AiResultCacheScope = typeof ANALYSIS_V2_AI_RESULT_CACHE_SCOPES[number];
export type AnalysisV2AiResultThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
export type AnalysisV2AiResultMediaResolution = 'LOW' | 'MEDIUM' | 'HIGH';
export type AnalysisV2AiResultUsageStatus = 'complete' | 'missing' | 'malformed';

const GLOBAL_CACHE_STAGES: ReadonlySet<AnalysisV2AiResultStage> = new Set([
    'genderTriage',
    'featureAnalysis',
]);

const OPERATION_PREFIX_BY_STAGE: Readonly<Record<AnalysisV2AiResultStage, string>> = {
    genderTriage: 'gender-triage',
    featureAnalysis: 'feature-analysis',
    highRiskNarrative: 'high-risk-narrative',
    privateAccountName: 'private-account-name',
    partnerSafety: 'partner-safety',
};

const stageSchema = z.enum(ANALYSIS_V2_AI_RESULT_STAGES);
const cacheScopeSchema = z.enum(ANALYSIS_V2_AI_RESULT_CACHE_SCOPES);
const thinkingLevelSchema = z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
const mediaResolutionSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const usageStatusSchema = z.enum(['complete', 'missing', 'malformed']);

const identityMaterialSchema = z.object({
    stage: stageSchema,
    modelName: z.string().regex(MODEL_PATTERN),
    thinkingLevel: thinkingLevelSchema.nullable(),
    mediaResolution: mediaResolutionSchema.nullable(),
    promptVersion: z.string().regex(VERSION_PATTERN),
    schemaVersion: z.number().int().min(1).max(9_999),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    inputHash: z.string().regex(SHA256_PATTERN),
    mediaSnapshotHash: z.string().regex(SHA256_PATTERN),
    cacheScope: cacheScopeSchema,
}).strict().superRefine((identity, context) => {
    if (identity.cacheScope === 'global_ttl' && !GLOBAL_CACHE_STAGES.has(identity.stage)) {
        context.addIssue({
            code: 'custom',
            path: ['cacheScope'],
            message: 'Only classification stages permit global cache reuse.',
        });
    }
});

const computedIdentitySchema = identityMaterialSchema.safeExtend({
    cacheKey: z.string().regex(SHA256_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
});

const tokenUsageSchema = z.object({
    promptTokens: z.number().int().min(0).max(100_000_000),
    completionTokens: z.number().int().min(0).max(100_000_000),
    totalTokens: z.number().int().min(0).max(100_000_000),
    thinkingTokens: z.number().int().min(0).max(100_000_000),
}).strict().superRefine((usage, context) => {
    if (usage.totalTokens !== (
        usage.promptTokens + usage.completionTokens + usage.thinkingTokens
    )) {
        context.addIssue({
            code: 'custom',
            path: ['totalTokens'],
            message: 'Total tokens must equal prompt, completion, and thinking tokens.',
        });
    }
});

const terminalInputSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    claimToken: z.string().regex(UUID_PATTERN),
    resultIdentity: computedIdentitySchema,
    attempt: z.number().int().min(1).max(4),
    retryCount: z.number().int().min(0).max(3),
    reservationToken: z.string().regex(UUID_PATTERN),
    location: z.string().regex(LOCATION_PATTERN),
    mediaCount: z.number().int().min(0).max(11),
    usageMetadataStatus: usageStatusSchema,
    usageComplete: z.boolean(),
    tokenUsage: tokenUsageSchema.nullable(),
    latencyMs: z.number().int().min(0).max(3_600_000),
    estimatedCostUsd: z.number().finite().min(0).max(999.999999999999).nullable(),
    finishReason: z.literal('STOP'),
    result: z.unknown(),
}).strict().superRefine((input, context) => {
    if (input.retryCount !== input.attempt - 1) {
        context.addIssue({
            code: 'custom',
            path: ['retryCount'],
            message: 'Retry count must equal attempt minus one.',
        });
    }
    if (input.usageMetadataStatus === 'complete') {
        if (!input.usageComplete || input.tokenUsage === null) {
            context.addIssue({
                code: 'custom',
                path: ['tokenUsage'],
                message: 'Complete usage requires complete token telemetry.',
            });
        }
    } else if (
        input.usageComplete
        || input.tokenUsage !== null
        || input.estimatedCostUsd !== null
    ) {
        context.addIssue({
            code: 'custom',
            path: ['usageMetadataStatus'],
            message: 'Unknown usage cannot contain token or cost estimates.',
        });
    }
});

const requestIdentitySchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    claimToken: z.string().regex(UUID_PATTERN),
    resultIdentity: computedIdentitySchema,
}).strict();

const loadIdentitySchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    resultIdentity: computedIdentitySchema,
}).strict();

const rawCheckpointSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
    cacheKey: z.string().regex(SHA256_PATTERN),
    stage: stageSchema,
    modelName: z.string().regex(MODEL_PATTERN),
    thinkingLevel: thinkingLevelSchema.nullable(),
    mediaResolution: mediaResolutionSchema.nullable(),
    promptVersion: z.string().regex(VERSION_PATTERN),
    schemaVersion: z.number().int().min(1).max(9_999),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    inputHash: z.string().regex(SHA256_PATTERN),
    mediaSnapshotHash: z.string().regex(SHA256_PATTERN),
    cacheScope: cacheScopeSchema,
    source: z.enum(['generated', 'global_cache']),
    attempt: z.number().int().min(1).max(4).nullable(),
    reservationToken: z.string().regex(UUID_PATTERN).nullable(),
    result: z.unknown(),
    resultHash: z.string().regex(SHA256_PATTERN),
    chargeStatus: z.enum(['generated_complete', 'generated_unknown', 'cache_hit']),
    usageMetadataStatus: usageStatusSchema.nullable(),
    usageComplete: z.boolean().nullable(),
    tokenUsage: tokenUsageSchema.nullable(),
    latencyMs: z.number().int().min(0).max(3_600_000).nullable(),
    estimatedCostUsd: z.number().finite().min(0).max(999.999999999999).nullable(),
    finishReason: z.literal('STOP').nullable(),
    createdAt: z.string().datetime({ offset: true }),
}).strict();

const terminalizedCheckpointEnvelopeSchema = z.object({
    outcome: z.literal('checkpointed'),
    checkpoint: rawCheckpointSchema,
}).strict();

const terminalizedFenceEnvelopeSchema = z.object({
    outcome: z.literal('fenced'),
    requestId: z.string().regex(UUID_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
    attempt: z.number().int().min(1).max(4),
    reservationToken: z.string().regex(UUID_PATTERN),
}).strict();

const cacheMaintenanceSchema = z.object({
    acquired: z.boolean(),
    deletedExpired: z.number().int().min(0).max(100_000),
    deletedOverflow: z.number().int().min(0).max(100_000),
}).strict();

export interface AnalysisV2AiResultIdentityMaterial {
    stage: AnalysisV2AiResultStage;
    modelName: string;
    thinkingLevel: AnalysisV2AiResultThinkingLevel | null;
    mediaResolution: AnalysisV2AiResultMediaResolution | null;
    promptVersion: string;
    schemaVersion: number;
    maxOutputTokens: number;
    inputHash: string;
    mediaSnapshotHash: string;
    cacheScope: AnalysisV2AiResultCacheScope;
}

export interface AnalysisV2AiResultIdentity extends AnalysisV2AiResultIdentityMaterial {
    cacheKey: string;
    operationKey: string;
}

export interface AnalysisV2AiResultTokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    thinkingTokens: number;
}

export interface AnalysisV2AiResultTerminalInput<T> {
    requestId: string;
    jobKey: string;
    claimToken: string;
    resultIdentity: AnalysisV2AiResultIdentity;
    attempt: number;
    retryCount: number;
    reservationToken: string;
    location: string;
    mediaCount: number;
    usageMetadataStatus: AnalysisV2AiResultUsageStatus;
    usageComplete: boolean;
    tokenUsage: AnalysisV2AiResultTokenUsage | null;
    latencyMs: number;
    estimatedCostUsd: number | null;
    finishReason: 'STOP';
    result: T;
}

export interface AnalysisV2AiResultCheckpoint<T> extends AnalysisV2AiResultIdentity {
    requestId: string;
    jobKey: string;
    source: 'generated' | 'global_cache';
    attempt: number | null;
    reservationToken: string | null;
    result: T;
    resultHash: string;
    chargeStatus: 'generated_complete' | 'generated_unknown' | 'cache_hit';
    usageMetadataStatus: AnalysisV2AiResultUsageStatus | null;
    usageComplete: boolean | null;
    tokenUsage: AnalysisV2AiResultTokenUsage | null;
    latencyMs: number | null;
    estimatedCostUsd: number | null;
    finishReason: 'STOP' | null;
    createdAt: string;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2AiResultSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2AiResultStore {
    terminalizeSuccess<T>(
        input: AnalysisV2AiResultTerminalInput<T>,
        resultSchema: z.ZodType<T>
    ): Promise<AnalysisV2AiResultCheckpoint<T>>;
    checkpointGlobalHit<T>(
        input: {
            requestId: string;
            jobKey: string;
            claimToken: string;
            resultIdentity: AnalysisV2AiResultIdentity;
        },
        resultSchema: z.ZodType<T>
    ): Promise<AnalysisV2AiResultCheckpoint<T> | null>;
    loadRequest<T>(
        input: {
            requestId: string;
            resultIdentity: AnalysisV2AiResultIdentity;
        },
        resultSchema: z.ZodType<T>
    ): Promise<AnalysisV2AiResultCheckpoint<T> | null>;
    purgeRequestResults(requestId: string): Promise<number>;
    maintainGlobalCache(deleteLimit?: number): Promise<{
        acquired: boolean;
        deletedExpired: number;
        deletedOverflow: number;
    }>;
}

export interface AnalysisV2AiPreparedResult<T> {
    result: T | null;
    source: 'request' | 'global_cache' | null;
    startingAttempt: number;
}

export interface AnalysisV2AiAuditAdapter<T> {
    requestId: string;
    operationKey: string;
    resultIdentity: AnalysisV2AiResultIdentity;
    /** Checkpoint/cache recovery and durable retry resumption must run before any provider call. */
    prepare(): Promise<AnalysisV2AiPreparedResult<T>>;
    /** Reserve the paid generation attempt before the Gemini SDK call. */
    onBeforeAttempt(telemetry: GeminiAttemptStartTelemetry): Promise<void>;
    /** Atomically stores a successful parsed result, or terminalizes a non-success attempt. */
    onAttemptTelemetry(
        telemetry: GeminiAttemptTelemetry,
        parsedResult?: unknown
    ): Promise<void>;
    resultSchema: z.ZodType<T>;
}

export interface CreateAnalysisV2AiAuditAdapterOptions<T> {
    requestId: string;
    jobKey: string;
    claimToken: string;
    resultIdentity: AnalysisV2AiResultIdentity;
    resultSchema: z.ZodType<T>;
    attemptStore?: AnalysisV2AiAttemptStore;
    resultStore?: AnalysisV2AiResultStore;
}

export class AnalysisV2AiResultConflictError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_RESULT_CONFLICT');
        this.name = 'AnalysisV2AiResultConflictError';
    }
}

export class AnalysisV2AiResultFenceError extends Error {
    constructor(public readonly telemetryCommitted = false) {
        super('ANALYSIS_V2_AI_RESULT_FENCE_MISMATCH');
        this.name = 'AnalysisV2AiResultFenceError';
    }
}

export class AnalysisV2AiResultReplayBlockedError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_RESULT_REPLAY_BLOCKED');
        this.name = 'AnalysisV2AiResultReplayBlockedError';
    }
}

export class AnalysisV2AiResultNotReadyError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_RESULT_NOT_READY');
        this.name = 'AnalysisV2AiResultNotReadyError';
    }
}

function sha256(domain: string, material: string): string {
    if (
        material.length === 0
        || Buffer.byteLength(material, 'utf8') > MAX_HASH_MATERIAL_BYTES
    ) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid hash material.');
    }
    return createHash('sha256')
        .update(domain, 'utf8')
        .update('\0', 'utf8')
        .update(material, 'utf8')
        .digest('hex');
}

/** Hashes canonical model input without retaining prompts, usernames, captions, or evidence. */
export function createAnalysisV2AiResultInputHash(canonicalInput: string): string {
    return sha256('analysis-v2-ai-result-input:v1', canonicalInput);
}

/** Hashes the ordered, normalized media selection without retaining URLs or image bytes. */
export function createAnalysisV2AiMediaSnapshotHash(canonicalSnapshot: string): string {
    return sha256('analysis-v2-ai-media-snapshot:v1', canonicalSnapshot);
}

export interface AnalysisV2AiIdentityMediaPart {
    selectionId: string;
    kind: 'profile' | 'feed' | 'contact_sheet';
    normalizedJpegBase64: string;
    postId?: string | null;
}

/** Hashes actual ordered normalized media bytes plus the selection manifest without retaining it. */
export function createAnalysisV2AiMediaSnapshotHashFromParts(
    media: readonly AnalysisV2AiIdentityMediaPart[]
): string {
    const manifest = media.map((item, index) => {
        if (
            typeof item.selectionId !== 'string'
            || item.selectionId.length < 1
            || item.selectionId.length > 240
            || typeof item.normalizedJpegBase64 !== 'string'
            || item.normalizedJpegBase64.length < 4
        ) {
            throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid identity media.');
        }
        const contentHash = createHash('sha256')
            .update('analysis-v2-ai-normalized-media-content:v1\0', 'utf8')
            .update(item.normalizedJpegBase64, 'utf8')
            .digest('hex');
        return {
            index,
            selectionId: item.selectionId,
            kind: item.kind,
            postId: item.postId ?? null,
            contentHash,
        };
    });
    return createAnalysisV2AiMediaSnapshotHash(JSON.stringify(manifest));
}

export function createAnalysisV2AiResultContentHash(canonicalResultJson: string): string {
    return sha256('analysis-v2-ai-result-content:v1', canonicalResultJson);
}

function parseIdentityMaterial(
    value: AnalysisV2AiResultIdentityMaterial
): AnalysisV2AiResultIdentityMaterial {
    const parsed = identityMaterialSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid result identity.');
    }
    return parsed.data;
}

function canonicalCacheIdentity(identity: AnalysisV2AiResultIdentityMaterial): string {
    return [
        'analysis-v2-ai-result-cache:v1',
        identity.stage,
        identity.modelName,
        identity.thinkingLevel ?? '-',
        identity.mediaResolution ?? '-',
        identity.promptVersion,
        String(identity.schemaVersion),
        String(identity.maxOutputTokens),
        identity.inputHash,
        identity.mediaSnapshotHash,
    ].join('\n');
}

/**
 * Produces the exact policy/input/media identity shared by request checkpoints and cache rows.
 * Only the digest is suitable for persistence; raw hash material must remain in memory.
 */
export function createAnalysisV2AiResultIdentity(
    value: AnalysisV2AiResultIdentityMaterial
): AnalysisV2AiResultIdentity {
    const identity = parseIdentityMaterial(value);
    const cacheKey = createHash('sha256')
        .update(canonicalCacheIdentity(identity), 'utf8')
        .digest('hex');
    return {
        ...identity,
        cacheKey,
        operationKey: `${OPERATION_PREFIX_BY_STAGE[identity.stage]}:${cacheKey}`,
    };
}

function assertComputedIdentity(value: AnalysisV2AiResultIdentity): AnalysisV2AiResultIdentity {
    const parsed = computedIdentitySchema.safeParse(value);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid computed identity.');
    }
    const expected = createAnalysisV2AiResultIdentity({
        stage: parsed.data.stage,
        modelName: parsed.data.modelName,
        thinkingLevel: parsed.data.thinkingLevel,
        mediaResolution: parsed.data.mediaResolution,
        promptVersion: parsed.data.promptVersion,
        schemaVersion: parsed.data.schemaVersion,
        maxOutputTokens: parsed.data.maxOutputTokens,
        inputHash: parsed.data.inputHash,
        mediaSnapshotHash: parsed.data.mediaSnapshotHash,
        cacheScope: parsed.data.cacheScope,
    });
    if (
        parsed.data.cacheKey !== expected.cacheKey
        || parsed.data.operationKey !== expected.operationKey
    ) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid computed identity.');
    }
    return parsed.data;
}

function identityPayload(identity: AnalysisV2AiResultIdentity): Record<string, unknown> {
    return {
        stage: identity.stage,
        model_name: identity.modelName,
        thinking_level: identity.thinkingLevel,
        media_resolution: identity.mediaResolution,
        prompt_version: identity.promptVersion,
        schema_version: identity.schemaVersion,
        max_output_tokens: identity.maxOutputTokens,
        input_hash: identity.inputHash,
        media_snapshot_hash: identity.mediaSnapshotHash,
        cache_scope: identity.cacheScope,
    };
}

function telemetryPayload(
    input: Omit<AnalysisV2AiResultTerminalInput<unknown>, 'result'>
): Record<string, unknown> {
    return {
        model_name: input.resultIdentity.modelName,
        location: input.location,
        stage: input.resultIdentity.stage,
        thinking_level: input.resultIdentity.thinkingLevel,
        media_count: input.mediaCount,
        media_resolution: input.resultIdentity.mediaResolution,
        prompt_version: input.resultIdentity.promptVersion,
        schema_version: input.resultIdentity.schemaVersion,
        max_output_tokens: input.resultIdentity.maxOutputTokens,
        retry_count: input.retryCount,
        usage_metadata_status: input.usageMetadataStatus,
        usage_complete: input.usageComplete,
        prompt_tokens: input.tokenUsage?.promptTokens ?? null,
        completion_tokens: input.tokenUsage?.completionTokens ?? null,
        total_tokens: input.tokenUsage?.totalTokens ?? null,
        thinking_tokens: input.tokenUsage?.thinkingTokens ?? null,
        latency_ms: input.latencyMs,
        estimated_cost_usd: input.estimatedCostUsd,
        finish_reason: input.finishReason,
    };
}

function canonicalJson(value: unknown, depth = 0): unknown {
    if (depth > MAX_JSON_DEPTH) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is too deeply nested.');
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is not JSON.');
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => canonicalJson(item, depth + 1));
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (record[key] === undefined) {
                throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is not JSON.');
            }
            output[key] = canonicalJson(record[key], depth + 1);
        }
        return output;
    }
    throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is not JSON.');
}

function validatedResult<T>(value: unknown, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result schema rejected.');
    }
    const canonical = canonicalJson(parsed.data);
    if (
        canonical === null
        || typeof canonical !== 'object'
        || Array.isArray(canonical)
    ) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result must be an object.');
    }
    const serialized = JSON.stringify(canonical);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is too large.');
    }
    const reparsed = schema.safeParse(canonical);
    if (!reparsed.success) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is not stable JSON.');
    }
    return reparsed.data;
}

function canonicalResultEnvelope(value: unknown): {
    canonicalResult: unknown;
    canonicalResultJson: string;
    resultHash: string;
} {
    const canonicalResult = canonicalJson(value);
    if (
        canonicalResult === null
        || typeof canonicalResult !== 'object'
        || Array.isArray(canonicalResult)
    ) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result must be an object.');
    }
    const canonicalResultJson = JSON.stringify(canonicalResult);
    if (Buffer.byteLength(canonicalResultJson, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: result is too large.');
    }
    return {
        canonicalResult,
        canonicalResultJson,
        resultHash: createAnalysisV2AiResultContentHash(canonicalResultJson),
    };
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function sameTokenUsage(
    left: AnalysisV2AiResultTokenUsage | null,
    right: AnalysisV2AiResultTokenUsage | null
): boolean {
    if (left === null || right === null) return left === right;
    return left.promptTokens === right.promptTokens
        && left.completionTokens === right.completionTokens
        && left.totalTokens === right.totalTokens
        && left.thinkingTokens === right.thinkingTokens;
}

export function analysisV2AiResultIdentitiesEqual(
    checkpoint: AnalysisV2AiResultIdentity,
    expected: AnalysisV2AiResultIdentity
): boolean {
    return checkpoint.operationKey === expected.operationKey
        && checkpoint.cacheKey === expected.cacheKey
        && checkpoint.stage === expected.stage
        && checkpoint.modelName === expected.modelName
        && checkpoint.thinkingLevel === expected.thinkingLevel
        && checkpoint.mediaResolution === expected.mediaResolution
        && checkpoint.promptVersion === expected.promptVersion
        && checkpoint.schemaVersion === expected.schemaVersion
        && checkpoint.maxOutputTokens === expected.maxOutputTokens
        && checkpoint.inputHash === expected.inputHash
        && checkpoint.mediaSnapshotHash === expected.mediaSnapshotHash
        && checkpoint.cacheScope === expected.cacheScope;
}

function parseCheckpoint<T>(
    data: unknown,
    expected: {
        requestId: string;
        resultIdentity: AnalysisV2AiResultIdentity;
        jobKey?: string;
    },
    resultSchema: z.ZodType<T>,
    label: string
): AnalysisV2AiResultCheckpoint<T> {
    const raw = rawCheckpointSchema.safeParse(data);
    if (!raw.success) {
        throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid ${label} response.`);
    }
    const result = validatedResult(raw.data.result, resultSchema);
    const envelope = canonicalResultEnvelope(result);
    if (envelope.resultHash !== raw.data.resultHash) {
        throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid ${label} result hash.`);
    }
    const checkpoint: AnalysisV2AiResultCheckpoint<T> = {
        ...raw.data,
        result,
    };
    if (
        checkpoint.requestId !== expected.requestId.toLowerCase()
        || (expected.jobKey !== undefined && checkpoint.jobKey !== expected.jobKey)
        || !analysisV2AiResultIdentitiesEqual(checkpoint, expected.resultIdentity)
    ) {
        throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: ${label} metadata drift.`);
    }
    if (checkpoint.source === 'global_cache') {
        if (
            checkpoint.cacheScope !== 'global_ttl'
            || !GLOBAL_CACHE_STAGES.has(checkpoint.stage)
            || checkpoint.attempt !== null
            || checkpoint.reservationToken !== null
            || checkpoint.chargeStatus !== 'cache_hit'
            || checkpoint.usageMetadataStatus !== null
            || checkpoint.usageComplete !== null
            || checkpoint.tokenUsage !== null
            || checkpoint.latencyMs !== null
            || checkpoint.estimatedCostUsd !== null
            || checkpoint.finishReason !== null
        ) {
            throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid ${label} cache response.`);
        }
    } else {
        if (
            checkpoint.attempt === null
            || checkpoint.reservationToken === null
            || checkpoint.usageMetadataStatus === null
            || checkpoint.usageComplete === null
            || checkpoint.latencyMs === null
            || checkpoint.finishReason !== 'STOP'
        ) {
            throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid ${label} generation response.`);
        }
        if (checkpoint.usageMetadataStatus === 'complete') {
            if (
                checkpoint.chargeStatus !== 'generated_complete'
                || !checkpoint.usageComplete
                || checkpoint.tokenUsage === null
            ) {
                throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid ${label} usage response.`);
            }
        } else if (
            checkpoint.chargeStatus !== 'generated_unknown'
            || checkpoint.usageComplete
            || checkpoint.tokenUsage !== null
            || checkpoint.estimatedCostUsd !== null
        ) {
            throw new Error(`ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid ${label} usage response.`);
        }
    }
    return checkpoint;
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_AI_RESULT_CONFLICT') {
        throw new AnalysisV2AiResultConflictError();
    }
    if (
        error.message === 'ANALYSIS_V2_AI_RESULT_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_AI_ATTEMPT_JOB_FENCE_MISMATCH'
    ) {
        throw new AnalysisV2AiResultFenceError();
    }
    if (
        error.message === 'ANALYSIS_V2_AI_RESULT_NOT_READY'
        || error.message === 'ANALYSIS_V2_AI_ATTEMPT_NOT_READY'
    ) {
        throw new AnalysisV2AiResultNotReadyError();
    }
    throw new Error(
        `ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

export function createAnalysisV2AiResultStore(
    client: AnalysisV2AiResultSupabaseClient = supabaseAdmin
): AnalysisV2AiResultStore {
    return {
        async terminalizeSuccess(input, resultSchema) {
            const canonicalResult = validatedResult(input.result, resultSchema);
            const resultEnvelope = canonicalResultEnvelope(canonicalResult);
            const parsed = terminalInputSchema.safeParse({
                ...input,
                resultIdentity: assertComputedIdentity(input.resultIdentity),
                result: canonicalResult,
            });
            if (!parsed.success) {
                throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid terminal result.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.terminalizeSuccessRpc,
                {
                    p_request_id: parsed.data.requestId.toLowerCase(),
                    p_job_key: parsed.data.jobKey,
                    p_claim_token: parsed.data.claimToken.toLowerCase(),
                    p_operation_key: parsed.data.resultIdentity.operationKey,
                    p_attempt: parsed.data.attempt,
                    p_reservation_token: parsed.data.reservationToken.toLowerCase(),
                    p_telemetry: telemetryPayload(parsed.data),
                    p_result_identity: identityPayload(parsed.data.resultIdentity),
                    p_result: resultEnvelope.canonicalResult,
                    p_result_canonical: resultEnvelope.canonicalResultJson,
                    p_result_hash: resultEnvelope.resultHash,
                }
            );
            if (error) throwRpcError(error, 'success terminalization');
            const fenced = terminalizedFenceEnvelopeSchema.safeParse(data);
            if (fenced.success) {
                if (
                    fenced.data.requestId !== parsed.data.requestId.toLowerCase()
                    || fenced.data.operationKey !== parsed.data.resultIdentity.operationKey
                    || fenced.data.attempt !== parsed.data.attempt
                    || fenced.data.reservationToken
                        !== parsed.data.reservationToken.toLowerCase()
                ) {
                    throw new Error(
                        'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid fenced terminalization.'
                    );
                }
                throw new AnalysisV2AiResultFenceError(true);
            }
            const terminalized = terminalizedCheckpointEnvelopeSchema.safeParse(data);
            if (!terminalized.success) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid success terminalization response.'
                );
            }
            const checkpoint = parseCheckpoint(terminalized.data.checkpoint, {
                requestId: parsed.data.requestId,
                jobKey: parsed.data.jobKey,
                resultIdentity: parsed.data.resultIdentity,
            }, resultSchema, 'success terminalization');
            if (
                checkpoint.source !== 'generated'
                || checkpoint.attempt !== parsed.data.attempt
                || checkpoint.reservationToken !== parsed.data.reservationToken.toLowerCase()
                || checkpoint.usageMetadataStatus !== parsed.data.usageMetadataStatus
                || checkpoint.usageComplete !== parsed.data.usageComplete
                || !sameTokenUsage(checkpoint.tokenUsage, parsed.data.tokenUsage)
                || checkpoint.latencyMs !== parsed.data.latencyMs
                || checkpoint.estimatedCostUsd !== parsed.data.estimatedCostUsd
                || checkpoint.finishReason !== parsed.data.finishReason
                || checkpoint.resultHash !== resultEnvelope.resultHash
                || !sameJson(checkpoint.result, canonicalResult)
            ) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: terminal result mismatch.'
                );
            }
            return checkpoint;
        },

        async checkpointGlobalHit(input, resultSchema) {
            const parsed = requestIdentitySchema.safeParse({
                ...input,
                resultIdentity: assertComputedIdentity(input.resultIdentity),
            });
            if (!parsed.success || parsed.data.resultIdentity.cacheScope !== 'global_ttl') {
                throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid cache lookup.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.checkpointGlobalHitRpc,
                {
                    p_request_id: parsed.data.requestId.toLowerCase(),
                    p_job_key: parsed.data.jobKey,
                    p_claim_token: parsed.data.claimToken.toLowerCase(),
                    p_operation_key: parsed.data.resultIdentity.operationKey,
                    p_result_identity: identityPayload(parsed.data.resultIdentity),
                }
            );
            if (error) throwRpcError(error, 'global cache lookup');
            if (data === null) return null;
            const checkpoint = parseCheckpoint(data, {
                requestId: parsed.data.requestId,
                jobKey: parsed.data.jobKey,
                resultIdentity: parsed.data.resultIdentity,
            }, resultSchema, 'global cache lookup');
            if (checkpoint.source !== 'global_cache') {
                // A prior generated request checkpoint is also a valid replay result.
                if (checkpoint.source !== 'generated') {
                    throw new Error(
                        'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid cache lookup source.'
                    );
                }
            }
            return checkpoint;
        },

        async loadRequest(input, resultSchema) {
            const parsed = loadIdentitySchema.safeParse({
                ...input,
                resultIdentity: assertComputedIdentity(input.resultIdentity),
            });
            if (!parsed.success) {
                throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid result lookup.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.loadRequestRpc,
                {
                    p_request_id: parsed.data.requestId.toLowerCase(),
                    p_operation_key: parsed.data.resultIdentity.operationKey,
                }
            );
            if (error) throwRpcError(error, 'request result lookup');
            if (data === null) return null;
            return parseCheckpoint(data, {
                requestId: parsed.data.requestId,
                resultIdentity: parsed.data.resultIdentity,
            }, resultSchema, 'request result lookup');
        },

        async purgeRequestResults(requestId) {
            const parsedRequestId = z.string().regex(UUID_PATTERN).safeParse(requestId);
            if (!parsedRequestId.success) {
                throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid purge request.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.purgeRequestRpc,
                { p_request_id: parsedRequestId.data.toLowerCase() }
            );
            if (error) throwRpcError(error, 'request result purge');
            if (!Number.isSafeInteger(data) || (data as number) < 0) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid purge response.'
                );
            }
            return data as number;
        },

        async maintainGlobalCache(deleteLimit = 2_000) {
            if (!Number.isSafeInteger(deleteLimit) || deleteLimit < 1 || deleteLimit > 10_000) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid cache maintenance limit.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.maintainGlobalCacheRpc,
                { p_delete_limit: deleteLimit }
            );
            if (error) throwRpcError(error, 'global cache maintenance');
            const parsedMaintenance = cacheMaintenanceSchema.safeParse(data);
            if (!parsedMaintenance.success) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid cache maintenance response.'
                );
            }
            return parsedMaintenance.data;
        },
    };
}

export const analysisV2AiResultStore = createAnalysisV2AiResultStore();

function assertAuditTelemetryIdentity(
    telemetry: GeminiAttemptStartTelemetry | GeminiAttemptTelemetry,
    expected: {
        requestId: string;
        resultIdentity: AnalysisV2AiResultIdentity;
    }
): void {
    if (
        ('requestId' in telemetry && telemetry.requestId.toLowerCase()
            !== expected.requestId.toLowerCase())
        || telemetry.stage !== expected.resultIdentity.stage
        || telemetry.modelName !== expected.resultIdentity.modelName
        || telemetry.thinkingLevel !== expected.resultIdentity.thinkingLevel
        || telemetry.mediaResolution !== expected.resultIdentity.mediaResolution
        || telemetry.promptVersion !== expected.resultIdentity.promptVersion
        || telemetry.schemaVersion !== expected.resultIdentity.schemaVersion
        || telemetry.maxOutputTokens !== expected.resultIdentity.maxOutputTokens
        || telemetry.retryCount !== telemetry.attempt - 1
    ) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: audit metadata drift.');
    }
}

function completeTelemetryTokenUsage(
    telemetry: GeminiAttemptTelemetry
): AnalysisV2AiResultTokenUsage | null {
    if (telemetry.usageMetadataStatus !== 'complete') return null;
    if (!telemetry.usageComplete || telemetry.tokenUsage === null) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: incomplete usage telemetry.');
    }
    const thinkingTokens = telemetry.tokenUsage.thinkingTokens
        ?? telemetry.tokenUsage.totalTokens
            - telemetry.tokenUsage.promptTokens
            - telemetry.tokenUsage.completionTokens;
    const parsed = tokenUsageSchema.safeParse({
        ...telemetry.tokenUsage,
        thinkingTokens,
    });
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid usage telemetry.');
    }
    return parsed.data;
}

function attemptMatchesResultIdentity(
    attempt: AnalysisV2AiAttemptRecord,
    expectedJobKey: string,
    identity: AnalysisV2AiResultIdentity
): boolean {
    return attempt.jobKey === expectedJobKey
        && attempt.operationKey === identity.operationKey
        && attempt.stage === identity.stage
        && attempt.modelName === identity.modelName
        && attempt.thinkingLevel === identity.thinkingLevel
        && attempt.mediaResolution === identity.mediaResolution
        && attempt.promptVersion === identity.promptVersion
        && attempt.schemaVersion === identity.schemaVersion
        && attempt.maxOutputTokens === identity.maxOutputTokens;
}

/** Bridges staged Gemini calls to checkpoint recovery, the intent ledger, and atomic results. */
export function createAnalysisV2AiAuditAdapter<T>(
    options: CreateAnalysisV2AiAuditAdapterOptions<T>
): AnalysisV2AiAuditAdapter<T> {
    const resultIdentity = assertComputedIdentity(options.resultIdentity);
    const request = requestIdentitySchema.safeParse({
        requestId: options.requestId,
        jobKey: options.jobKey,
        claimToken: options.claimToken,
        resultIdentity,
    });
    if (!request.success) {
        throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid audit adapter.');
    }
    const attemptStore = options.attemptStore ?? analysisV2AiAttemptStore;
    const resultStore = options.resultStore ?? analysisV2AiResultStore;
    const reservations = new Map<number, AnalysisV2AiAttemptReservation>();
    let preparation: Promise<AnalysisV2AiPreparedResult<T>> | null = null;
    let expectedAttempt: number | null = null;
    let terminal = false;

    return {
        requestId: request.data.requestId.toLowerCase(),
        operationKey: resultIdentity.operationKey,
        resultIdentity,
        resultSchema: options.resultSchema,

        async prepare() {
            if (preparation) return preparation;
            preparation = (async () => {
                const checkpoint = await resultStore.loadRequest({
                    requestId: request.data.requestId,
                    resultIdentity,
                }, options.resultSchema);
                if (checkpoint) {
                    terminal = true;
                    return {
                        result: checkpoint.result,
                        source: 'request' as const,
                        startingAttempt: 1,
                    };
                }

                const attempts = await attemptStore.loadOperation({
                    requestId: request.data.requestId,
                    operationKey: resultIdentity.operationKey,
                });
                if (attempts.some(attempt => (
                    !attemptMatchesResultIdentity(attempt, request.data.jobKey, resultIdentity)
                ))) {
                    throw new AnalysisV2AiResultReplayBlockedError();
                }
                const firstAttempt = attempts[0];
                if (firstAttempt && attempts.some(attempt => (
                    attempt.location !== firstAttempt.location
                    || attempt.mediaCount !== firstAttempt.mediaCount
                ))) {
                    throw new AnalysisV2AiResultReplayBlockedError();
                }
                if (attempts.some((attempt, index) => (
                    attempt.attempt !== index + 1 || attempt.retryCount !== index
                ))) {
                    throw new AnalysisV2AiResultReplayBlockedError();
                }
                if (attempts.slice(0, -1).some(attempt => attempt.status !== 'rate_limited')) {
                    throw new AnalysisV2AiResultReplayBlockedError();
                }
                const last = attempts.at(-1);
                if (last?.status === 'response_rejected') {
                    terminal = true;
                    throw new Error(
                        `${AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX} durable response rejection.`
                    );
                }
                if (
                    attempts.length === 4
                    && attempts.every(attempt => attempt.status === 'rate_limited')
                ) {
                    terminal = true;
                    throw new AnalysisV2AiResultRateLimitExhaustedError();
                }
                if (last && last.status !== 'rate_limited') {
                    throw new AnalysisV2AiResultReplayBlockedError();
                }

                if (resultIdentity.cacheScope === 'global_ttl') {
                    const cached = await resultStore.checkpointGlobalHit({
                        requestId: request.data.requestId,
                        jobKey: request.data.jobKey,
                        claimToken: request.data.claimToken,
                        resultIdentity,
                    }, options.resultSchema);
                    if (cached) {
                        terminal = true;
                        return {
                            result: cached.result,
                            source: cached.source === 'global_cache'
                                ? 'global_cache' as const
                                : 'request' as const,
                            startingAttempt: 1,
                        };
                    }
                }

                if (!last) {
                    expectedAttempt = 1;
                } else if (last.status === 'rate_limited' && last.attempt < 4) {
                    expectedAttempt = last.attempt + 1;
                } else {
                    throw new AnalysisV2AiResultReplayBlockedError();
                }
                return {
                    result: null,
                    source: null,
                    startingAttempt: expectedAttempt,
                };
            })();
            return preparation;
        },

        async onBeforeAttempt(telemetry) {
            assertAuditTelemetryIdentity(telemetry, {
                requestId: request.data.requestId,
                resultIdentity,
            });
            if (
                terminal
                || expectedAttempt === null
                || telemetry.attempt !== expectedAttempt
                || reservations.has(telemetry.attempt)
            ) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: unexpected attempt reservation.'
                );
            }
            const reservation = await attemptStore.reserve({
                requestId: request.data.requestId,
                jobKey: request.data.jobKey,
                claimToken: request.data.claimToken,
                operationKey: resultIdentity.operationKey,
                attempt: telemetry.attempt,
                retryCount: telemetry.retryCount,
                modelName: telemetry.modelName,
                location: telemetry.location,
                stage: telemetry.stage,
                thinkingLevel: telemetry.thinkingLevel,
                mediaCount: telemetry.mediaCount,
                mediaResolution: telemetry.mediaResolution,
                promptVersion: telemetry.promptVersion,
                schemaVersion: telemetry.schemaVersion,
                maxOutputTokens: telemetry.maxOutputTokens,
            });
            if (!reservation.created || reservation.status !== 'reserved') {
                throw new AnalysisV2AiResultReplayBlockedError();
            }
            reservations.set(telemetry.attempt, reservation);
        },

        async onAttemptTelemetry(telemetry, parsedResult) {
            assertAuditTelemetryIdentity(telemetry, {
                requestId: request.data.requestId,
                resultIdentity,
            });
            const reservation = reservations.get(telemetry.attempt);
            if (!reservation) {
                throw new Error(
                    'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: missing attempt reservation.'
                );
            }
            const shared = {
                requestId: request.data.requestId,
                jobKey: request.data.jobKey,
                claimToken: request.data.claimToken,
                resultIdentity,
                attempt: telemetry.attempt,
                retryCount: telemetry.retryCount,
                reservationToken: reservation.reservationToken,
                location: telemetry.location,
                mediaCount: telemetry.mediaCount,
                usageMetadataStatus: telemetry.usageMetadataStatus,
                usageComplete: telemetry.usageComplete,
                tokenUsage: completeTelemetryTokenUsage(telemetry),
                latencyMs: telemetry.latencyMs,
                estimatedCostUsd: telemetry.estimatedCostUsd,
            };

            if (telemetry.disposition === 'success') {
                if (parsedResult === undefined || telemetry.finishReason !== 'STOP') {
                    throw new Error(
                        'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: successful result is missing.'
                    );
                }
                const strictResult = validatedResult(parsedResult, options.resultSchema);
                try {
                    await resultStore.terminalizeSuccess<T>({
                        ...shared,
                        finishReason: 'STOP',
                        result: strictResult,
                    }, options.resultSchema);
                    terminal = true;
                } catch (error) {
                    if (
                        error instanceof AnalysisV2AiResultFenceError
                        && error.telemetryCommitted
                    ) {
                        terminal = true;
                        reservations.delete(telemetry.attempt);
                    }
                    throw error;
                }
            } else {
                await attemptStore.terminalize({
                    requestId: request.data.requestId,
                    jobKey: request.data.jobKey,
                    claimToken: request.data.claimToken,
                    operationKey: resultIdentity.operationKey,
                    attempt: telemetry.attempt,
                    retryCount: telemetry.retryCount,
                    reservationToken: reservation.reservationToken,
                    modelName: resultIdentity.modelName,
                    location: telemetry.location,
                    stage: resultIdentity.stage,
                    thinkingLevel: resultIdentity.thinkingLevel,
                    mediaCount: telemetry.mediaCount,
                    mediaResolution: resultIdentity.mediaResolution,
                    promptVersion: resultIdentity.promptVersion,
                    schemaVersion: resultIdentity.schemaVersion,
                    maxOutputTokens: resultIdentity.maxOutputTokens,
                    status: telemetry.disposition,
                    usageMetadataStatus: telemetry.usageMetadataStatus,
                    usageComplete: telemetry.usageComplete,
                    tokenUsage: telemetry.tokenUsage,
                    latencyMs: telemetry.latencyMs,
                    estimatedCostUsd: telemetry.estimatedCostUsd,
                    finishReason: telemetry.finishReason,
                });
                if (telemetry.disposition === 'rate_limited' && telemetry.attempt < 4) {
                    expectedAttempt = telemetry.attempt + 1;
                } else {
                    terminal = true;
                }
            }
            reservations.delete(telemetry.attempt);
        },
    };
}
