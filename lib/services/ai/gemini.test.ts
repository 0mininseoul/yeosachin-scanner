import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
    generateContent: vi.fn(),
    prepareGoogleApplicationCredentials: vi.fn(),
}));

vi.mock('@google/genai', () => ({
    GoogleGenAI: class {
        models = { generateContent: mocks.generateContent };
    },
    MediaResolution: { MEDIA_RESOLUTION_LOW: 'low' },
    ThinkingLevel: { MINIMAL: 'minimal' },
}));

vi.mock('@/lib/services/google/credentials', () => ({
    prepareGoogleApplicationCredentials: mocks.prepareGoogleApplicationCredentials,
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: {
        from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })),
    },
}));

import { analyzeWithGemini } from './gemini';

const responseSchema = z.object({ value: z.string() }).strict();

function successfulResponse() {
    return {
        text: JSON.stringify({ value: 'ok' }),
        usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            totalTokenCount: 14,
            thoughtsTokenCount: 0,
        },
    };
}

function analyze(onTelemetry?: ReturnType<typeof vi.fn>) {
    return analyzeWithGemini('prompt', undefined, {
        schema: responseSchema,
        analysisType: 'cost_guard_test',
        skipTokenLog: true,
        onTelemetry,
    });
}

describe('analyzeWithGemini generation retry policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'false');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('does not retry an ambiguous generation and never exposes the provider error', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const providerSecret = 'fetch failed: ECONNRESET api-key=provider-secret';
        mocks.generateContent.mockRejectedValueOnce(new Error(providerSecret));

        const result = analyze();
        await expect(result).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR: Gemini generation status is unknown; the request was not retried.'
        );

        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain(providerSecret);
        consoleError.mockRestore();
    });

    it('bounds explicit 429 retries at the configured maximum', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent.mockRejectedValue(Object.assign(
            new Error('provider quota detail'),
            { status: 429 }
        ));

        const result = analyze();
        const rejection = expect(result).rejects.toThrow(
            'AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.'
        );
        await vi.runAllTimersAsync();
        await rejection;

        expect(mocks.generateContent).toHaveBeenCalledTimes(4);
    });

    it('retains success telemetry after a rate-limit backoff', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        mocks.generateContent
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockResolvedValueOnce(successfulResponse());

        const result = analyze(telemetry);
        await vi.runAllTimersAsync();

        await expect(result).resolves.toEqual({ value: 'ok' });
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
        expect(telemetry).toHaveBeenCalledTimes(1);
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
            tokenUsage: {
                promptTokens: 10,
                completionTokens: 4,
                totalTokens: 14,
                thinkingTokens: 0,
            },
        }));
    });

    it('does not retry empty or schema-invalid responses', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent.mockResolvedValueOnce({ text: '', usageMetadata: {} });
        await expect(analyze()).rejects.toThrow('Gemini response did not include text');
        expect(mocks.generateContent).toHaveBeenCalledTimes(1);

        mocks.generateContent.mockResolvedValueOnce({
            ...successfulResponse(),
            text: JSON.stringify({ wrong: true }),
        });
        await expect(analyze()).rejects.toThrow(
            'Gemini response did not match the required analysis schema'
        );
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    });
});
