import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

const mocks = vi.hoisted(() => ({
    generateContent: vi.fn(),
    prepareGoogleApplicationCredentials: vi.fn(),
    tokenUsageInsert: vi.fn(),
}));

vi.mock('@google/genai', () => ({
    GoogleGenAI: class {
        models = { generateContent: mocks.generateContent };
    },
    MediaResolution: {
        MEDIA_RESOLUTION_LOW: 'low',
        MEDIA_RESOLUTION_MEDIUM: 'medium',
        MEDIA_RESOLUTION_HIGH: 'high',
    },
    ThinkingLevel: {
        MINIMAL: 'minimal',
        LOW: 'low',
        MEDIUM: 'medium',
        HIGH: 'high',
    },
}));

vi.mock('@/lib/services/google/credentials', () => ({
    prepareGoogleApplicationCredentials: mocks.prepareGoogleApplicationCredentials,
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: {
        from: vi.fn(() => ({ insert: mocks.tokenUsageInsert })),
    },
}));

import {
    analyzeWithGemini,
    zodToGeminiResponseJsonSchema,
} from './gemini';
import {
    appearanceAnalysisResponseSchema,
    combinedAnalysisResponseSchema,
    exposureAnalysisResponseSchema,
    genderAnalysisResponseSchema,
    intimacyAnalysisResponseSchema,
    photogenicAnalysisResponseSchema,
} from './analysis-response-schemas';
import { deepRiskNarrativeResponseSchema } from './deep-risk-analysis';
import { createPrivateNameBatchResponseSchema } from './private-name-analysis';

const responseSchema = z.object({ value: z.string() }).strict();
const stageRequestId = '11111111-1111-4111-8111-111111111111';

function stageAuditOptions() {
    return {
        requestId: stageRequestId,
        onBeforeAttempt: vi.fn().mockResolvedValue(undefined),
        onAttemptTelemetry: vi.fn().mockResolvedValue(undefined),
    };
}

function responseWithText(
    text: string,
    usageMetadata: Record<string, unknown> | null = {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        thoughtsTokenCount: 0,
    }
) {
    return {
        text,
        candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text }] },
        }],
        ...(usageMetadata === null ? {} : { usageMetadata }),
    };
}

function successfulResponse() {
    return responseWithText(JSON.stringify({ value: 'ok' }));
}

function analyze(
    onTelemetry?: ReturnType<typeof vi.fn>,
    onAttemptTelemetry?: ReturnType<typeof vi.fn>
) {
    return analyzeWithGemini('prompt', undefined, {
        schema: responseSchema,
        analysisType: 'cost_guard_test',
        skipTokenLog: true,
        onTelemetry,
        onAttemptTelemetry,
    });
}

describe('analyzeWithGemini generation retry policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tokenUsageInsert.mockResolvedValue({ error: null });
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
        const attemptTelemetry = vi.fn();
        const providerSecret = 'fetch failed: ECONNRESET api-key=provider-secret';
        mocks.generateContent.mockRejectedValueOnce(new Error(providerSecret));

        const result = analyze(undefined, attemptTelemetry);
        await expect(result).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR: Gemini generation status is unknown; the request was not retried.'
        );

        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(attemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            attempt: 1,
            retryCount: 0,
            disposition: 'ambiguous',
            tokenUsage: null,
            usageComplete: false,
            estimatedCostUsd: null,
        }));
        expect(JSON.stringify(attemptTelemetry.mock.calls)).not.toContain(providerSecret);
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain(providerSecret);
        consoleError.mockRestore();
    });

    it('does not retry a rate-limit phrase without an explicit 429 status', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const attemptTelemetry = vi.fn();
        mocks.generateContent.mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED rate limit'));

        await expect(analyze(undefined, attemptTelemetry)).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR'
        );

        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(attemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            disposition: 'ambiguous',
        }));
    });

    it('bounds explicit 429 retries at the configured maximum', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent.mockRejectedValue(Object.assign(
            new Error('provider quota detail'),
            { status: 429 }
        ));

        const attemptTelemetry = vi.fn();
        const result = analyze(undefined, attemptTelemetry);
        const rejection = expect(result).rejects.toThrow(
            'AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.'
        );
        await vi.runAllTimersAsync();
        await rejection;

        expect(mocks.generateContent).toHaveBeenCalledTimes(4);
        expect(attemptTelemetry).toHaveBeenCalledTimes(4);
        expect(attemptTelemetry.mock.calls.map(call => call[0].disposition))
            .toEqual(['rate_limited', 'rate_limited', 'rate_limited', 'rate_limited']);
        expect(attemptTelemetry.mock.calls.map(call => call[0].retryCount))
            .toEqual([0, 1, 2, 3]);
    });

    it('retains success telemetry after a rate-limit backoff', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        const attemptTelemetry = vi.fn();
        mocks.generateContent
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockResolvedValueOnce(successfulResponse());

        const result = analyze(telemetry, attemptTelemetry);
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
        expect(attemptTelemetry.mock.calls.map(call => call[0].disposition))
            .toEqual(['rate_limited', 'success']);
    });

    it('logs known usage and attempt telemetry before rejecting an empty response', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        const attemptTelemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText('', {
                promptTokenCount: 12,
                candidatesTokenCount: 0,
                totalTokenCount: 12,
                thoughtsTokenCount: 0,
        }));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'empty_response_test',
            requestId: 'request-1',
            onTelemetry: telemetry,
            onAttemptTelemetry: attemptTelemetry,
        })).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');

        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(mocks.tokenUsageInsert).toHaveBeenCalledTimes(1);
        expect(mocks.tokenUsageInsert).toHaveBeenCalledWith(expect.objectContaining({
            request_id: 'request-1',
            prompt_tokens: 12,
            completion_tokens: 0,
            total_tokens: 12,
            analysis_type: 'empty_response_test',
        }));
        expect(telemetry).not.toHaveBeenCalled();
        expect(attemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            disposition: 'response_rejected',
            tokenUsage: {
                promptTokens: 12,
                completionTokens: 0,
                totalTokens: 12,
                thinkingTokens: 0,
            },
        }));
    });

    it('does not retry schema-invalid responses', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        mocks.generateContent.mockResolvedValueOnce(responseWithText(JSON.stringify({ wrong: true })));
        await expect(analyze()).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');
        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    });

    it('rejects multiple candidates and non-natural finish reasons with attempt telemetry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const attemptTelemetry = vi.fn();
        const first = successfulResponse();
        mocks.generateContent.mockResolvedValueOnce({
            ...first,
            candidates: [...first.candidates, ...first.candidates],
        });

        await expect(analyze(undefined, attemptTelemetry)).rejects.toThrow(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR'
        );
        expect(attemptTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({
            disposition: 'response_rejected',
            finishReason: null,
        }));

        mocks.generateContent.mockResolvedValueOnce({
            ...successfulResponse(),
            candidates: [{
                finishReason: 'MAX_TOKENS',
                content: { parts: [{ text: JSON.stringify({ value: 'ok' }) }] },
            }],
        });
        await expect(analyze(undefined, attemptTelemetry)).rejects.toThrow(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR'
        );
        expect(attemptTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({
            disposition: 'response_rejected',
            finishReason: 'MAX_TOKENS',
        }));
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['missing', null],
        ['malformed', {
            promptTokenCount: 10,
            candidatesTokenCount: '4',
            totalTokenCount: 14,
        }],
    ] as const)(
        'marks %s usage unknown without fabricating zero tokens or cost',
        async (status, usageMetadata) => {
            vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const telemetry = vi.fn();
            const attemptTelemetry = vi.fn();
            mocks.generateContent.mockResolvedValueOnce(responseWithText(
                JSON.stringify({ value: 'ok' }),
                usageMetadata
            ));

            await expect(analyzeWithGemini('prompt', undefined, {
                schema: responseSchema,
                analysisType: 'unknown_usage_test',
                onTelemetry: telemetry,
                onAttemptTelemetry: attemptTelemetry,
            })).resolves.toEqual({ value: 'ok' });

            expect(mocks.tokenUsageInsert).not.toHaveBeenCalled();
            expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
                tokenUsage: null,
                usageComplete: false,
                usageMetadataStatus: status,
                estimatedCostUsd: null,
            }));
            expect(attemptTelemetry).toHaveBeenCalledWith(
                expect.objectContaining({
                    disposition: 'success',
                    tokenUsage: null,
                    usageComplete: false,
                    usageMetadataStatus: status,
                    estimatedCostUsd: null,
                }),
                { value: 'ok' }
            );
        }
    );

    it('distinguishes complete true-zero usage from missing metadata', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            {
                promptTokenCount: 0,
                candidatesTokenCount: 0,
                totalTokenCount: 0,
                thoughtsTokenCount: 0,
            }
        ));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'zero_usage_test',
            onTelemetry: telemetry,
        })).resolves.toEqual({ value: 'ok' });
        expect(mocks.tokenUsageInsert).toHaveBeenCalledWith(expect.objectContaining({
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            estimated_cost_usd: 0,
        }));
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
            tokenUsage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                thinkingTokens: 0,
            },
            usageComplete: true,
            usageMetadataStatus: 'complete',
            estimatedCostUsd: 0,
        }));
    });

    it('infers omitted thinking tokens from an exact total and rejects inconsistent totals', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const completeTelemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                totalTokenCount: 20,
            }
        ));

        await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            onTelemetry: completeTelemetry,
        });
        expect(completeTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            usageComplete: true,
            tokenUsage: expect.objectContaining({ thinkingTokens: 6 }),
        }));

        const malformedTelemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                thoughtsTokenCount: 2,
                totalTokenCount: 20,
            }
        ));
        await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            onTelemetry: malformedTelemetry,
        });
        expect(malformedTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            usageComplete: false,
            usageMetadataStatus: 'malformed',
            tokenUsage: null,
            estimatedCostUsd: null,
        }));
    });
});

describe('analyzeWithGemini stage request policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tokenUsageInsert.mockResolvedValue({ error: null });
        mocks.generateContent.mockResolvedValue(successfulResponse());
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'true');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('resumes a durable stage at the supplied absolute attempt and keeps retries contiguous', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockResolvedValueOnce(successfulResponse());
        const audit = stageAuditOptions();

        const result = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            analysisType: 'resumed_gender_triage',
            startingAttempt: 2,
            ...audit,
        });
        await vi.runAllTimersAsync();

        await expect(result).resolves.toEqual({ value: 'ok' });
        expect(audit.onBeforeAttempt.mock.calls.map(call => call[0].attempt))
            .toEqual([2, 3]);
        expect(audit.onBeforeAttempt.mock.calls.map(call => call[0].retryCount))
            .toEqual([1, 2]);
        expect(audit.onAttemptTelemetry.mock.calls.map(call => call[0].attempt))
            .toEqual([2, 3]);
    });

    it.each([
        ['genderTriage', 'gemini-3.1-flash-lite', 'minimal', 'low', 512, 5],
        ['featureAnalysis', 'gemini-3.1-flash-lite', 'medium', 'medium', 2_048, 11],
        ['highRiskNarrative', 'gemini-3-flash-preview', 'high', 'medium', 4_096, 11],
        ['privateAccountName', 'gemini-3.1-flash-lite', 'minimal', 'low', 8_192, 0],
    ] as const)(
        'maps the %s policy into the generated SDK request',
        async (stage, model, thinking, resolution, maxOutputTokens, expectedMediaCount) => {
            const images = Array.from({ length: 12 }, (_, index) => `image-${index}`);

            await analyzeWithGemini('sensitive prompt', images, {
                schema: responseSchema,
                stage,
                ...stageAuditOptions(),
            });

            const request = mocks.generateContent.mock.calls[0][0];
            expect(request).toMatchObject({
                model,
                config: {
                    maxOutputTokens,
                    mediaResolution: resolution,
                    thinkingConfig: { thinkingLevel: thinking },
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: 'object',
                        properties: { value: { type: 'string' } },
                        required: ['value'],
                        additionalProperties: false,
                    },
                },
            });
            const mediaParts = request.contents[0].parts.filter(
                (part: { inlineData?: unknown }) => part.inlineData
            );
            expect(mediaParts).toHaveLength(expectedMediaCount);
        }
    );

    it('allows explicit model, thinking, resolution, and output overrides without cost-mode coupling', async () => {
        await analyzeWithGemini('prompt', ['image'], {
            schema: responseSchema,
            stage: 'featureAnalysis',
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'LOW',
            mediaResolution: 'HIGH',
            maxOutputTokens: 777,
            ...stageAuditOptions(),
        });

        expect(mocks.generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-3-flash-preview',
            config: expect.objectContaining({
                maxOutputTokens: 777,
                mediaResolution: 'high',
                thinkingConfig: { thinkingLevel: 'low' },
            }),
        }));
    });

    it('composes one explicit field with unrelated V1 cost-optimized defaults', async () => {
        await analyzeWithGemini('prompt', Array.from({ length: 11 }, () => 'image'), {
            schema: responseSchema,
            thinkingLevel: 'HIGH',
            skipTokenLog: true,
        });

        const request = mocks.generateContent.mock.calls[0][0];
        expect(request.model).toBe('gemini-3.1-flash-lite');
        expect(request.config).toMatchObject({
            thinkingConfig: { thinkingLevel: 'high' },
            mediaResolution: 'low',
            maxOutputTokens: 1_024,
        });
        expect(request.contents[0].parts).toHaveLength(4);
    });

    it('emits non-PII stage telemetry with model policy, media, latency, tokens, and cost', async () => {
        const onTelemetry = vi.fn();
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await analyzeWithGemini('do-not-leak-this-prompt', ['image-1', 'image-2'], {
            schema: responseSchema,
            stage: 'featureAnalysis',
            analysisType: 'feature_analysis',
            ...stageAuditOptions(),
            onTelemetry,
        });

        expect(onTelemetry).toHaveBeenCalledWith({
            tokenUsage: {
                promptTokens: 10,
                completionTokens: 4,
                totalTokens: 14,
                thinkingTokens: 0,
            },
            usageComplete: true,
            usageMetadataStatus: 'complete',
            modelName: 'gemini-3.1-flash-lite',
            location: 'global',
            stage: 'featureAnalysis',
            thinkingLevel: 'MEDIUM',
            mediaCount: 2,
            mediaResolution: 'MEDIUM',
            promptVersion: 'feature-analysis-v3',
            schemaVersion: 3,
            maxOutputTokens: 2_048,
            latencyMs: expect.any(Number),
            estimatedCostUsd: expect.any(Number),
        });
        expect(JSON.stringify(onTelemetry.mock.calls[0][0])).not.toContain('do-not-leak');
        expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('do-not-leak');
    });

    it('preserves the legacy cost-optimized defaults when no stage options are supplied', async () => {
        await analyzeWithGemini('prompt', ['one', 'two', 'three', 'four'], {
            schema: responseSchema,
            skipTokenLog: true,
        });

        const request = mocks.generateContent.mock.calls[0][0];
        expect(request.model).toBe('gemini-3.1-flash-lite');
        expect(request.config).toMatchObject({
            maxOutputTokens: 1_024,
            mediaResolution: 'low',
            thinkingConfig: { thinkingLevel: 'minimal' },
        });
        expect(request.contents[0].parts).toHaveLength(4);
    });

    it('requires an auditable stage identity and forbids bypassing durable stage logs', async () => {
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
        })).rejects.toThrow('valid request UUID and durable attempt callbacks');

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: 'not-a-uuid',
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
        })).rejects.toThrow('valid request UUID and durable attempt callbacks');

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...stageAuditOptions(),
            skipTokenLog: true,
        })).rejects.toThrow('cannot skip durable token logging');
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it('fails closed around both durable stage audit boundaries', async () => {
        const beforeFailure = vi.fn().mockRejectedValue(new Error('database unavailable'));
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt: beforeFailure,
            onAttemptTelemetry: vi.fn(),
        })).rejects.toThrow('AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR');
        expect(mocks.generateContent).not.toHaveBeenCalled();

        const onBeforeAttempt = vi.fn().mockResolvedValue(undefined);
        const onAttemptTelemetry = vi.fn().mockRejectedValue(new Error('database unavailable'));
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt,
            onAttemptTelemetry,
        })).rejects.toThrow('AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR');
        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(onBeforeAttempt.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.generateContent.mock.invocationCallOrder[0]);
    });

    it.each([
        'ANALYSIS_V2_AI_CAPACITY_PENDING',
        'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
        'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
    ])('preserves the pre-SDK admission signal %s without usage telemetry', async code => {
        const onAttemptTelemetry = vi.fn();
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt: vi.fn().mockRejectedValue(new Error(code)),
            onAttemptTelemetry,
        })).rejects.toThrow(code);
        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(onAttemptTelemetry).not.toHaveBeenCalled();
    });

    it('durably emits a stage attempt even when SDK usage metadata is missing', async () => {
        const audit = stageAuditOptions();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            null
        ));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...audit,
        })).resolves.toEqual({ value: 'ok' });

        expect(audit.onBeforeAttempt).toHaveBeenCalledOnce();
        expect(audit.onAttemptTelemetry).toHaveBeenCalledWith(
            expect.objectContaining({
                disposition: 'success',
                usageMetadataStatus: 'missing',
                tokenUsage: null,
            }),
            { value: 'ok' }
        );
    });

    it('preserves non-optimized V1 model and generation defaults while adding strict JSON output', async () => {
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'false');
        vi.stubEnv('VERTEX_AI_MODEL', 'gemini-legacy-override');

        await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            skipTokenLog: true,
        });

        expect(mocks.generateContent).toHaveBeenCalledWith({
            model: 'gemini-legacy-override',
            contents: expect.any(Array),
            config: {
                responseMimeType: 'application/json',
                responseJsonSchema: expect.objectContaining({
                    type: 'object',
                    additionalProperties: false,
                }),
                httpOptions: { timeout: 210_000 },
            },
        });
    });
});

describe('Gemini response JSON Schema mapping', () => {
    it('keeps strict structure, converts literals, and removes unsupported schema keywords', () => {
        const schema = z.object({
            kind: z.literal('ok'),
            id: z.string().regex(/^[a-z]+$/).min(2).max(12),
        }).strict();

        const mapped = zodToGeminiResponseJsonSchema(schema);

        expect(mapped).toEqual({
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['ok'] },
                id: { type: 'string' },
            },
            required: ['kind', 'id'],
            additionalProperties: false,
        });
        expect(JSON.stringify(mapped)).not.toContain('$schema');
        expect(JSON.stringify(mapped)).not.toContain('pattern');
    });

    it('maps the model wire input for transforms and uses supported tuple prefix items', () => {
        const schema = z.object({
            transformed: z.string().transform(value => value.length),
            lines: z.tuple([z.string(), z.string()]),
        }).strict();

        expect(zodToGeminiResponseJsonSchema(schema)).toEqual({
            type: 'object',
            properties: {
                transformed: { type: 'string' },
                lines: {
                    type: 'array',
                    prefixItems: [{ type: 'string' }, { type: 'string' }],
                },
            },
            required: ['transformed', 'lines'],
            additionalProperties: false,
        });
    });

    it('maps every existing V1 response schema without weakening runtime validation', () => {
        const schemas: ZodType[] = [
            appearanceAnalysisResponseSchema,
            combinedAnalysisResponseSchema,
            exposureAnalysisResponseSchema,
            genderAnalysisResponseSchema,
            intimacyAnalysisResponseSchema,
            photogenicAnalysisResponseSchema,
            deepRiskNarrativeResponseSchema,
            createPrivateNameBatchResponseSchema(['expected-id']),
        ];

        for (const schema of schemas) {
            expect(zodToGeminiResponseJsonSchema(schema)).toEqual(expect.any(Object));
        }
        expect(() => deepRiskNarrativeResponseSchema.parse({ lines: ['invalid', 'invalid'] }))
            .toThrow();
    });

    it('keeps large private-name batch cardinality out of the Vertex response schema', () => {
        const expectedIds = Array.from({ length: 100 }, (_, index) => `account-${index}`);
        const schema = createPrivateNameBatchResponseSchema(expectedIds);
        const mapped = zodToGeminiResponseJsonSchema(schema);

        expect(mapped).not.toHaveProperty('minItems');
        expect(mapped).not.toHaveProperty('maxItems');
        expect(() => schema.parse([])).toThrow('exact input count');
    });
});

describe('analyzeWithGemini process concurrency', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tokenUsageInsert.mockResolvedValue({ error: null });
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'false');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    function deferredGenerations() {
        const releases: Array<() => void> = [];
        let active = 0;
        let maximumActive = 0;
        mocks.generateContent.mockImplementation(() => new Promise(resolve => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            releases.push(() => {
                active--;
                resolve(successfulResponse());
            });
        }));
        return {
            releases,
            maximumActive: () => maximumActive,
        };
    }

    it('caps all process-shared generations at eight', async () => {
        const deferred = deferredGenerations();
        const calls = Array.from({ length: 12 }, () => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            skipTokenLog: true,
        }));

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(8));
        expect(deferred.maximumActive()).toBe(8);
        deferred.releases.splice(0, 8).forEach(release => release());
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(12));
        deferred.releases.splice(0).forEach(release => release());

        await expect(Promise.all(calls)).resolves.toHaveLength(12);
        expect(deferred.maximumActive()).toBe(8);
    });

    it('applies the lower high-risk narrative cap of three', async () => {
        const deferred = deferredGenerations();
        const calls = Array.from({ length: 5 }, () => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'highRiskNarrative',
            ...stageAuditOptions(),
        }));

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(3));
        expect(deferred.maximumActive()).toBe(3);
        deferred.releases.splice(0, 3).forEach(release => release());
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(5));
        deferred.releases.splice(0).forEach(release => release());

        await expect(Promise.all(calls)).resolves.toHaveLength(5);
        expect(deferred.maximumActive()).toBe(3);
    });
});
