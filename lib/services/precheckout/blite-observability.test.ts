import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    emit: vi.fn(),
}));

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));

import { createPrecheckoutBliteObservability } from './blite-observability';

const preflightId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('precheckout B-lite observability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('emits the durable completion checkpoint with only bounded fields', () => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 100,
            now: () => 225,
        });

        observability.completed();

        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.completed',
            severity: 'info',
            fields: {
                preflight_id: preflightId,
                provider: 'gemini',
                operation: 'precheckout_blite',
                duration_ms: 125,
                disposition: 'success',
            },
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /username|image_url|bio|caption|prompt|model_output/i,
        );
    });

    it.each([
        'terminal_before_48',
        'unresolved_at_48',
        'demo_error',
    ] as const)('emits a bounded fallback latch for %s', reason => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 100,
            now: () => 225,
        });

        observability.fallbackLatched(reason);

        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.fallback_latched',
            severity: 'info',
            fields: {
                preflight_id: preflightId,
                operation: 'precheckout_blite',
                duration_ms: 125,
                disposition: reason,
            },
        });
        const serialized = JSON.stringify(mocks.emit.mock.calls);
        expect(serialized).not.toMatch(/username|full_name|bio|caption|url|token|email/i);
    });

    it('emits a bounded fallback demo completion outcome', () => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 100,
            now: () => 225,
        });

        observability.demoCompleted();

        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.demo_completed',
            severity: 'info',
            fields: {
                preflight_id: preflightId,
                operation: 'precheckout_blite',
                duration_ms: 125,
                disposition: 'completed',
            },
        });
    });

    it('emits a bounded fallback demo failure outcome', () => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 100,
            now: () => 225,
        });

        observability.demoFailed();

        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.demo_failed',
            severity: 'error',
            fields: {
                preflight_id: preflightId,
                operation: 'precheckout_blite',
                duration_ms: 125,
                disposition: 'failed',
            },
        });
    });

    it.each([
        ['configuration', 'VALIDATION_ERROR'],
        ['schema', 'VALIDATION_ERROR'],
        ['deadline', 'TIMEOUT'],
        ['quota', 'RATE_LIMITED'],
        ['provider', 'PROVIDER_ERROR'],
    ] as const)('maps profile collection category %s to %s', (category, errorCode) => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 200,
            now: () => 250,
        });

        observability.profileCollectionFailed(category);

        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.profile_collection_failed',
            severity: 'error',
            fields: {
                preflight_id: preflightId,
                provider: 'apify',
                operation: 'precheckout_blite',
                duration_ms: 50,
                disposition: 'failure',
                error_code: errorCode,
            },
        });
    });

    it('does not classify expected profile access denial as a provider failure', () => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 250,
            now: () => 300,
        });

        observability.profileCollectionFailed('access');

        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('emits one bounded inference failure and deduplicates later terminal outcomes', () => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 300,
            now: () => 375,
        });

        observability.inferenceFailed();
        observability.inferenceFailed();
        observability.completed();

        expect(mocks.emit).toHaveBeenCalledTimes(1);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.inference_failed',
            severity: 'error',
            fields: {
                preflight_id: preflightId,
                provider: 'gemini',
                operation: 'precheckout_blite',
                duration_ms: 75,
                disposition: 'failure',
                error_code: 'PROVIDER_ERROR',
            },
        });
    });

    it.each([
        ['ambiguous', 1, 'PROVIDER_ERROR'],
        ['rejected', 1, 'PROVIDER_ERROR'],
        ['response_rejected', 1, 'VALIDATION_ERROR'],
        ['rate_limited', 4, 'RATE_LIMITED'],
    ] as const)('maps terminal Gemini %s telemetry into one bounded failure', (
        disposition,
        attempt,
        errorCode,
    ) => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 400,
            now: () => 525,
        });

        observability.inferenceAttempt({
            tokenUsage: {
                promptTokens: 100,
                completionTokens: 20,
                totalTokens: 125,
                thinkingTokens: 5,
            },
            usageComplete: true,
            usageMetadataStatus: 'complete',
            modelName: 'gemini-3.1-flash-lite',
            location: 'global',
            stage: null,
            thinkingLevel: 'MINIMAL',
            mediaCount: 2,
            mediaResolution: 'LOW',
            promptVersion: null,
            schemaVersion: null,
            maxOutputTokens: 3_072,
            latencyMs: 80,
            estimatedCostUsd: 0.00001,
            attempt,
            retryCount: attempt - 1,
            disposition,
            finishReason: null,
            prompt: 'private prompt',
            modelOutput: 'private model output',
        } as never);
        observability.inferenceFailed();

        expect(mocks.emit).toHaveBeenCalledTimes(1);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'precheckout_blite.inference_failed',
            severity: 'error',
            fields: {
                preflight_id: preflightId,
                provider: 'gemini',
                operation: 'precheckout_blite',
                duration_ms: 125,
                disposition,
                error_code: errorCode,
                model: 'gemini-3.1-flash-lite',
                thinking_level: 'minimal',
                prompt_tokens: 100,
                completion_tokens: 20,
                thinking_tokens: 5,
                estimated_cost_usd: 0.00001,
                attempt,
            },
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain('private');
    });

    it('does not terminalize a retryable Gemini rate limit before the final attempt', () => {
        const observability = createPrecheckoutBliteObservability({
            preflightId,
            startedAtMs: 500,
            now: () => 550,
        });

        observability.inferenceAttempt({
            tokenUsage: null,
            usageComplete: false,
            usageMetadataStatus: 'missing',
            modelName: 'gemini-3.1-flash-lite',
            location: 'global',
            stage: null,
            thinkingLevel: 'MINIMAL',
            mediaCount: 2,
            mediaResolution: 'LOW',
            promptVersion: null,
            schemaVersion: null,
            maxOutputTokens: 3_072,
            latencyMs: 50,
            estimatedCostUsd: null,
            attempt: 1,
            retryCount: 0,
            disposition: 'rate_limited',
            finishReason: null,
        });

        expect(mocks.emit).not.toHaveBeenCalled();
    });
});
