import { supabaseAdmin } from '@/lib/supabase/admin';
import { operationalLogger } from '@/lib/observability/server';
import type { ScraperTelemetryEvent, ScraperTelemetryHook } from './providers/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emittedEvents = new WeakSet<object>();

function scraperFailureCode(
    category: ScraperTelemetryEvent['failure_category']
): 'VALIDATION_ERROR' | 'TIMEOUT' | 'PROVIDER_ERROR' {
    if (category === 'configuration' || category === 'schema') return 'VALIDATION_ERROR';
    if (category === 'timeout') return 'TIMEOUT';
    return 'PROVIDER_ERROR';
}

function safeRequestId(value: string | undefined): string | undefined {
    return value && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

/** Emits one aggregate attempt outcome; repeated delivery of the same event object is deduped. */
export function emitScraperOperationalTelemetry(event: ScraperTelemetryEvent): void {
    if (emittedEvents.has(event)) return;
    emittedEvents.add(event);

    const fields = {
        ...(safeRequestId(event.requestId) ? { request_id: safeRequestId(event.requestId) } : {}),
        provider: event.provider,
        operation: event.capability,
        input_count: event.request_count,
        output_count: event.unique_result_count,
        result_count: event.result_count,
        fallback: event.fallback,
        duration_ms: event.latency_ms,
        estimated_cost_usd: event.estimated_cost_usd,
    };
    try {
        operationalLogger.emit(event.status === 'success' ? {
            event: 'scraper.batch_completed',
            severity: 'info',
            fields: { ...fields, disposition: 'success' },
        } : {
            event: 'scraper.batch_failed',
            severity: 'error',
            fields: {
                ...fields,
                disposition: 'failure',
                error_code: scraperFailureCode(event.failure_category),
            },
        });
    } catch {
        // Axiom delivery must not change scraper behavior.
    }

    if (!event.fallback) return;
    try {
        operationalLogger.emit({
            event: 'scraper.fallback_selected',
            severity: 'warn',
            fields: { ...fields, disposition: 'fallback' },
        });
    } catch {
        // Axiom delivery must not change scraper behavior.
    }
}

export function toScraperTelemetryRow(event: ScraperTelemetryEvent) {
    return {
        request_id: event.requestId ?? null,
        provider: event.provider,
        capability: event.capability,
        request_count: event.request_count,
        result_count: event.result_count,
        raw_result_count: event.raw_result_count,
        unique_result_count: event.unique_result_count,
        unique_ratio: event.unique_ratio,
        fallback: event.fallback,
        latency_ms: event.latency_ms,
        status: event.status,
        expected_result_count: event.expected_result_count ?? null,
        minimum_complete_count: event.minimum_complete_count ?? null,
        coverage_ratio: event.coverage_ratio ?? null,
        failure_category: event.failure_category ?? null,
        estimated_cost_usd: event.estimated_cost_usd,
        rate_limit_limit: event.rate_limit_limit ?? null,
        rate_limit_remaining: event.rate_limit_remaining ?? null,
    };
}

/**
 * Best-effort persistence adapter. It is disabled until the telemetry migration is applied
 * and SCRAPER_TELEMETRY_PERSIST=true is set in that environment.
 */
export function createSupabaseScraperTelemetryHook(
    env: Record<string, string | undefined> = process.env
): ScraperTelemetryHook {
    return async (event) => {
        emitScraperOperationalTelemetry(event);
        if (env.SCRAPER_TELEMETRY_PERSIST !== 'true') return;
        try {
            const { error } = await supabaseAdmin
                .from('scraper_provider_usage')
                .insert(toScraperTelemetryRow(event));
            if (error) console.warn('[scraper] telemetry persistence failed');
        } catch {
            console.warn('[scraper] telemetry persistence failed');
        }
    };
}
