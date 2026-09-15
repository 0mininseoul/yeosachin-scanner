import { describe, expect, it } from "vitest";
import { DEFAULT_COST_SENSITIVE_VERTEX_AI_MODEL, DEFAULT_VERTEX_AI_MODEL, estimateGeminiRequestCost, isVertexAICostOptimized, resolveVertexAIModel } from "../../lib/services/ai/gemini-cost";
import { classifyGeminiGenerationError, isAmbiguousGeminiGenerationError, isRecoverableGeminiResponseError } from "../../lib/services/ai/gemini-generation-policy";
import { combinedAnalysisResponseSchema, genderAnalysisResponseSchema } from "../../lib/services/ai/analysis-response-schemas";
import { GeminiResponseValidationError, parseGeminiJsonResponse } from "../../lib/services/ai/gemini-response";
import { DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY, MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS, MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES, MAX_VERTEX_AI_ANALYSIS_CONCURRENCY, MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY, getVertexAIAnalysisConcurrency, isAnalysisBatchFailureAboveThreshold } from "../../lib/services/ai/pipeline-config";
import { AI_SCHEDULER_POLICY_ID, parseAiSchedulerPolicySnapshot, selectAiSchedulerPolicyVersion } from "../../lib/services/ai/scheduler-policy";

describe("gemini-cost", () => {
    describe('resolveVertexAIModel', () => {
        it('uses the quality-first model by default', () => {
            expect(resolveVertexAIModel(undefined, false)).toBe(DEFAULT_VERTEX_AI_MODEL);
            expect(resolveVertexAIModel('  ', false)).toBe(DEFAULT_VERTEX_AI_MODEL);
        });

        it('uses Flash-Lite only when cost optimization is enabled', () => {
            expect(resolveVertexAIModel(undefined, true)).toBe(DEFAULT_COST_SENSITIVE_VERTEX_AI_MODEL);
        });

        it('preserves an explicit model override', () => {
            expect(resolveVertexAIModel(' custom-model ', false)).toBe('custom-model');
            expect(resolveVertexAIModel(' custom-model ', true)).toBe('custom-model');
        });
    });

    describe('isVertexAICostOptimized', () => {
        it('is opt-in and accepts explicit truthy values only', () => {
            expect(isVertexAICostOptimized(undefined)).toBe(false);
            expect(isVertexAICostOptimized('false')).toBe(false);
            expect(isVertexAICostOptimized('true')).toBe(true);
            expect(isVertexAICostOptimized('1')).toBe(true);
        });
    });

    describe('estimateGeminiRequestCost', () => {
        it('prices global Flash-Lite input, visible output, and thinking tokens', () => {
            const estimate = estimateGeminiRequestCost({
                promptTokens: 1_000_000,
                completionTokens: 750_000,
                thinkingTokens: 250_000,
                totalTokens: 2_000_000,
            }, 'gemini-3.1-flash-lite', 'global');

            expect(estimate).toMatchObject({
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                inputCostUsd: 0.25,
                outputCostUsd: 1.5,
                totalCostUsd: 1.75,
            });
        });

        it('infers billable reasoning output from total tokens for stored usage rows', () => {
            const estimate = estimateGeminiRequestCost({
                promptTokens: 1_000,
                completionTokens: 200,
                totalTokens: 1_500,
            }, 'gemini-3.1-flash-lite');

            expect(estimate?.outputTokens).toBe(500);
            expect(estimate?.totalCostUsd).toBe(0.001);
        });

        it('applies current non-global Vertex AI rates', () => {
            const estimate = estimateGeminiRequestCost({
                promptTokens: 1_000_000,
                completionTokens: 1_000_000,
                totalTokens: 2_000_000,
            }, 'gemini-3.1-flash-lite', 'asia-northeast3');

            expect(estimate?.inputCostUsd).toBe(0.275);
            expect(estimate?.outputCostUsd).toBe(1.65);
            expect(estimate?.totalCostUsd).toBe(1.925);
        });

        it('prices the previous configured model independently', () => {
            const estimate = estimateGeminiRequestCost({
                promptTokens: 1_000_000,
                completionTokens: 1_000_000,
                totalTokens: 2_000_000,
            }, 'gemini-3-flash-preview');

            expect(estimate?.totalCostUsd).toBe(3.5);
        });

        it('supports Vertex resource names and returns null for unknown pricing', () => {
            const known = estimateGeminiRequestCost({
                promptTokens: 1_000,
                completionTokens: 100,
                totalTokens: 1_100,
            }, 'projects/p/locations/global/publishers/google/models/gemini-3.1-flash-lite-001');

            expect(known?.canonicalModelName).toBe('gemini-3.1-flash-lite');
            expect(estimateGeminiRequestCost({
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
            }, 'unpriced-model')).toBeNull();
        });
    });
});

describe("gemini-generation-policy", () => {
    describe('classifyGeminiGenerationError', () => {
        it('only marks an explicit rate-limit rejection as retryable', () => {
            expect(classifyGeminiGenerationError({ status: 429, message: 'RESOURCE_EXHAUSTED' }))
                .toBe('rate_limited');
            expect(classifyGeminiGenerationError(new Error('rate limit exceeded')))
                .toBe('ambiguous');
            expect(classifyGeminiGenerationError(new Error('RESOURCE_EXHAUSTED')))
                .toBe('ambiguous');
        });

        it('treats server and transport failures as ambiguous', () => {
            expect(classifyGeminiGenerationError({ status: 503, message: 'unavailable' }))
                .toBe('ambiguous');
            expect(classifyGeminiGenerationError(new Error('fetch failed: ECONNRESET')))
                .toBe('ambiguous');
            expect(classifyGeminiGenerationError(new Error('request timeout')))
                .toBe('ambiguous');
        });

        it('distinguishes definite client rejection from unknown failures', () => {
            expect(classifyGeminiGenerationError({ statusCode: 400, message: 'bad request' }))
                .toBe('rejected');
            expect(classifyGeminiGenerationError(new Error('unexpected SDK state')))
                .toBe('ambiguous');
            expect(isAmbiguousGeminiGenerationError(
                new Error('AI_AMBIGUOUS_GENERATION_ERROR: sanitized')
            )).toBe(true);
        });

        it('recovers only from a concrete unusable response without regenerating it', () => {
            expect(isRecoverableGeminiResponseError(
                new Error('AI_GENERATION_RESPONSE_REJECTED_ERROR: strict schema failed')
            )).toBe(true);
            expect(isRecoverableGeminiResponseError(
                new Error('Gemini response did not include text')
            )).toBe(false);
            expect(isRecoverableGeminiResponseError(new Error('fetch failed'))).toBe(false);
        });
    });
});

describe("gemini-response", () => {
    describe('parseGeminiJsonResponse', () => {
        it('accepts a valid fenced response through the requested schema', () => {
            const parsed = parseGeminiJsonResponse(
                '```json\n{"gender":"female","confidence":0.9,"reasoning":"evidence"}\n```',
                genderAnalysisResponseSchema
            );
            expect(parsed).toEqual({ gender: 'female', confidence: 0.9, reasoning: 'evidence' });
        });

        it('rejects malformed JSON, enum drift, and out-of-range confidence', () => {
            expect(() => parseGeminiJsonResponse('{bad json}', genderAnalysisResponseSchema))
                .toThrow('invalid JSON');
            expect(() => parseGeminiJsonResponse(
                '{"gender":"other","confidence":0.9,"reasoning":"evidence"}',
                genderAnalysisResponseSchema
            )).toThrow('required analysis schema');
            expect(() => parseGeminiJsonResponse(
                '{"gender":"female","confidence":90,"reasoning":"evidence"}',
                genderAnalysisResponseSchema
            )).toThrow('required analysis schema');
        });

        it('requires all female-only combined fields and rejects unexpected fields', () => {
            expect(() => parseGeminiJsonResponse(
                '{"gender":"female","genderConfidence":0.9,"genderReasoning":"evidence"}',
                combinedAnalysisResponseSchema
            )).toThrow('required analysis schema');
            expect(() => parseGeminiJsonResponse(
                '{"gender":"male","genderConfidence":0.9,"genderReasoning":"evidence","isMarried":false}',
                combinedAnalysisResponseSchema
            )).toThrow('required analysis schema');
        });

        it('reports only bounded schema paths and issue categories without raw response values', () => {
            const rawSecret = 'private-profile-value';
            let captured: unknown;

            try {
                parseGeminiJsonResponse(JSON.stringify({
                    gender: 'female',
                    confidence: 90,
                    reasoning: rawSecret,
                    unexpectedPrivateField: rawSecret,
                }), genderAnalysisResponseSchema);
            } catch (error) {
                captured = error;
            }

            expect(captured).toBeInstanceOf(GeminiResponseValidationError);
            const diagnostics = (captured as GeminiResponseValidationError).diagnostics;
            expect(diagnostics).toEqual({
                category: 'schema_validation',
                issues: [
                    { path: 'confidence', code: 'too_big' },
                    { path: '$', code: 'unrecognized_keys' },
                ],
                truncated: false,
            });
            expect(JSON.stringify(diagnostics)).not.toContain(rawSecret);
            expect(JSON.stringify(diagnostics)).not.toContain('unexpectedPrivateField');
        });

        it('retains non-serializable field repair context for schema failures', () => {
            let captured: unknown;
            try {
                parseGeminiJsonResponse(
                    '{"gender":"female","confidence":90,"reasoning":"evidence"}',
                    genderAnalysisResponseSchema,
                );
            } catch (error) {
                captured = error;
            }

            expect(captured).toBeInstanceOf(GeminiResponseValidationError);
            expect((captured as GeminiResponseValidationError).repairContext).toMatchObject({
                candidate: { gender: 'female', confidence: 90, reasoning: 'evidence' },
                issues: [{ path: ['confidence'], code: 'too_big', message: 'Too big: expected number to be <=1' }],
            });
            expect(JSON.stringify(captured)).not.toContain('repairContext');
        });

        it('classifies malformed JSON without retaining response text', () => {
            const rawSecret = 'private-profile-value';
            let captured: unknown;

            try {
                parseGeminiJsonResponse(`{bad json ${rawSecret}}`, genderAnalysisResponseSchema);
            } catch (error) {
                captured = error;
            }

            expect(captured).toBeInstanceOf(GeminiResponseValidationError);
            expect((captured as GeminiResponseValidationError).diagnostics).toEqual({
                category: 'invalid_json',
                issues: [],
                truncated: false,
            });
            expect(JSON.stringify((captured as GeminiResponseValidationError).diagnostics))
                .not.toContain(rawSecret);
        });
    });
});

describe("pipeline-config", () => {
    describe('getVertexAIAnalysisConcurrency', () => {
        it('uses the quality-safe default for missing or invalid values', () => {
            expect(getVertexAIAnalysisConcurrency(undefined)).toBe(DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY);
            expect(getVertexAIAnalysisConcurrency('not-a-number')).toBe(DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY);
        });

        it('accepts an explicit bounded concurrency', () => {
            expect(getVertexAIAnalysisConcurrency('8')).toBe(8);
            expect(getVertexAIAnalysisConcurrency('8.9')).toBe(8);
        });

        it('clamps concurrency to the supported range', () => {
            expect(getVertexAIAnalysisConcurrency('0')).toBe(1);
            expect(getVertexAIAnalysisConcurrency('100')).toBe(MAX_VERTEX_AI_ANALYSIS_CONCURRENCY);
            expect(MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS).toBe(8);
            expect(MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES).toBe(2);
            expect(MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS).toBeLessThan(
                MAX_VERTEX_AI_ANALYSIS_CONCURRENCY * MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY
            );
        });
    });

    describe('AI batch failure threshold', () => {
        it('fails closed when at least half of a paid analysis batch cannot be classified', () => {
            expect(isAnalysisBatchFailureAboveThreshold(1, 1)).toBe(true);
            expect(isAnalysisBatchFailureAboveThreshold(10, 5)).toBe(true);
            expect(isAnalysisBatchFailureAboveThreshold(10, 4)).toBe(false);
        });

        it('rejects invalid counters', () => {
            expect(() => isAnalysisBatchFailureAboveThreshold(0, 0)).toThrow('CONFIG');
            expect(() => isAnalysisBatchFailureAboveThreshold(3, 4)).toThrow('CONFIG');
        });
    });
});

describe("scheduler-policy", () => {
    describe('AI scheduler policy', () => {
        it('uses one immutable scheduler policy id', () => {
            expect(AI_SCHEDULER_POLICY_ID).toBe('ai-scheduler-v1');
        });

        it.each([
            ['off', 'production', undefined],
            ['test_entitlement', 'production', undefined],
            ['test_entitlement', 'test_entitlement', 'ai-scheduler-v1'],
            ['production', 'production', 'ai-scheduler-v1'],
            ['production', 'test_entitlement', 'ai-scheduler-v1'],
            [undefined, 'production', undefined],
            ['invalid', 'production', undefined],
        ] as const)('selects scheduler rollout %s for %s access', (
            rolloutMode,
            accessMode,
            expected,
        ) => {
            expect(selectAiSchedulerPolicyVersion({ rolloutMode, accessMode })).toBe(expected);
        });

        it('routes missing scheduler snapshots through the legacy capability', () => {
            expect(parseAiSchedulerPolicySnapshot({
                pipeline: 'v2',
                risk: 'risk-policy-v2.4',
                aiStage: 'ai-stage-policy-v2.7',
            })).toEqual({ capability: 'legacy' });
        });

        it('routes the exact scheduler snapshot through scheduler-v1 capability', () => {
            expect(parseAiSchedulerPolicySnapshot({
                pipeline: 'v2',
                risk: 'risk-policy-v2.4',
                aiStage: 'ai-stage-policy-v2.7',
                scheduler: 'ai-scheduler-v1',
            })).toEqual({ capability: 'scheduler-v1' });
        });

        it('rejects unknown scheduler values', () => {
            const legacySnapshot = {
                pipeline: 'v2',
                risk: 'risk-policy-v2.4',
                aiStage: 'ai-stage-policy-v2.7',
            };
            expect(() => parseAiSchedulerPolicySnapshot({
                ...legacySnapshot,
                scheduler: 'ai-scheduler-v9',
            }))
                .toThrow('Unsupported AI scheduler policy version');
            expect(() => parseAiSchedulerPolicySnapshot({ ...legacySnapshot, scheduler: null }))
                .toThrow('Unsupported AI scheduler policy version');
        });

        it('rejects unexpected-only application snapshot keys', () => {
            expect(() => parseAiSchedulerPolicySnapshot({ futurePolicy: 'v1' }))
                .toThrow('Invalid AI scheduler policy snapshot');
        });

        it('rejects unexpected keys even with the valid scheduler policy', () => {
            expect(() => parseAiSchedulerPolicySnapshot({
                pipeline: 'v2',
                risk: 'risk-policy-v2.4',
                aiStage: 'ai-stage-policy-v2.7',
                scheduler: 'ai-scheduler-v1',
                futurePolicy: 'v1',
            })).toThrow('Invalid AI scheduler policy snapshot');
        });

        it('requires the complete known application key shape and version strings', () => {
            expect(() => parseAiSchedulerPolicySnapshot({
                pipeline: 'v2',
                aiStage: 'ai-stage-policy-v2.7',
            })).toThrow('Invalid AI scheduler policy snapshot');
            expect(() => parseAiSchedulerPolicySnapshot({
                pipeline: 'v2',
                risk: 'risk policy with spaces',
                aiStage: 'ai-stage-policy-v2.7',
            })).toThrow('Invalid AI scheduler policy snapshot');
        });

        it.each([64, 65, 128])(
            'accepts canonical policy version strings at length %i',
            length => {
                expect(parseAiSchedulerPolicySnapshot({
                    pipeline: `v${'a'.repeat(length - 1)}`,
                    risk: 'risk-policy-v2.4',
                    aiStage: 'ai-stage-policy-v2.7',
                })).toEqual({ capability: 'legacy' });
            },
        );

        it('rejects a policy version string at length 129', () => {
            expect(() => parseAiSchedulerPolicySnapshot({
                pipeline: `v${'a'.repeat(128)}`,
                risk: 'risk-policy-v2.4',
                aiStage: 'ai-stage-policy-v2.7',
            })).toThrow('Invalid AI scheduler policy snapshot');
        });
    });
});
