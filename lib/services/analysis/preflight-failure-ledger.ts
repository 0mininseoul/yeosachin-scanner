import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AnalyticsErrorCode } from '@/lib/services/analytics-funnel';

export type PreflightFailureStage = 'request' | 'profile' | 'exclusion';
export type PreflightFailureReason = Extract<AnalyticsErrorCode,
    | 'HANDLE_FORMAT_INVALID'
    | 'TARGET_NOT_FOUND'
    | 'TARGET_PRIVATE'
    | 'PLAN_CAPACITY_EXCEEDED'
    | 'EXCLUSION_RULE_VIOLATION'
    | 'PROVIDER_TEMPORARY_FAILURE'
    | 'RATE_LIMITED'
    | 'UNAUTHORIZED'
    | 'INTERNAL_ERROR'
>;

interface FailureLedgerClient {
    from(table: string): {
        insert(values: Record<string, unknown>): Promise<{ error: unknown | null }>;
    };
}

interface RecordPreflightFailureInput {
    userId?: string | null;
    preflightId?: string;
    stage: PreflightFailureStage;
    errorCode: PreflightFailureReason;
}

interface RecordPreflightFailureDependencies {
    client?: FailureLedgerClient;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONS = new Set<PreflightFailureReason>([
    'HANDLE_FORMAT_INVALID',
    'TARGET_NOT_FOUND',
    'TARGET_PRIVATE',
    'PLAN_CAPACITY_EXCEEDED',
    'EXCLUSION_RULE_VIOLATION',
    'PROVIDER_TEMPORARY_FAILURE',
    'RATE_LIMITED',
    'UNAUTHORIZED',
    'INTERNAL_ERROR',
]);

export function preflightFailureReason(value: unknown): PreflightFailureReason {
    const candidate = value && typeof value === 'object' && 'code' in value
        ? (value as { code?: unknown }).code
        : value;
    if (typeof candidate !== 'string') return 'INTERNAL_ERROR';
    if (REASONS.has(candidate as PreflightFailureReason)) {
        return candidate as PreflightFailureReason;
    }
    if (
        candidate === 'INVALID_REQUEST'
        || candidate === 'INVALID_IDEMPOTENCY_KEY'
        || candidate === 'UNSUPPORTED_AUTH'
        || candidate === 'TARGET_UNSUPPORTED'
    ) return 'HANDLE_FORMAT_INVALID';
    if (candidate === 'TARGET_NOT_FOUND') return 'TARGET_NOT_FOUND';
    if (candidate === 'TARGET_PRIVATE') return 'TARGET_PRIVATE';
    if (candidate === 'OVER_PLUS_CAPACITY') return 'PLAN_CAPACITY_EXCEEDED';
    if (candidate === 'EXCLUSION_REQUIRED' || candidate === 'INVALID_EXCLUSION') {
        return 'EXCLUSION_RULE_VIOLATION';
    }
    if (candidate === 'PREFLIGHT_RATE_LIMITED') return 'RATE_LIMITED';
    if (candidate === 'UNAUTHORIZED') return 'UNAUTHORIZED';
    if (
        candidate === 'QUEUE_UNAVAILABLE'
        || candidate === 'JOB_DISPATCH_NOT_READY'
        || candidate === 'PROVIDER_ERROR'
        || candidate === 'TIMEOUT'
        || candidate === 'RATE_LIMITED'
        || candidate.includes('PROVIDER')
        || candidate.includes('TRANSIENT')
    ) return 'PROVIDER_TEMPORARY_FAILURE';
    return 'INTERNAL_ERROR';
}

/** Best-effort PII-free server ledger; callers must never await it for correctness. */
export async function recordPreflightFailure(
    input: RecordPreflightFailureInput,
    dependencies: RecordPreflightFailureDependencies = {},
): Promise<boolean> {
    if (
        (input.userId !== undefined && input.userId !== null && !UUID_PATTERN.test(input.userId))
        || (input.preflightId !== undefined && !UUID_PATTERN.test(input.preflightId))
        || !REASONS.has(input.errorCode)
    ) return false;
    try {
        const result = await (dependencies.client ?? supabaseAdmin)
            .from('analysis_preflight_failures')
            .insert({
                ...(input.userId ? { user_id: input.userId } : {}),
                ...(input.preflightId ? { preflight_id: input.preflightId } : {}),
                stage: input.stage,
                error_code: input.errorCode,
            });
        return !result.error;
    } catch {
        return false;
    }
}
