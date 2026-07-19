import { isAnalysisV2WorkerErrorCode } from '../services/analysis/v2-worker-error-codes';
import { INSTAGRAM_USERNAME_PATTERN } from '../services/instagram/username';

export type OperationalSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface OperationalEvent {
    event: string;
    severity: OperationalSeverity;
    fields?: Record<string, unknown>;
    error?: unknown;
}

export const ALLOWED_FIELD_NAMES = [
    'schema_version',
    'environment',
    'service',
    'event',
    'severity',
    'request_id',
    'trace_id',
    'route',
    'method',
    'status',
    'duration_ms',
    'user_id',
    'preflight_id',
    'order_id',
    'analysis_request_id',
    'job_key',
    'target_instagram_id',
    'candidate_instagram_id',
    'excluded_instagram_id',
    'provider',
    'operation',
    'phase',
    'attempt',
    'result_count',
    'error_name',
    'error_code',
    'disposition',
    'retryable',
    'estimated_cost_usd',
    'input_count',
    'output_count',
    'model',
    'thinking_level',
    'prompt_tokens',
    'completion_tokens',
    'thinking_tokens',
    'fallback',
    'queue_name',
    'progress',
    'plan_id',
    'amount_krw',
    'webhook_event_type',
] as const;

type SanitizedValue = string | number | boolean | null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_./:\[\]-]{0,255}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const OPERATIONAL_EVENT_NAMES = [
    'operational.invalid_event',
    'http.route_completed',
    'http.route_failed',
    'next.request_error',
    'auth.callback_completed',
    'auth.profile_sync_failed',
    'preflight.requested',
    'preflight.profile_collected',
    'preflight.completed',
    'preflight.failed',
    'preflight.exclusion_decided',
    'earlybird.checkout_created',
    'earlybird.checkout_failed',
    'groble.webhook_received',
    'groble.webhook_finalized',
    'groble.webhook_rejected',
    'scraper.batch_completed',
    'scraper.batch_failed',
    'scraper.fallback_selected',
    'scraper.candidate_failed',
    'cloud_task.enqueue_completed',
    'cloud_task.enqueue_failed',
    'analysis_v2.worker_completed',
    'analysis_v2.worker_retry',
    'analysis_v2.worker_failed',
    'gemini.stage_completed',
    'gemini.stage_rate_limited',
    'gemini.stage_failed',
] as const;

export const OPERATIONAL_ERROR_CODES = [
    'AUTH_USERNAME_INVALID',
    'INTERNAL_ERROR',
    'INVALID_REQUEST',
    'JOB_DISPATCH_NOT_READY',
    'NETWORK_ERROR',
    'NOT_FOUND',
    'PROVIDER_ERROR',
    'RATE_LIMITED',
    'TIMEOUT',
    'UNAUTHORIZED',
    'UNKNOWN',
    'VALIDATION_ERROR',
] as const;

export const OPERATIONAL_ERROR_NAMES = [
    'AbortError',
    'AggregateError',
    'AnalysisAlreadyInProgressError',
    'AnalysisIdempotencyConflictError',
    'AnalysisImagePreparationError',
    'AnalysisLimitExceededError',
    'AnalysisMediaPolicyError',
    'AnalysisV2AiAttemptConflictError',
    'AnalysisV2AiAttemptFenceError',
    'AnalysisV2AiAttemptNotReadyError',
    'AnalysisV2AiAttemptNotRetryableError',
    'AnalysisV2AiResultConflictError',
    'AnalysisV2AiResultFenceError',
    'AnalysisV2AiResultNotReadyError',
    'AnalysisV2AiResultRateLimitExhaustedError',
    'AnalysisV2AiResultReplayBlockedError',
    'AnalysisV2AiScoringStageConflictError',
    'AnalysisV2AiScoringStageFenceError',
    'AnalysisV2CollectionContextFenceError',
    'AnalysisV2DagScopeMissingError',
    'AnalysisV2DagStateConflictError',
    'AnalysisV2DagStateFenceError',
    'AnalysisV2EntitlementConsumptionError',
    'AnalysisV2EvidenceConflictError',
    'AnalysisV2EvidenceFenceError',
    'AnalysisV2FreshAdmissionError',
    'AnalysisV2FreshAdmissionLeaseBusyError',
    'AnalysisV2JobDispatchNotReadyError',
    'AnalysisV2JobExecutionError',
    'AnalysisV2JobFenceError',
    'AnalysisV2JobLeaseBusyError',
    'AnalysisV2ProgressConflictError',
    'AnalysisV2ProgressFenceError',
    'AnalysisV2ProviderRunAlreadyReservedError',
    'AnalysisV2ProviderRunConflictError',
    'AnalysisV2ProviderRunFenceError',
    'AnalysisV2ProviderRunReconciliationNotReadyError',
    'AnalysisV2RelationshipIncompleteError',
    'AnalysisV2ResultConflictError',
    'AnalysisV2ResultFenceError',
    'AnalysisV2ResultNotReadyError',
    'AnalysisV2TransientMediaPreparationError',
    'EarlybirdOrderLookupError',
    'EarlybirdPersistenceError',
    'EarlybirdWaitlistRequiredError',
    'Error',
    'EvalError',
    'FlashApiRequestError',
    'InvalidPreflightExclusionError',
    'PreflightConsumedError',
    'PreflightExpiredError',
    'PreflightIdempotencyConflictError',
    'PreflightImmutableError',
    'PreflightLeaseBusyError',
    'PreflightNotFoundError',
    'PreflightRateLimitedError',
    'PreflightTaskEnqueueError',
    'PreflightWorkerRetryError',
    'RangeError',
    'ReferenceError',
    'ResultPaginationError',
    'RetryableGeminiRateLimitError',
    'SecureImageFetchError',
    'SyntaxError',
    'TimeoutError',
    'TypeError',
    'URIError',
    'WebProfileRequestError',
    'ZodError',
] as const;

export const OPERATIONAL_ENVIRONMENTS = [
    'development',
    'test',
    'preview',
    'production',
] as const;

export const OPERATIONAL_PROVIDERS = [
    'apify',
    'coderx',
    'flashapi',
    'gemini',
    'google',
    'groble',
    'kakao',
    'rapidapi',
    'selfhosted',
    'supabase',
] as const;

export const OPERATIONAL_MODELS = [
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
] as const;

export const OPERATIONAL_THINKING_LEVELS = [
    'minimal',
    'low',
    'medium',
    'high',
] as const;

export const OPERATIONAL_PLAN_IDS = ['basic', 'standard', 'plus'] as const;

export const OPERATIONAL_OPERATIONS = [
    'callback',
    'profile_sync',
    'preflight',
    'profile',
    'profilesBatch',
    'profiles_batch',
    'followers',
    'following',
    'exclusion',
    'checkout',
    'webhook',
    'fresh_admission',
    'enqueue',
    'worker',
    'genderTriage',
    'featureAnalysis',
    'partnerSafety',
    'highRiskNarrative',
    'privateAccountName',
] as const;

export const OPERATIONAL_PHASES = [
    'pending',
    'collect',
    'profiles',
    'analyze',
    'interactions',
    'deep_analysis',
    'finalize',
    'completed',
    'failed',
    'gender',
    'features',
    'enqueue',
    'dispatch',
    'terminalize',
] as const;

export const OPERATIONAL_DISPOSITIONS = [
    'success',
    'failure',
    'retry',
    'fallback',
    'completed',
    'failed',
    'error',
    'requested',
    'ready',
    'blocked',
    'enqueued',
    'exists',
    'disabled',
    'already_terminal',
    'stale_delivery',
    'unavailable',
    'transient',
    'permanent',
    'fence',
    'rate_limited',
    'ambiguous',
    'rejected',
    'response_rejected',
    'accepted',
    'ignored',
    'unmatched',
    'mismatch',
    'duplicate_event',
    'duplicate_payment',
    'cancel_requested',
    'cancel_duplicate_event',
    'cancel_unmatched',
    'cancel_mismatch',
    'cancel_before_payment',
    'late_cancelled_payment',
    'ambiguous_buyer',
    'overflow_refund_required',
] as const;

export const OPERATIONAL_WEBHOOK_EVENT_TYPES = [
    'payment.completed',
    'payment.cancel_requested',
    'other',
] as const;

export const OPERATIONAL_QUEUE_NAMES = [
    'analysis-pipeline',
    'analysis-v2',
    'analysis-v2-pipeline',
] as const;

const REGISTERED_EVENT_NAMES = new Set<string>(OPERATIONAL_EVENT_NAMES);
const REGISTERED_ERROR_CODES = new Set<string>(OPERATIONAL_ERROR_CODES);
const REGISTERED_ERROR_NAMES = new Set<string>(OPERATIONAL_ERROR_NAMES);
const REGISTERED_ENVIRONMENTS = new Set<string>(OPERATIONAL_ENVIRONMENTS);
const REGISTERED_PROVIDERS = new Set<string>(OPERATIONAL_PROVIDERS);
const REGISTERED_MODELS = new Set<string>(OPERATIONAL_MODELS);
const REGISTERED_THINKING_LEVELS = new Set<string>(OPERATIONAL_THINKING_LEVELS);
const REGISTERED_PLAN_IDS = new Set<string>(OPERATIONAL_PLAN_IDS);
const REGISTERED_OPERATIONS = new Set<string>(OPERATIONAL_OPERATIONS);
const REGISTERED_PHASES = new Set<string>(OPERATIONAL_PHASES);
const REGISTERED_DISPOSITIONS = new Set<string>(OPERATIONAL_DISPOSITIONS);
const REGISTERED_QUEUE_NAMES = new Set<string>(OPERATIONAL_QUEUE_NAMES);
const REGISTERED_WEBHOOK_EVENT_TYPES = new Set<string>(OPERATIONAL_WEBHOOK_EVENT_TYPES);

const METHODS = new Set([
    'CONNECT',
    'DELETE',
    'GET',
    'HEAD',
    'OPTIONS',
    'PATCH',
    'POST',
    'PUT',
    'TRACE',
]);

function safeString(
    value: unknown,
    pattern: RegExp = LABEL_PATTERN,
): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 256 || !pattern.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}

function safeEnvironment(): string {
    const candidate = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
    return REGISTERED_ENVIRONMENTS.has(candidate) ? candidate : 'development';
}

function safeSeverity(value: unknown): OperationalSeverity {
    return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
        ? value
        : 'info';
}

function safeUuid(value: unknown): string | undefined {
    const candidate = safeString(value, UUID_PATTERN);
    return candidate?.toLowerCase();
}

function safeInstagramId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return INSTAGRAM_USERNAME_PATTERN.test(normalized) ? normalized : undefined;
}

function safeFiniteNumber(
    value: unknown,
    minimum: number,
    maximum: number,
    integer = false,
): number | undefined {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || value < minimum
        || value > maximum
        || (integer && !Number.isInteger(value))
    ) {
        return undefined;
    }
    return value;
}

function safeErrorCode(value: unknown): string | undefined {
    const candidate = safeString(value, ERROR_CODE_PATTERN);
    if (!candidate) return undefined;
    const exactRegistryCandidate: unknown = candidate;
    if (isAnalysisV2WorkerErrorCode(exactRegistryCandidate)) return exactRegistryCandidate;
    return REGISTERED_ERROR_CODES.has(candidate) ? candidate : undefined;
}

function safeLowercaseRegistryValue(
    value: unknown,
    registry: ReadonlySet<string>,
): string | undefined {
    const candidate = safeString(value)?.toLowerCase();
    return candidate && registry.has(candidate) ? candidate : undefined;
}

function safeExactRegistryValue(
    value: unknown,
    registry: ReadonlySet<string>,
): string | undefined {
    const candidate = safeString(value);
    return candidate && registry.has(candidate) ? candidate : undefined;
}

function safeErrorName(value: unknown): string | undefined {
    return safeExactRegistryValue(value, REGISTERED_ERROR_NAMES);
}

function sanitizeField(name: string, value: unknown): SanitizedValue | undefined {
    if (value === null) return null;

    switch (name) {
        case 'request_id':
            return safeUuid(value);
        case 'trace_id':
            return safeString(value, TRACE_ID_PATTERN)?.toLowerCase();
        case 'route':
            return safeString(value, ROUTE_PATTERN);
        case 'method': {
            if (typeof value !== 'string') return undefined;
            const method = value.trim().toUpperCase();
            return METHODS.has(method) ? method : undefined;
        }
        case 'status':
            return safeFiniteNumber(value, 100, 599, true);
        case 'duration_ms':
            return safeFiniteNumber(value, 0, 86_400_000);
        case 'user_id':
        case 'preflight_id':
        case 'order_id':
        case 'analysis_request_id':
            return safeUuid(value);
        case 'job_key':
            return safeString(value, JOB_KEY_PATTERN);
        case 'target_instagram_id':
        case 'candidate_instagram_id':
        case 'excluded_instagram_id':
            return safeInstagramId(value);
        case 'provider':
            return safeLowercaseRegistryValue(value, REGISTERED_PROVIDERS);
        case 'model':
            return safeLowercaseRegistryValue(value, REGISTERED_MODELS);
        case 'thinking_level':
            return safeLowercaseRegistryValue(value, REGISTERED_THINKING_LEVELS);
        case 'operation':
            return safeExactRegistryValue(value, REGISTERED_OPERATIONS);
        case 'phase':
            return safeExactRegistryValue(value, REGISTERED_PHASES);
        case 'disposition':
            return safeExactRegistryValue(value, REGISTERED_DISPOSITIONS);
        case 'queue_name':
            return safeExactRegistryValue(value, REGISTERED_QUEUE_NAMES);
        case 'attempt':
            return safeFiniteNumber(value, 0, 10_000, true);
        case 'result_count':
        case 'input_count':
        case 'output_count':
        case 'prompt_tokens':
        case 'completion_tokens':
        case 'thinking_tokens':
            return safeFiniteNumber(value, 0, 1_000_000_000, true);
        case 'error_name':
            return safeErrorName(value);
        case 'error_code':
            return safeErrorCode(value);
        case 'retryable':
        case 'fallback':
            return typeof value === 'boolean' ? value : undefined;
        case 'estimated_cost_usd':
            return safeFiniteNumber(value, 0, 1_000_000);
        case 'progress':
            return safeFiniteNumber(value, 0, 100);
        case 'plan_id':
            return safeLowercaseRegistryValue(value, REGISTERED_PLAN_IDS);
        case 'amount_krw':
            return safeFiniteNumber(value, 0, 1_000_000_000, true);
        case 'webhook_event_type':
            return safeExactRegistryValue(value, REGISTERED_WEBHOOK_EVENT_TYPES);
        default:
            return undefined;
    }
}

function errorFields(error: unknown): Record<string, string> {
    if (!error || typeof error !== 'object' || Array.isArray(error)) return {};

    const record = error as Record<string, unknown>;
    const errorName = safeErrorName(record.name);
    const propertyCode = safeErrorCode(record.code);
    const messagePrefix = typeof record.message === 'string'
        ? record.message.match(/^([A-Z][A-Z0-9_]{0,63})(?=:|\b)/)?.[1]
        : undefined;
    const errorCode = propertyCode ?? safeErrorCode(messagePrefix);

    return {
        ...(errorName ? { error_name: errorName } : {}),
        ...(errorCode ? { error_code: errorCode } : {}),
    };
}

export function sanitizeOperationalEvent(input: OperationalEvent): {
    message: string;
    fields: Record<string, SanitizedValue>;
} {
    const event = typeof input.event === 'string' && REGISTERED_EVENT_NAMES.has(input.event)
        ? input.event
        : 'operational.invalid_event';
    const severity = safeSeverity(input.severity);
    const fields: Record<string, SanitizedValue> = {
        schema_version: 1,
        environment: safeEnvironment(),
        service: 'yeosachin-web',
        event,
        severity,
    };

    if (input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)) {
        for (const name of ALLOWED_FIELD_NAMES) {
            if (
                name === 'schema_version'
                || name === 'environment'
                || name === 'service'
                || name === 'event'
                || name === 'severity'
            ) {
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(input.fields, name)) continue;
            const sanitized = sanitizeField(name, input.fields[name]);
            if (sanitized !== undefined) fields[name] = sanitized;
        }
    }

    Object.assign(fields, errorFields(input.error));
    return { message: event, fields };
}
