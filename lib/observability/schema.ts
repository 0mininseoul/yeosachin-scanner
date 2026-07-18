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
] as const;

type SanitizedValue = string | number | boolean | null;

const EVENT_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_./:\[\]-]{0,255}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const REGISTERED_ERROR_CODES = new Set([
    'INTERNAL_ERROR',
    'NETWORK_ERROR',
    'NOT_FOUND',
    'PROVIDER_ERROR',
    'RATE_LIMITED',
    'TIMEOUT',
    'UNAUTHORIZED',
    'UNKNOWN',
    'VALIDATION_ERROR',
]);

const REGISTERED_ERROR_CODE_PREFIXES = [
    'AI_',
    'ANALYSIS_',
    'APIFY_',
    'AUTH_',
    'CAROUSEL_',
    'CLOUD_TASK_',
    'DATABASE_',
    'EARLYBIRD_',
    'GEMINI_',
    'GROBLE_',
    'HTTP_',
    'INTERACTION_',
    'INVALID_',
    'JOB_',
    'NEXT_',
    'OBSERVABILITY_',
    'PARTNER_',
    'PREFLIGHT_',
    'PROFILE_FETCH_',
    'PROVIDER_',
    'QUEUE_',
    'RISK_',
    'SCRAPING_',
    'SUPABASE_',
    'TARGET_',
    'UPSTREAM_',
    'V2_',
] as const;

const FORBIDDEN_ERROR_CODE_SEGMENTS = new Set([
    'AUTHORIZATION',
    'BIO',
    'BODY',
    'BUYER',
    'CAPTION',
    'COMMENT',
    'COOKIE',
    'EMAIL',
    'IMAGE',
    'MEDIA',
    'NAME',
    'PAYLOAD',
    'PHONE',
    'PROMPT',
    'RESPONSE',
    'SECRET',
    'SIGNATURE',
    'TOKEN',
]);

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
    return safeString(candidate) ?? 'development';
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
    const registered = REGISTERED_ERROR_CODES.has(candidate)
        || REGISTERED_ERROR_CODE_PREFIXES.some(prefix => candidate.startsWith(prefix));
    if (!registered) return undefined;
    if (candidate.split('_').some(segment => FORBIDDEN_ERROR_CODE_SEGMENTS.has(segment))) {
        return undefined;
    }
    return candidate;
}

function safeErrorName(value: unknown): string | undefined {
    return safeString(value, ERROR_NAME_PATTERN);
}

function sanitizeField(name: string, value: unknown): SanitizedValue | undefined {
    if (value === null) return null;

    switch (name) {
        case 'request_id':
            return safeString(value, REQUEST_ID_PATTERN);
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
        case 'operation':
        case 'phase':
        case 'disposition':
        case 'model':
        case 'thinking_level':
        case 'queue_name':
            return safeString(value);
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
            return safeString(value, PLAN_ID_PATTERN);
        case 'amount_krw':
            return safeFiniteNumber(value, 0, 1_000_000_000, true);
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
    const event = typeof input.event === 'string' && EVENT_PATTERN.test(input.event)
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
