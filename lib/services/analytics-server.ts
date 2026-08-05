import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AnalyticsErrorCode } from './analytics-funnel';

export type AnalysisLifecycleEventName =
    | 'analysis_started'
    | 'analysis_completed'
    | 'analysis_failed';

export interface AnalysisLifecycleEventInput {
    requestId: string;
    eventName: AnalysisLifecycleEventName;
    errorCode?: AnalyticsErrorCode;
}

interface LifecycleLedgerRow {
    request_id: string;
    event_name: AnalysisLifecycleEventName;
    user_id: string;
    plan_id: 'basic' | 'standard' | 'plus' | null;
    preflight_id: string | null;
    occurred_at: string;
    insert_id: string;
    duration_ms: number | null;
    error_code: AnalyticsErrorCode | null;
}

interface RpcClient {
    rpc(
        functionName: string,
        args: Record<string, unknown>,
    ): Promise<{ data: unknown; error: unknown | null }>;
}

interface ServerAnalyticsDependencies {
    client?: RpcClient;
    fetchImpl?: typeof fetch;
    apiKey?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_NAMES = new Set<AnalysisLifecycleEventName>([
    'analysis_started',
    'analysis_completed',
    'analysis_failed',
]);
const EVENT_ENDPOINT = 'https://api2.amplitude.com/2/httpapi';
const EVENT_REQUEST_TIMEOUT_MS = 5_000;

function serverApiKey(): string | null {
    const value = process.env.AMPLITUDE_API_KEY?.trim()
        || process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY?.trim();
    return value || null;
}

function firstRow(data: unknown): LifecycleLedgerRow | null {
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const candidate = row as Record<string, unknown>;
    if (
        typeof candidate.request_id !== 'string'
        || !UUID_PATTERN.test(candidate.request_id)
        || typeof candidate.event_name !== 'string'
        || !EVENT_NAMES.has(candidate.event_name as AnalysisLifecycleEventName)
        || typeof candidate.user_id !== 'string'
        || !UUID_PATTERN.test(candidate.user_id)
        || typeof candidate.insert_id !== 'string'
        || typeof candidate.occurred_at !== 'string'
    ) return null;
    const planId = candidate.plan_id === null || candidate.plan_id === undefined
        ? null
        : candidate.plan_id === 'basic' || candidate.plan_id === 'standard' || candidate.plan_id === 'plus'
            ? candidate.plan_id
            : null;
    const durationMs = typeof candidate.duration_ms === 'number'
        && Number.isInteger(candidate.duration_ms)
        && candidate.duration_ms >= 0
        ? candidate.duration_ms
        : null;
    return {
        request_id: candidate.request_id,
        event_name: candidate.event_name as AnalysisLifecycleEventName,
        user_id: candidate.user_id,
        plan_id: planId,
        preflight_id: typeof candidate.preflight_id === 'string'
            && UUID_PATTERN.test(candidate.preflight_id)
            ? candidate.preflight_id
            : null,
        occurred_at: candidate.occurred_at,
        insert_id: candidate.insert_id,
        duration_ms: durationMs,
        error_code: typeof candidate.error_code === 'string'
            ? candidate.error_code as AnalyticsErrorCode
            : null,
    };
}

function eventProperties(row: LifecycleLedgerRow): Record<string, string | number> {
    const includesDuration = row.event_name !== 'analysis_started';
    return {
        request_id: row.request_id,
        ...(row.plan_id ? { plan_id: row.plan_id } : {}),
        ...(row.preflight_id ? { preflight_id: row.preflight_id } : {}),
        ...(!includesDuration || row.duration_ms === null
            ? {}
            : { duration_ms: row.duration_ms }),
        ...(row.error_code ? { error_code: row.error_code } : {}),
    };
}

/**
 * Emits an analysis-owned lifecycle event after claiming its durable ledger row.
 * The claim is intentionally separate from delivery: a failed HTTP request leaves
 * the row unsent, while retries reuse the same insert_id. No exception escapes to
 * a worker or request handler.
 */
export async function emitAnalysisLifecycleEvent(
    input: AnalysisLifecycleEventInput,
    dependencies: ServerAnalyticsDependencies = {},
): Promise<boolean> {
    if (!UUID_PATTERN.test(input.requestId) || !EVENT_NAMES.has(input.eventName)) return false;

    const client = dependencies.client ?? supabaseAdmin;
    let claim: { data: unknown; error: unknown | null };
    try {
        claim = await client.rpc('claim_analysis_lifecycle_event', {
            p_request_id: input.requestId,
            p_event_name: input.eventName,
            p_error_code: input.errorCode ?? null,
        });
    } catch {
        return false;
    }
    if (claim.error) return false;

    const row = firstRow(claim.data);
    if (!row) return false;
    const apiKey = dependencies.apiKey === undefined
        ? serverApiKey()
        : dependencies.apiKey;
    if (!apiKey) return false;

    const payload = {
        api_key: apiKey,
        events: [{
            user_id: row.user_id,
            event_type: row.event_name,
            time: Date.parse(row.occurred_at) || Date.now(),
            insert_id: row.insert_id,
            event_properties: eventProperties(row),
        }],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EVENT_REQUEST_TIMEOUT_MS);
    try {
        const response = await (dependencies.fetchImpl ?? fetch)(EVENT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!response.ok) return false;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }

    try {
        await client.rpc('mark_analysis_lifecycle_event_sent', {
            p_request_id: row.request_id,
            p_event_name: row.event_name,
        });
    } catch {
        // The stable insert_id makes a later retry safe even if this acknowledgement
        // is lost after Amplitude accepted the event.
    }
    return true;
}
