import { describe, expect, it, vi } from 'vitest';
import {
    classifyAnalysisFailure,
    isValidAnalysisRequestId,
    recordAnalysisStepEvent,
    type AnalysisStepEventClient,
} from './observability';

function eventClient(error: { code?: string } | null = null) {
    const insert = vi.fn().mockResolvedValue({ error });
    const from = vi.fn(() => ({ insert }));
    return { client: { from } as AnalysisStepEventClient, from, insert };
}

describe('analysis observability', () => {
    it('validates canonical request UUIDs', () => {
        expect(isValidAnalysisRequestId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
        expect(isValidAnalysisRequestId('../not-a-request')).toBe(false);
        expect(isValidAnalysisRequestId(null)).toBe(false);
    });

    it.each([
        ['ANALYSIS_PERSISTENCE_ERROR', 'persistence'],
        ['SCRAPER_CONFIG_ERROR', 'configuration'],
        ['PROVIDER_SCHEMA_VALIDATION_FAILED', 'schema'],
        ['RELATIONSHIP_INCOMPLETE', 'incomplete'],
        ['MAX_TOTAL_CHARGE exceeded', 'budget'],
        ['Actor timed out', 'timeout'],
        ['APIFY_PROVIDER_ERROR', 'provider'],
        ['unexpected', 'unknown'],
    ] as const)('classifies %s without persisting the message', (message, category) => {
        expect(classifyAnalysisFailure(new Error(message))).toBe(category);
    });

    it('writes only bounded, PII-free event fields', async () => {
        const { client, insert } = eventClient();

        await expect(recordAnalysisStepEvent(client, {
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            step: 'collect',
            eventType: 'retrying',
            deliveryAttempt: 999,
            progress: -4,
            latencyMs: 123.7,
            failureCategory: 'provider',
        })).resolves.toBe(true);

        expect(insert).toHaveBeenCalledWith({
            request_id: '123e4567-e89b-42d3-a456-426614174000',
            step: 'collect',
            event_type: 'retrying',
            delivery_attempt: 100,
            progress: 0,
            latency_ms: 124,
            failure_category: 'provider',
        });
    });

    it('removes failure categories from successful events', async () => {
        const { client, insert } = eventClient();
        await recordAnalysisStepEvent(client, {
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            step: 'analyze',
            eventType: 'completed',
            failureCategory: 'unknown',
        });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({
            failure_category: null,
        }));
    });

    it('fails open when telemetry persistence is unavailable', async () => {
        const { client } = eventClient({ code: '42P01' });
        await expect(recordAnalysisStepEvent(client, {
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            step: 'profiles',
            eventType: 'started',
        })).resolves.toBe(false);
    });

    it('fails open within a deadline when telemetry never settles', async () => {
        const insert = vi.fn(() => new Promise<never>(() => undefined));
        const client = {
            from: vi.fn(() => ({ insert })),
        } as AnalysisStepEventClient;

        await expect(recordAnalysisStepEvent(client, {
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            step: 'collect',
            eventType: 'started',
        }, 1)).resolves.toBe(false);
    });
});
