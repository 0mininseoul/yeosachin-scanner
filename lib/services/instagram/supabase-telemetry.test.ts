import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    emit: vi.fn(),
    insert: vi.fn(),
    from: vi.fn(),
}));

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));

import { createSupabaseScraperTelemetryHook, toScraperTelemetryRow } from './supabase-telemetry';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

function telemetry(overrides: Record<string, unknown> = {}) {
    return {
        requestId,
        provider: 'selfhosted' as const,
        capability: 'profilesBatch' as const,
        request_count: 900,
        result_count: 900,
        raw_result_count: 900,
        unique_result_count: 900,
        unique_ratio: 1,
        fallback: false,
        latency_ms: 123,
        status: 'success' as const,
        estimated_cost_usd: 0,
        ...overrides,
    };
}

describe('scraper telemetry persistence row', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.insert.mockResolvedValue({ error: null });
        mocks.from.mockReturnValue({ insert: mocks.insert });
    });

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

    it('emits one bounded aggregate for a 900-account success', async () => {
        await createSupabaseScraperTelemetryHook({})(telemetry());

        expect(mocks.emit).toHaveBeenCalledOnce();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'scraper.batch_completed',
            severity: 'info',
            fields: expect.objectContaining({
                request_id: requestId,
                provider: 'selfhosted',
                operation: 'profilesBatch',
                input_count: 900,
                output_count: 900,
                result_count: 900,
                fallback: false,
                duration_ms: 123,
                estimated_cost_usd: 0,
                disposition: 'success',
            }),
        });
    });

    it('emits a safe failure and one aggregate fallback selection', async () => {
        await createSupabaseScraperTelemetryHook({})(telemetry({
            provider: 'apify',
            request_count: 1,
            result_count: 0,
            raw_result_count: 0,
            unique_result_count: 0,
            fallback: true,
            status: 'error',
            failure_category: 'timeout',
            estimated_cost_usd: 0.002,
            provider_error: 'secret provider response with private caption',
        }));

        expect(mocks.emit).toHaveBeenCalledTimes(2);
        expect(mocks.emit.mock.calls.map(call => call[0])).toEqual([
            expect.objectContaining({
                event: 'scraper.batch_failed',
                severity: 'error',
                fields: expect.objectContaining({
                    provider: 'apify',
                    operation: 'profilesBatch',
                    disposition: 'failure',
                    error_code: 'TIMEOUT',
                }),
            }),
            expect.objectContaining({
                event: 'scraper.fallback_selected',
                severity: 'warn',
                fields: expect.objectContaining({
                    provider: 'apify',
                    operation: 'profilesBatch',
                    disposition: 'fallback',
                }),
            }),
        ]);
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /secret provider response|private caption/
        );
    });

    it('keeps Axiom and Supabase failures independent and product-fail-open', async () => {
        mocks.emit.mockImplementation(() => {
            throw new Error('Axiom unavailable');
        });
        const hook = createSupabaseScraperTelemetryHook({
            SCRAPER_TELEMETRY_PERSIST: 'true',
        });

        await expect(hook(telemetry())).resolves.toBeUndefined();
        expect(mocks.insert).toHaveBeenCalledOnce();

        mocks.emit.mockReset();
        mocks.insert.mockRejectedValueOnce(new Error('Supabase unavailable'));
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(hook(telemetry())).resolves.toBeUndefined();
        expect(mocks.emit).toHaveBeenCalledOnce();
        warning.mockRestore();
    });
});
