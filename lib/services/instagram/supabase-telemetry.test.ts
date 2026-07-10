import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { toScraperTelemetryRow } from './supabase-telemetry';

describe('scraper telemetry persistence row', () => {
    it('keeps declared-count coverage and failure classification', () => {
        expect(toScraperTelemetryRow({
            requestId: 'request-id',
            provider: 'flashapi',
            capability: 'followers',
            request_count: 115,
            result_count: 320,
            raw_result_count: 469,
            unique_result_count: 320,
            unique_ratio: 320 / 469,
            fallback: false,
            latency_ms: 139_232,
            status: 'error',
            expected_result_count: 474,
            minimum_complete_count: 470,
            coverage_ratio: 320 / 474,
            failure_category: 'incomplete',
            estimated_cost_usd: 0.115,
        })).toMatchObject({
            request_id: 'request-id',
            expected_result_count: 474,
            minimum_complete_count: 470,
            coverage_ratio: 320 / 474,
            failure_category: 'incomplete',
            rate_limit_limit: null,
            rate_limit_remaining: null,
        });
    });

    it('stores non-relationship telemetry without fabricated coverage', () => {
        expect(toScraperTelemetryRow({
            provider: 'selfhosted',
            capability: 'profile',
            request_count: 1,
            result_count: 1,
            raw_result_count: 1,
            unique_result_count: 1,
            unique_ratio: 1,
            fallback: false,
            latency_ms: 100,
            status: 'success',
            estimated_cost_usd: 0,
        })).toMatchObject({
            request_id: null,
            expected_result_count: null,
            minimum_complete_count: null,
            coverage_ratio: null,
            failure_category: null,
        });
    });
});
