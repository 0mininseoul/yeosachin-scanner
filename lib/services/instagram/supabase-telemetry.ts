import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ScraperTelemetryEvent, ScraperTelemetryHook } from './providers/types';

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
        console.info('[scraper.telemetry]', JSON.stringify(event));
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
