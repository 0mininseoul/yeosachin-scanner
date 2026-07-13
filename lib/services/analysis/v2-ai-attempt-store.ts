import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const OPERATION_KEY_PATTERN = /^(gender-triage|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const LOCATION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const FINISH_REASON_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_OPERATION_IDENTITY_LENGTH = 65_536;

export const ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_ai_attempts',
    reserveRpc: 'reserve_analysis_v2_ai_attempt',
    terminalizeRpc: 'terminalize_analysis_v2_ai_attempt',
    loadOperationRpc: 'load_analysis_v2_ai_operation',
});

export const ANALYSIS_V2_AI_STAGES = [
    'genderTriage',
    'featureAnalysis',
    'highRiskNarrative',
    'privateAccountName',
    'partnerSafety',
] as const;

export const ANALYSIS_V2_AI_ATTEMPT_STATUSES = [
    'reserved',
    'success',
    'rate_limited',
    'ambiguous',
    'rejected',
] as const;

const TERMINAL_STATUSES = [
    'success',
    'rate_limited',
    'ambiguous',
    'rejected',
] as const;

export type AnalysisV2AiStage = typeof ANALYSIS_V2_AI_STAGES[number];
export type AnalysisV2AiAttemptStatus = typeof ANALYSIS_V2_AI_ATTEMPT_STATUSES[number];
export type AnalysisV2AiTerminalStatus = typeof TERMINAL_STATUSES[number];
export type AnalysisV2AiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
export type AnalysisV2AiMediaResolution = 'LOW' | 'MEDIUM' | 'HIGH';
export type AnalysisV2AiUsageMetadataStatus = 'complete' | 'missing' | 'malformed';

const OPERATION_PREFIX_BY_STAGE: Readonly<Record<AnalysisV2AiStage, string>> = {
    genderTriage: 'gender-triage',
    featureAnalysis: 'feature-analysis',
    highRiskNarrative: 'high-risk-narrative',
    privateAccountName: 'private-account-name',
    partnerSafety: 'partner-safety',
};

const stageSchema = z.enum(ANALYSIS_V2_AI_STAGES);
const statusSchema = z.enum(ANALYSIS_V2_AI_ATTEMPT_STATUSES);
const terminalStatusSchema = z.enum(TERMINAL_STATUSES);
const thinkingLevelSchema = z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
const mediaResolutionSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const usageMetadataStatusSchema = z.enum(['complete', 'missing', 'malformed']);

const persistedTokenUsageSchema = z.object({
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
            message: 'Total token usage must equal prompt, completion, and thinking usage.',
        });
    }
});

const incomingTokenUsageSchema = z.object({
    promptTokens: z.number().int().min(0).max(100_000_000),
    completionTokens: z.number().int().min(0).max(100_000_000),
    totalTokens: z.number().int().min(0).max(100_000_000),
    thinkingTokens: z.number().int().min(0).max(100_000_000).optional(),
}).strict();

const identityFields = {
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    claimToken: z.string().regex(UUID_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
};

const metadataFields = {
    attempt: z.number().int().min(1).max(4),
    retryCount: z.number().int().min(0).max(3),
    modelName: z.string().regex(MODEL_PATTERN),
    location: z.string().regex(LOCATION_PATTERN),
    stage: stageSchema,
    thinkingLevel: thinkingLevelSchema.nullable(),
    mediaCount: z.number().int().min(0).max(11),
    mediaResolution: mediaResolutionSchema.nullable(),
    promptVersion: z.string().regex(VERSION_PATTERN),
    schemaVersion: z.number().int().min(1).max(9_999),
    maxOutputTokens: z.number().int().min(1).max(65_536),
};

const reservationInputSchema = z.object({
    ...identityFields,
    ...metadataFields,
}).strict();

const terminalInputSchema = z.object({
    ...identityFields,
    ...metadataFields,
    reservationToken: z.string().regex(UUID_PATTERN),
    status: terminalStatusSchema,
    usageMetadataStatus: usageMetadataStatusSchema,
    usageComplete: z.boolean(),
    tokenUsage: incomingTokenUsageSchema.nullable(),
    latencyMs: z.number().int().min(0).max(3_600_000),
    estimatedCostUsd: z.number().finite().min(0).max(999.999999999999).nullable(),
    finishReason: z.string().regex(FINISH_REASON_PATTERN).nullable(),
}).strict();

const loadInputSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
}).strict();

const rawAttemptRecordSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
    attempt: z.number().int().min(1).max(4),
    reservationToken: z.string().regex(UUID_PATTERN),
    status: statusSchema,
    modelName: z.string().regex(MODEL_PATTERN),
    location: z.string().regex(LOCATION_PATTERN),
    stage: stageSchema,
    thinkingLevel: thinkingLevelSchema.nullable(),
    mediaCount: z.number().int().min(0).max(11),
    mediaResolution: mediaResolutionSchema.nullable(),
    promptVersion: z.string().regex(VERSION_PATTERN),
    schemaVersion: z.number().int().min(1).max(9_999),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    retryCount: z.number().int().min(0).max(3),
    usageMetadataStatus: usageMetadataStatusSchema.nullable(),
    usageComplete: z.boolean().nullable(),
    tokenUsage: persistedTokenUsageSchema.nullable(),
    latencyMs: z.number().int().min(0).max(3_600_000).nullable(),
    estimatedCostUsd: z.number().finite().min(0).max(999.999999999999).nullable(),
    finishReason: z.string().regex(FINISH_REASON_PATTERN).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    terminalizedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export interface AnalysisV2AiTokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    thinkingTokens: number;
}

export interface AnalysisV2AiAttemptMetadata {
    attempt: number;
    retryCount: number;
    modelName: string;
    location: string;
    stage: AnalysisV2AiStage;
    thinkingLevel: AnalysisV2AiThinkingLevel | null;
    mediaCount: number;
    mediaResolution: AnalysisV2AiMediaResolution | null;
    promptVersion: string;
    schemaVersion: number;
    maxOutputTokens: number;
}

export interface AnalysisV2AiAttemptIdentity {
    requestId: string;
    jobKey: string;
    claimToken: string;
    operationKey: string;
}

export interface AnalysisV2AiAttemptReservationInput
    extends AnalysisV2AiAttemptIdentity, AnalysisV2AiAttemptMetadata {}

export interface AnalysisV2AiAttemptTerminalInput
    extends AnalysisV2AiAttemptIdentity, AnalysisV2AiAttemptMetadata {
    reservationToken: string;
    status: AnalysisV2AiTerminalStatus;
    usageMetadataStatus: AnalysisV2AiUsageMetadataStatus;
    usageComplete: boolean;
    tokenUsage: Omit<AnalysisV2AiTokenUsage, 'thinkingTokens'> & {
        thinkingTokens?: number;
    } | null;
    latencyMs: number;
    estimatedCostUsd: number | null;
    finishReason: string | null;
}

export interface AnalysisV2AiAttemptRecord extends AnalysisV2AiAttemptMetadata {
    requestId: string;
    jobKey: string;
    operationKey: string;
    reservationToken: string;
    status: AnalysisV2AiAttemptStatus;
    usageMetadataStatus: AnalysisV2AiUsageMetadataStatus | null;
    usageComplete: boolean | null;
    tokenUsage: AnalysisV2AiTokenUsage | null;
    latencyMs: number | null;
    estimatedCostUsd: number | null;
    finishReason: string | null;
    createdAt: string;
    terminalizedAt: string | null;
}

export interface AnalysisV2AiAttemptReservation extends AnalysisV2AiAttemptRecord {
    created: boolean;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2AiAttemptSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2AiAttemptStore {
    reserve(input: AnalysisV2AiAttemptReservationInput): Promise<AnalysisV2AiAttemptReservation>;
    terminalize(input: AnalysisV2AiAttemptTerminalInput): Promise<AnalysisV2AiAttemptRecord>;
    loadOperation(input: {
        requestId: string;
        operationKey: string;
    }): Promise<AnalysisV2AiAttemptRecord[]>;
}

export class AnalysisV2AiAttemptConflictError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_ATTEMPT_CONFLICT');
        this.name = 'AnalysisV2AiAttemptConflictError';
    }
}

export class AnalysisV2AiAttemptFenceError extends Error {
    constructor(message = 'ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH') {
        super(message);
        this.name = 'AnalysisV2AiAttemptFenceError';
    }
}

export class AnalysisV2AiAttemptNotRetryableError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_ATTEMPT_NOT_RETRYABLE');
        this.name = 'AnalysisV2AiAttemptNotRetryableError';
    }
}

export class AnalysisV2AiAttemptNotReadyError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_ATTEMPT_NOT_READY');
        this.name = 'AnalysisV2AiAttemptNotReadyError';
    }
}

function safeParse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new Error(`ANALYSIS_V2_AI_ATTEMPT_VALIDATION_ERROR: invalid ${label}.`);
    }
    return result.data;
}

function operationMatchesStage(operationKey: string, stage: AnalysisV2AiStage): boolean {
    return operationKey.startsWith(`${OPERATION_PREFIX_BY_STAGE[stage]}:`);
}

function assertMetadataConsistency(
    value: AnalysisV2AiAttemptMetadata & { operationKey: string },
    label: string
): void {
    if (
        value.retryCount !== value.attempt - 1
        || !operationMatchesStage(value.operationKey, value.stage)
    ) {
        throw new Error(`ANALYSIS_V2_AI_ATTEMPT_VALIDATION_ERROR: invalid ${label}.`);
    }
}

/**
 * Hash the complete deterministic operation identity. The identity must include every input
 * fingerprint that can change generation output; only its SHA-256 digest is persisted.
 */
export function createAnalysisV2AiOperationKey(
    stage: AnalysisV2AiStage,
    deterministicOperationIdentity: string
): string {
    const validStage = safeParse(stageSchema, stage, 'AI stage');
    if (
        typeof deterministicOperationIdentity !== 'string'
        || deterministicOperationIdentity.length < 1
        || deterministicOperationIdentity.length > MAX_OPERATION_IDENTITY_LENGTH
    ) {
        throw new Error(
            'ANALYSIS_V2_AI_ATTEMPT_VALIDATION_ERROR: invalid operation identity.'
        );
    }
    const digest = createHash('sha256')
        .update('analysis-v2-ai-operation:v1\0', 'utf8')
        .update(validStage, 'utf8')
        .update('\0', 'utf8')
        .update(deterministicOperationIdentity, 'utf8')
        .digest('hex');
    return `${OPERATION_PREFIX_BY_STAGE[validStage]}:${digest}`;
}

function canonicalTerminalInput(
    input: AnalysisV2AiAttemptTerminalInput
): AnalysisV2AiAttemptTerminalInput & { tokenUsage: AnalysisV2AiTokenUsage | null } {
    const parsed = safeParse(terminalInputSchema, input, 'terminal telemetry');
    assertMetadataConsistency(parsed, 'terminal telemetry');

    if (parsed.usageMetadataStatus === 'complete') {
        if (!parsed.usageComplete || !parsed.tokenUsage) {
            throw new Error(
                'ANALYSIS_V2_AI_ATTEMPT_VALIDATION_ERROR: complete usage is missing.'
            );
        }
        const inferredThinkingTokens = parsed.tokenUsage.totalTokens
            - parsed.tokenUsage.promptTokens
            - parsed.tokenUsage.completionTokens;
        const tokenUsage = safeParse(persistedTokenUsageSchema, {
            ...parsed.tokenUsage,
            thinkingTokens: parsed.tokenUsage.thinkingTokens ?? inferredThinkingTokens,
        }, 'token usage');
        return { ...parsed, tokenUsage };
    }

    if (
        parsed.usageComplete
        || parsed.tokenUsage !== null
        || parsed.estimatedCostUsd !== null
    ) {
        throw new Error(
            'ANALYSIS_V2_AI_ATTEMPT_VALIDATION_ERROR: unknown usage must remain null.'
        );
    }
    if (
        (parsed.status === 'rate_limited' || parsed.status === 'ambiguous')
        && (parsed.usageMetadataStatus !== 'missing' || parsed.finishReason !== null)
    ) {
        throw new Error(
            'ANALYSIS_V2_AI_ATTEMPT_VALIDATION_ERROR: generation failure telemetry is inconsistent.'
        );
    }
    return { ...parsed, tokenUsage: null };
}

function parseAttemptRecord(data: unknown, label: string): AnalysisV2AiAttemptRecord {
    const parsed = safeParse(rawAttemptRecordSchema, data, label);
    assertMetadataConsistency(parsed, label);

    if (parsed.status === 'reserved') {
        if (
            parsed.usageMetadataStatus !== null
            || parsed.usageComplete !== null
            || parsed.tokenUsage !== null
            || parsed.latencyMs !== null
            || parsed.estimatedCostUsd !== null
            || parsed.finishReason !== null
            || parsed.terminalizedAt !== null
        ) {
            throw new Error(
                `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
            );
        }
    } else {
        if (
            parsed.usageMetadataStatus === null
            || parsed.usageComplete === null
            || parsed.latencyMs === null
            || parsed.terminalizedAt === null
        ) {
            throw new Error(
                `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
            );
        }
        if (parsed.usageMetadataStatus === 'complete') {
            if (!parsed.usageComplete || parsed.tokenUsage === null) {
                throw new Error(
                    `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
                );
            }
        } else if (
            parsed.usageComplete
            || parsed.tokenUsage !== null
            || parsed.estimatedCostUsd !== null
        ) {
            throw new Error(
                `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
            );
        }
        if (
            (parsed.status === 'rate_limited' || parsed.status === 'ambiguous')
            && (parsed.usageMetadataStatus !== 'missing' || parsed.finishReason !== null)
        ) {
            throw new Error(
                `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
            );
        }
        if (Date.parse(parsed.terminalizedAt) < Date.parse(parsed.createdAt)) {
            throw new Error(
                `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
            );
        }
    }
    return parsed;
}

function reservationMetadata(input: AnalysisV2AiAttemptMetadata): Record<string, unknown> {
    return {
        model_name: input.modelName,
        location: input.location,
        stage: input.stage,
        thinking_level: input.thinkingLevel,
        media_count: input.mediaCount,
        media_resolution: input.mediaResolution,
        prompt_version: input.promptVersion,
        schema_version: input.schemaVersion,
        max_output_tokens: input.maxOutputTokens,
        retry_count: input.retryCount,
    };
}

function sameImmutableMetadata(
    left: AnalysisV2AiAttemptMetadata,
    right: AnalysisV2AiAttemptMetadata
): boolean {
    return left.modelName === right.modelName
        && left.location === right.location
        && left.stage === right.stage
        && left.thinkingLevel === right.thinkingLevel
        && left.mediaCount === right.mediaCount
        && left.mediaResolution === right.mediaResolution
        && left.promptVersion === right.promptVersion
        && left.schemaVersion === right.schemaVersion
        && left.maxOutputTokens === right.maxOutputTokens;
}

function sameTokenUsage(
    left: AnalysisV2AiTokenUsage | null,
    right: AnalysisV2AiTokenUsage | null
): boolean {
    if (left === null || right === null) return left === right;
    return left.promptTokens === right.promptTokens
        && left.completionTokens === right.completionTokens
        && left.totalTokens === right.totalTokens
        && left.thinkingTokens === right.thinkingTokens;
}

function assertRpcAttemptMatches(
    record: AnalysisV2AiAttemptRecord,
    expected: AnalysisV2AiAttemptIdentity & AnalysisV2AiAttemptMetadata,
    label: string
): void {
    if (
        record.requestId !== expected.requestId.toLowerCase()
        || record.jobKey !== expected.jobKey
        || record.operationKey !== expected.operationKey
        || record.attempt !== expected.attempt
        || record.retryCount !== expected.retryCount
        || !sameImmutableMetadata(record, expected)
    ) {
        throw new Error(
            `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid ${label} response.`
        );
    }
}

function terminalTelemetry(
    input: AnalysisV2AiAttemptMetadata & {
        usageMetadataStatus: AnalysisV2AiUsageMetadataStatus;
        usageComplete: boolean;
        tokenUsage: AnalysisV2AiTokenUsage | null;
        latencyMs: number;
        estimatedCostUsd: number | null;
        finishReason: string | null;
    }
): Record<string, unknown> {
    return {
        ...reservationMetadata(input),
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

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT') {
        throw new AnalysisV2AiAttemptConflictError();
    }
    if (
        error.message === 'ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_AI_ATTEMPT_JOB_FENCE_MISMATCH'
    ) {
        throw new AnalysisV2AiAttemptFenceError(error.message);
    }
    if (error.message === 'ANALYSIS_V2_AI_ATTEMPT_NOT_RETRYABLE') {
        throw new AnalysisV2AiAttemptNotRetryableError();
    }
    if (error.message === 'ANALYSIS_V2_AI_ATTEMPT_NOT_READY') {
        throw new AnalysisV2AiAttemptNotReadyError();
    }
    throw new Error(
        `ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

export function createAnalysisV2AiAttemptStore(
    client: AnalysisV2AiAttemptSupabaseClient = supabaseAdmin
): AnalysisV2AiAttemptStore {
    return {
        async reserve(input) {
            const parsed = safeParse(reservationInputSchema, input, 'reservation');
            assertMetadataConsistency(parsed, 'reservation');
            const reservationToken = randomUUID().toLowerCase();
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.reserveRpc,
                {
                    p_request_id: parsed.requestId.toLowerCase(),
                    p_job_key: parsed.jobKey,
                    p_claim_token: parsed.claimToken.toLowerCase(),
                    p_operation_key: parsed.operationKey,
                    p_attempt: parsed.attempt,
                    p_reservation_token: reservationToken,
                    p_metadata: reservationMetadata(parsed),
                }
            );
            if (error) throwRpcError(error, 'reservation');
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid reservation response.'
                );
            }
            const { created, ...attempt } = data as Record<string, unknown>;
            if (typeof created !== 'boolean') {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid reservation response.'
                );
            }
            const record = parseAttemptRecord(attempt, 'reservation');
            assertRpcAttemptMatches(record, parsed, 'reservation');
            if (
                created
                && (
                    record.status !== 'reserved'
                    || record.reservationToken !== reservationToken
                )
            ) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid reservation response.'
                );
            }
            return {
                ...record,
                created,
            };
        },

        async terminalize(input) {
            const parsed = canonicalTerminalInput(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.terminalizeRpc,
                {
                    p_request_id: parsed.requestId.toLowerCase(),
                    p_job_key: parsed.jobKey,
                    p_claim_token: parsed.claimToken.toLowerCase(),
                    p_operation_key: parsed.operationKey,
                    p_attempt: parsed.attempt,
                    p_reservation_token: parsed.reservationToken.toLowerCase(),
                    p_status: parsed.status,
                    p_telemetry: terminalTelemetry(parsed),
                }
            );
            if (error) throwRpcError(error, 'terminalization');
            const record = parseAttemptRecord(data, 'terminalization');
            assertRpcAttemptMatches(record, parsed, 'terminalization');
            if (
                record.reservationToken !== parsed.reservationToken.toLowerCase()
                || record.status !== parsed.status
                || record.usageMetadataStatus !== parsed.usageMetadataStatus
                || record.usageComplete !== parsed.usageComplete
                || !sameTokenUsage(record.tokenUsage, parsed.tokenUsage)
                || record.latencyMs !== parsed.latencyMs
                || record.estimatedCostUsd !== parsed.estimatedCostUsd
                || record.finishReason !== parsed.finishReason
            ) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid terminalization response.'
                );
            }
            return record;
        },

        async loadOperation(input) {
            const parsed = safeParse(loadInputSchema, input, 'operation lookup');
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.loadOperationRpc,
                {
                    p_request_id: parsed.requestId.toLowerCase(),
                    p_operation_key: parsed.operationKey,
                }
            );
            if (error) throwRpcError(error, 'operation lookup');
            if (!Array.isArray(data)) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid operation lookup response.'
                );
            }
            const attempts = data.map((row, index) => parseAttemptRecord(
                row,
                `operation attempt ${index + 1}`
            ));
            if (attempts.some((attempt, index) => attempt.attempt !== index + 1)) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid operation attempt order.'
                );
            }
            if (attempts.some(attempt => (
                attempt.requestId !== parsed.requestId.toLowerCase()
                || attempt.operationKey !== parsed.operationKey
            ))) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: invalid operation identity.'
                );
            }
            const first = attempts[0];
            if (first && attempts.some(attempt => (
                attempt.jobKey !== first.jobKey
                || !sameImmutableMetadata(attempt, first)
            ))) {
                throw new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: operation metadata drift.'
                );
            }
            return attempts;
        },
    };
}

export const analysisV2AiAttemptStore = createAnalysisV2AiAttemptStore();
