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
import { issueReplayStatelessCapability } from './replay-stateless-capability';

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

    it('keeps production v2.12 callback and console telemetry byte-shape compatible', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const audit = stageAuditOptions();
        const providerSecret = 'fetch failed: ECONNRESET api-key=provider-secret';
        mocks.generateContent.mockRejectedValueOnce(new Error(providerSecret));

        const result = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.12',
            ...audit,
        });
        await expect(result).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR: Gemini generation status is unknown; the request was not retried.'
        );

        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(audit.onAttemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            attempt: 1,
            retryCount: 0,
            disposition: 'ambiguous',
            tokenUsage: null,
            usageComplete: false,
            estimatedCostUsd: null,
        }));
        expect(audit.onAttemptTelemetry.mock.calls[0]![0])
            .not.toHaveProperty('failureKind');
        const consoleAttempt = consoleLog.mock.calls.find(
            call => call[0] === 'Gemini SDK attempt telemetry:',
        );
        expect(consoleAttempt?.[1]).not.toHaveProperty('failureKind');
        expect(JSON.stringify(audit.onAttemptTelemetry.mock.calls))
            .not.toContain(providerSecret);
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain(providerSecret);
        consoleError.mockRestore();
        consoleLog.mockRestore();
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
        expect(attemptTelemetry.mock.calls[0]![0]).not.toHaveProperty('failureKind');
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
        expect(attemptTelemetry.mock.calls.every(
            call => !Object.hasOwn(call[0], 'failureKind'),
        )).toBe(true);
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
        expect(attemptTelemetry.mock.calls[0]![0]).not.toHaveProperty('failureKind');
        expect(attemptTelemetry.mock.calls[1]![0]).not.toHaveProperty('failureKind');
    });

    it('records provider dispatch only immediately before an SDK generation call', async () => {
        const providerDispatch = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(successfulResponse());

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.12',
            skipTokenLog: true,
            replayCapability: issueReplayStatelessCapability(),
            admissionDeadlineAtMs: performance.now() + 5_000,
            ...stageAuditOptions(),
            onProviderDispatch: providerDispatch,
        } as never)).resolves.toEqual({ value: 'ok' });

        expect(providerDispatch).toHaveBeenCalledOnce();
        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(providerDispatch.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.generateContent.mock.invocationCallOrder[0]);
    });

    it('does not record a provider dispatch when the resolver deadline expires after attempt intent', async () => {
        vi.useFakeTimers();
        const providerDispatch = vi.fn();
        const deadlineAtMs = performance.now() + 1;
        const onBeforeAttempt = vi.fn(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.12',
            skipTokenLog: true,
            replayCapability: issueReplayStatelessCapability(),
            admissionDeadlineAtMs: deadlineAtMs,
            requestId: stageRequestId,
            onBeforeAttempt,
            onAttemptTelemetry: vi.fn(),
            onProviderDispatch: providerDispatch,
        } as never)).rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');

        expect(onBeforeAttempt).toHaveBeenCalledOnce();
        expect(providerDispatch).not.toHaveBeenCalled();
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it.each([
        'ai-stage-policy-v2.11',
        'ai-stage-policy-v2.12',
        'ai-stage-policy-v2.13',
        'ai-stage-policy-v2.16',
        'ai-stage-policy-v2.17',
    ] as const)(
        'runs a replay provider fence once for each SDK attempt under %s, including a retry',
        async aiStagePolicyVersion => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockResolvedValueOnce(successfulResponse());
        const fence = vi.fn(
            <T,>(task: () => Promise<T>): Promise<T> => task(),
        ) as unknown as <T>(task: () => Promise<T>) => Promise<T>;
        const providerDispatch = vi.fn();
        const audit = stageAuditOptions();
        const result = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: aiStagePolicyVersion as never,
            skipTokenLog: true,
            replayCapability: issueReplayStatelessCapability(),
            runProviderAttempt: fence,
            onProviderDispatch: providerDispatch,
            ...audit,
        });
        await vi.runAllTimersAsync();
        await expect(result).resolves.toEqual({ value: 'ok' });
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
        expect(fence).toHaveBeenCalledTimes(2);
        expect(providerDispatch).toHaveBeenCalledTimes(2);
        const failedAttempt = audit.onAttemptTelemetry.mock.calls[0]![0];
        if (
            aiStagePolicyVersion === 'ai-stage-policy-v2.12'
            || aiStagePolicyVersion === 'ai-stage-policy-v2.13'
            || aiStagePolicyVersion === 'ai-stage-policy-v2.16'
            || aiStagePolicyVersion === 'ai-stage-policy-v2.17'
        ) {
            expect(failedAttempt).toMatchObject({ failureKind: 'http_429' });
        } else {
            expect(failedAttempt).not.toHaveProperty('failureKind');
        }
        },
    );

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
        expect(attemptTelemetry.mock.calls[0]![0]).not.toHaveProperty('failureKind');
    });

    it('does not retry schema-invalid responses', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        mocks.generateContent.mockResolvedValueOnce(responseWithText(JSON.stringify({ wrong: true })));
        await expect(analyze()).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');
        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    });

    it('emits PII-free feature response rejection diagnostics for aggregation', async () => {
        const rawSecret = 'private-profile-value';
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const audit = stageAuditOptions();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(JSON.stringify({
            value: 123,
            unexpectedPrivateField: rawSecret,
        })));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            analysisType: 'feature_analysis',
            ...audit,
        })).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');

        expect(audit.onAttemptTelemetry).toHaveBeenCalledWith(
            expect.objectContaining({
                disposition: 'response_rejected',
                responseRejection: {
                    category: 'schema_validation',
                    issues: [
                        { path: 'value', code: 'invalid_type' },
                        { path: '$', code: 'unrecognized_keys' },
                    ],
                    truncated: false,
                },
            })
        );
        expect(consoleWarn).toHaveBeenCalledWith(
            'ANALYSIS_V2_AI_RESPONSE_REJECTION_DIAGNOSTIC',
            expect.stringContaining('"stage":"featureAnalysis"')
        );
        expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(rawSecret);
        expect(JSON.stringify(audit.onAttemptTelemetry.mock.calls)).not.toContain(rawSecret);
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

    it('maps the v2.15 feature output cap into the generated SDK request', async () => {
        const images = Array.from(
            { length: 12 },
            (_, index) => `image-${index}`,
        );

        await analyzeWithGemini('sensitive prompt', images, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            aiStagePolicyVersion: 'ai-stage-policy-v2.15',
            ...stageAuditOptions(),
        });

        expect(mocks.generateContent).toHaveBeenCalledOnce();
        const request = mocks.generateContent.mock.calls[0][0];
        expect(request).toMatchObject({
            model: 'gemini-3-flash-preview',
            config: {
                maxOutputTokens: 4_096,
                mediaResolution: 'medium',
                thinkingConfig: { thinkingLevel: 'medium' },
                responseMimeType: 'application/json',
                responseJsonSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false,
                },
            },
        });
        expect(request.contents[0].parts.filter(
            (part: { inlineData?: unknown }) => part.inlineData,
        )).toHaveLength(11);
    });

    it('admits only the bounded v2.9 two-account gender microbatch media override', async () => {
        const images = Array.from({ length: 11 }, (_, index) => `image-${index}`);
        await analyzeWithGemini('prompt', images, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.9',
            maxImages: 10,
            ...stageAuditOptions(),
        });

        const request = mocks.generateContent.mock.calls[0][0];
        expect(request.config).toMatchObject({ maxOutputTokens: 1_024 });
        expect(request.contents[0].parts.filter(
            (part: { inlineData?: unknown }) => part.inlineData
        )).toHaveLength(10);
        await expect(analyzeWithGemini('prompt', images, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.9',
            maxImages: 11,
            ...stageAuditOptions(),
        })).rejects.toThrow('maxImages override is restricted to bounded v2.9 gender batches');
    });

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

    it('rejects forged or legacy boolean stateless replay bypasses', async () => {
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...stageAuditOptions(),
            skipTokenLog: true,
            replayCapability: {} as never,
        })).rejects.toThrow('Gemini replay capability is invalid');

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...stageAuditOptions(),
            skipTokenLog: true,
            statelessReplay: true,
        } as never)).rejects.toThrow('cannot skip durable token logging');
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it('rejects non-replay and invalid-policy provider fences before an SDK call', async () => {
        mocks.generateContent.mockResolvedValue(successfulResponse());
        const identityFence = vi.fn(
            <T,>(task: () => Promise<T>): Promise<T> => task(),
        ) as unknown as <T>(task: () => Promise<T>) => Promise<T>;
        const replayCapability = issueReplayStatelessCapability();
        const calls = [
            analyzeWithGemini('prompt', undefined, {
                schema: responseSchema,
                stage: 'genderTriage',
                aiStagePolicyVersion: 'ai-stage-policy-v2.11',
                runProviderAttempt: identityFence,
                ...stageAuditOptions(),
            }),
            analyzeWithGemini('prompt', undefined, {
                schema: responseSchema,
                stage: 'genderTriage',
                aiStagePolicyVersion: 'ai-stage-policy-v2.10',
                skipTokenLog: true,
                replayCapability,
                runProviderAttempt: identityFence,
                ...stageAuditOptions(),
            }),
        ];

        await expect(Promise.all(calls)).rejects.toThrow(
            'Gemini provider attempt fence is restricted to stateless replay v2.11 gender-quality stages',
        );
        expect(identityFence).not.toHaveBeenCalled();
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

    function replayProviderFence(limit: number) {
        let active = 0;
        const waiters: Array<() => void> = [];
        return async function run<T>(task: () => Promise<T>): Promise<T> {
            const execute = async () => {
                try {
                    return await task();
                } finally {
                    active--;
                    waiters.shift()?.();
                }
            };
            if (active < limit && waiters.length === 0) {
                active++;
                return execute();
            }
            await new Promise<void>(resolve => waiters.push(() => {
                active++;
                resolve();
            }));
            return execute();
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

    it.each([
        ['genderTriage', 4],
        ['featureAnalysis', 4],
        ['privateAccountName', 2],
    ] as const)('enforces the v2.7 %s stage semaphore at %i', async (stage, concurrency) => {
        const deferred = deferredGenerations();
        const options = {
            schema: responseSchema,
            stage,
            aiStagePolicyVersion: 'ai-stage-policy-v2.7' as const,
            ...stageAuditOptions(),
        };
        const calls = Array.from({ length: concurrency + 1 }, () =>
            analyzeWithGemini('prompt', undefined, options)
        );

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency));
        expect(deferred.maximumActive()).toBe(concurrency);
        deferred.releases.splice(0, concurrency).forEach(release => release());
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency + 1));
        deferred.releases.splice(0).forEach(release => release());

        await expect(Promise.all(calls)).resolves.toHaveLength(concurrency + 1);
        expect(deferred.maximumActive()).toBe(concurrency);
    });

    it.each([
        ['genderTriage', 6],
        ['featureAnalysis', 3],
        ['privateAccountName', 2],
    ] as const)(
        'matches the v2.8 scheduler %s cap at %i without hidden queueing',
        async (stage, concurrency) => {
            const deferred = deferredGenerations();
            const options = {
                schema: responseSchema,
                stage,
                aiStagePolicyVersion: 'ai-stage-policy-v2.8' as const,
                ...stageAuditOptions(),
            };
            const active = Array.from({ length: concurrency }, () =>
                analyzeWithGemini('prompt', undefined, options)
            );

            await vi.waitFor(() => (
                expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency)
            ));
            await expect(analyzeWithGemini('prompt', undefined, options))
                .rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency);
            deferred.releases.splice(0).forEach(release => release());
            await expect(Promise.all(active)).resolves.toHaveLength(concurrency);
            expect(deferred.maximumActive()).toBe(concurrency);
        },
    );

    it('queues injected v2.11 provider attempts before local stage admission', async () => {
        const deferred = deferredGenerations();
        const runShared = replayProviderFence(8);
        const runTriage = replayProviderFence(6);
        const replayCapability = issueReplayStatelessCapability();
        const runProviderAttempt = <T,>(task: () => Promise<T>) => (
            runTriage(() => runShared(task))
        );
        const calls = Array.from({ length: 7 }, () => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
            skipTokenLog: true,
            replayCapability,
            runProviderAttempt,
            ...stageAuditOptions(),
        }));
        const settled = Promise.allSettled(calls);

        try {
            await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(6));
            deferred.releases.splice(0).forEach(release => release());
            await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(7));
        } finally {
            deferred.releases.splice(0).forEach(release => release());
            await settled;
        }

        expect(await settled).toEqual(Array.from({ length: 7 }, () => (
            expect.objectContaining({ status: 'fulfilled' })
        )));
    });

    it('settles mixed v2.11 replay fences without inner capacity rejection or duplicate SDK calls', async () => {
        type ReplayStage = 'genderTriage' | 'featureAnalysis' | 'privateAccountName';
        const makeTasks = (stage: ReplayStage, count: number) => Array.from(
            { length: count },
            (_, index) => ({ stage, id: `${stage}-${index + 1}` }),
        );
        const tasks = [
            ...makeTasks('genderTriage', 7),
            ...makeTasks('featureAnalysis', 4),
            ...makeTasks('privateAccountName', 3),
        ];
        const maxByStage: Record<ReplayStage, number> = {
            genderTriage: 0,
            featureAnalysis: 0,
            privateAccountName: 0,
        };
        const activeByStage: Record<ReplayStage, number> = {
            genderTriage: 0,
            featureAnalysis: 0,
            privateAccountName: 0,
        };
        const terminalCounts = new Map(tasks.map(task => [task.id, 0]));
        const providerCalls = new Map(tasks.map(task => [task.id, 0]));
        const releases: Array<() => void> = [];
        let active = 0;
        let maximumActive = 0;
        mocks.generateContent.mockImplementation(request => new Promise(resolve => {
            const prompt = (request as {
                contents: Array<{ parts: Array<{ text?: string }> }>;
            }).contents[0]!.parts[0]!.text!;
            const [stage, id] = prompt.split('/') as [ReplayStage, string];
            active++;
            maximumActive = Math.max(maximumActive, active);
            activeByStage[stage]++;
            maxByStage[stage] = Math.max(maxByStage[stage], activeByStage[stage]);
            providerCalls.set(id, providerCalls.get(id)! + 1);
            releases.push(() => {
                active--;
                activeByStage[stage]--;
                resolve(successfulResponse());
            });
        }));

        const runShared = replayProviderFence(8);
        const runTriage = replayProviderFence(6);
        const runFeature = replayProviderFence(3);
        const runPrivate = replayProviderFence(2);
        const runProviderAttemptByStage = {
            genderTriage: <T,>(task: () => Promise<T>) => runTriage(() => runShared(task)),
            featureAnalysis: <T,>(task: () => Promise<T>) => runFeature(() => runShared(task)),
            privateAccountName: <T,>(task: () => Promise<T>) => runPrivate(() => runShared(task)),
        };
        const replayCapability = issueReplayStatelessCapability();
        const calls = tasks.map(task => analyzeWithGemini(`${task.stage}/${task.id}`, undefined, {
            schema: responseSchema,
            stage: task.stage,
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
            skipTokenLog: true,
            replayCapability,
            runProviderAttempt: runProviderAttemptByStage[task.stage],
            requestId: stageRequestId,
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(() => {
                terminalCounts.set(task.id, terminalCounts.get(task.id)! + 1);
            }),
        }));

        let released = 0;
        while (released < tasks.length) {
            await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
            const batch = releases.splice(0);
            released += batch.length;
            batch.forEach(release => release());
        }

        await expect(Promise.all(calls)).resolves.toEqual(
            Array.from({ length: tasks.length }, () => ({ value: 'ok' })),
        );
        expect(maximumActive).toBe(8);
        expect(maxByStage.genderTriage).toBe(6);
        expect(maxByStage.featureAnalysis).toBeLessThanOrEqual(3);
        expect(maxByStage.privateAccountName).toBeLessThanOrEqual(2);
        expect([...providerCalls.values()]).toEqual(
            Array.from({ length: tasks.length }, () => 1),
        );
        expect([...terminalCounts.values()]).toEqual(
            Array.from({ length: tasks.length }, () => 1),
        );
    });

    it('never queues a resolver when either bounded slot is unavailable', async () => {
        const deferred = deferredGenerations();
        const resolverOptions = {
            schema: responseSchema,
            stage: 'genderResolution' as const,
            aiStagePolicyVersion: 'ai-stage-policy-v2.7' as const,
            ...stageAuditOptions(),
        };
        const first = analyzeWithGemini('prompt', undefined, resolverOptions);
        const second = analyzeWithGemini('prompt', undefined, resolverOptions);

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(2));
        await expect(analyzeWithGemini('prompt', undefined, resolverOptions))
            .rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);

        deferred.releases.splice(0).forEach(release => release());
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    });

    it('rejects resolver use under the frozen v2.6 policy', async () => {
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.6',
            ...stageAuditOptions(),
        })).rejects.toThrow('Unsupported AI stage');
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });
});
