import type { AnalysisStep } from './steps';

export type AnalysisStepEventType =
    | 'started'
    | 'completed'
    | 'retrying'
    | 'failed'
    | 'skipped'
    | 'aborted';

export type AnalysisFailureCategory =
    | 'configuration'
    | 'schema'
    | 'incomplete'
    | 'budget'
    | 'timeout'
    | 'provider'
    | 'persistence'
    | 'retry_exhausted'
    | 'unknown';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_LATENCY_MS = 86_400_000;
const DEFAULT_EVENT_WRITE_TIMEOUT_MS = 500;

interface InsertResult {
    error: { code?: string } | null;
}

export interface AnalysisStepEventClient {
    from(table: 'analysis_step_events'): {
        insert(row: Record<string, unknown>): PromiseLike<InsertResult>;
    };
}

export interface AnalysisStepEventInput {
    requestId: string;
    step: AnalysisStep;
    eventType: AnalysisStepEventType;
    deliveryAttempt?: number | null;
    progress?: number | null;
    latencyMs?: number | null;
    failureCategory?: AnalysisFailureCategory | null;
}

export function isValidAnalysisRequestId(value: string | null): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function classifyAnalysisFailure(error: unknown): AnalysisFailureCategory {
    const message = error instanceof Error
        ? error.message.toUpperCase()
        : typeof error === 'string'
            ? error.toUpperCase()
            : '';

    if (message.includes('PERSISTENCE') || message.includes('DATABASE')) return 'persistence';
    if (message.includes('CONFIG')) return 'configuration';
    if (message.includes('SCHEMA') || message.includes('VALIDATION')) return 'schema';
    if (message.includes('INCOMPLETE') || message.includes('COMPLETENESS')) return 'incomplete';
    if (
        message.includes('BUDGET')
        || message.includes('MAX_TOTAL_CHARGE')
        || message.includes('NOT_ENOUGH_USAGE')
    ) return 'budget';
    if (message.includes('TIMEOUT') || message.includes('TIMED OUT')) return 'timeout';
    if (
        message.includes('APIFY')
        || message.includes('ACTOR')
        || message.includes('PROVIDER')
        || message.includes('SCRAPER')
        || message.includes('RAPIDAPI')
    ) return 'provider';
    return 'unknown';
}

function boundedInteger(
    value: number | null | undefined,
    min: number,
    max: number
): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/** Best-effort operational telemetry. Its failure must never fail paid analysis work. */
export async function recordAnalysisStepEvent(
    client: AnalysisStepEventClient,
    input: AnalysisStepEventInput,
    timeoutMs = DEFAULT_EVENT_WRITE_TIMEOUT_MS
): Promise<boolean> {
    const requiresFailureCategory = ['retrying', 'failed', 'aborted'].includes(input.eventType);
    const failureCategory = requiresFailureCategory
        ? input.failureCategory ?? 'unknown'
        : null;

    try {
        const deadlineMs = boundedInteger(timeoutMs, 1, 5_000)
            ?? DEFAULT_EVENT_WRITE_TIMEOUT_MS;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const insert = Promise.resolve(client.from('analysis_step_events').insert({
                request_id: input.requestId,
                step: input.step,
                event_type: input.eventType,
                delivery_attempt: boundedInteger(input.deliveryAttempt, 1, 100),
                progress: boundedInteger(input.progress, 0, 100),
                latency_ms: boundedInteger(input.latencyMs, 0, MAX_EVENT_LATENCY_MS),
                failure_category: failureCategory,
            }))
            .then(result => ({ type: 'result' as const, result }))
            .catch(() => ({ type: 'failure' as const }));
        const deadline = new Promise<{ type: 'timeout' }>(resolve => {
            timeout = setTimeout(() => resolve({ type: 'timeout' }), deadlineMs);
        });
        const outcome = await Promise.race([insert, deadline]);
        if (timeout) clearTimeout(timeout);
        if (outcome.type !== 'result' || outcome.result.error) {
            console.warn('[analysis.observability] step event persistence failed');
            return false;
        }
        return true;
    } catch {
        console.warn('[analysis.observability] step event persistence failed');
        return false;
    }
}
