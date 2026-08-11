import { describe, expect, it, vi } from 'vitest';
import type {
    GeminiAttemptStartTelemetry,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import {
    createRevenueGenderRoutingAssessorFactory,
    type RevenueGenderRoutingAssessorAuditAdapter,
    type RevenueGenderRoutingAssessorAuditAdapterFactory,
} from './revenue-gender-routing-assessor';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '123e4567-e89b-42d3-a456-426614174001';

function startTelemetry(): GeminiAttemptStartTelemetry {
    return {
        requestId,
        modelName: 'gemini-3.1-flash-lite',
        location: 'global',
        stage: 'genderTriage',
        thinkingLevel: 'MINIMAL',
        mediaCount: 1,
        mediaResolution: 'LOW',
        promptVersion: 'gender-triage-microbatch-v1',
        schemaVersion: 3,
        maxOutputTokens: 1024,
        attempt: 1,
        retryCount: 0,
    };
}

function successTelemetry(): GeminiAttemptTelemetry {
    return {
        ...startTelemetry(),
        tokenUsage: {
            promptTokens: 12,
            completionTokens: 8,
            thinkingTokens: 0,
            totalTokens: 20,
        },
        usageComplete: true,
        usageMetadataStatus: 'complete',
        latencyMs: 7,
        estimatedCostUsd: 0.00001,
        disposition: 'success',
        finishReason: 'STOP',
    };
}

describe('trusted revenue gender-routing assessor', () => {
    it('sends exactly normalized fullname and normalized image bytes, and persists audit before cost on each Gemini boundary', async () => {
        const events: string[] = [];
        let responseSchema: { safeParse(value: unknown): { success: boolean } } | null = null;
        const audit: RevenueGenderRoutingAssessorAuditAdapter = {
            requestId,
            operationKey: `gender-triage:${'a'.repeat(64)}`,
            resultIdentity: {} as RevenueGenderRoutingAssessorAuditAdapter['resultIdentity'],
            resultSchema: {} as RevenueGenderRoutingAssessorAuditAdapter['resultSchema'],
            prepare: vi.fn(async () => ({ result: null, source: null, startingAttempt: 1 })),
            onBeforeAttempt: vi.fn(async () => { events.push('audit:reserve'); }),
            onAttemptTelemetry: vi.fn(async () => { events.push('audit:terminal'); }),
        };
        const auditAdapterFactory: RevenueGenderRoutingAssessorAuditAdapterFactory = vi.fn(() => audit);
        const costLifecycle = {
            bind: vi.fn(() => ({
                onBeforeAttempt: async () => { events.push('cost:reserve-start'); },
                onAttemptTelemetry: async () => { events.push('cost:settle'); },
                releaseBeforeDispatch: async () => null,
                manualReviewAfterExternalBoundary: async () => null,
            })),
        };
        const analyze = vi.fn(async (
            prompt: string,
            images: string[] | undefined,
            options: {
                schema: {
                    parse(value: unknown): unknown;
                    safeParse(value: unknown): { success: boolean };
                };
                onBeforeAttempt?: (telemetry: GeminiAttemptStartTelemetry) => Promise<void>;
                onAttemptTelemetry?: (telemetry: GeminiAttemptTelemetry, result?: unknown) => Promise<void>;
            },
        ) => {
            responseSchema = options.schema;
            expect(prompt).toContain('Ari Kim');
            expect(prompt).not.toContain('handle_should_never_appear');
            expect(prompt).not.toContain('bio_should_never_appear');
            expect(prompt).not.toContain('https://cdn.example/raw-url');
            expect(prompt).not.toContain('mutual:999');
            expect(images).toEqual(['CQgH']);
            await options.onBeforeAttempt?.(startTelemetry());
            events.push('gemini');
            const response = options.schema.parse({
                assessments: [{
                    index: 0,
                    female_score: 0.8,
                    male_score: 0.1,
                    uncertainty_score: 0.1,
                    evidence: 'image_and_name',
                }],
            });
            await options.onAttemptTelemetry?.(successTelemetry(), response);
            return response;
        });

        const assessor = createRevenueGenderRoutingAssessorFactory({
            analyze: analyze as never,
            auditAdapterFactory,
            costLifecycle,
        })({
            requestId,
            jobKey: 'track:relationships:collect',
            jobClaimToken: claimToken,
            jobInputHash: 'b'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'basic',
        });

        const result = await assessor([{
            candidateKey: 'mutual:999',
            fullname: 'Ari Kim',
            imageBase64: 'CQgH',
            inputHmac: 'c'.repeat(64),
        }], 1);

        expect(result.get('mutual:999')).toEqual({
            femaleScore: 0.8,
            maleScore: 0.1,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name',
        });
        expect(events).toEqual([
            'audit:reserve',
            'cost:reserve-start',
            'gemini',
            'audit:terminal',
            'cost:settle',
        ]);
        expect(audit.prepare).toHaveBeenCalledTimes(1);
        expect(costLifecycle.bind).toHaveBeenCalledWith(expect.objectContaining({
            scope: { accessMode: 'test_entitlement', planId: 'basic' },
            fence: expect.objectContaining({
                requestId,
                jobKey: 'track:relationships:collect',
                jobClaimToken: claimToken,
                jobInputHash: 'b'.repeat(64),
                routingAttempt: 1,
            }),
        }));
        expect(responseSchema).not.toBeNull();
        const schema = responseSchema as unknown as { safeParse(value: unknown): { success: boolean } };
        expect(schema.safeParse({
            assessments: [{
                index: 0,
                female_score: 1.1,
                male_score: 0,
                uncertainty_score: 0,
                evidence: 'name_only',
                invented_field: true,
            }],
            top_level_field: true,
        }).success).toBe(false);
    });

    it('salvages only individually strict-valid rows from a mixed microbatch response', async () => {
        const audit: RevenueGenderRoutingAssessorAuditAdapter = {
            requestId,
            operationKey: `gender-triage:${'b'.repeat(64)}`,
            resultIdentity: {} as RevenueGenderRoutingAssessorAuditAdapter['resultIdentity'],
            resultSchema: {} as RevenueGenderRoutingAssessorAuditAdapter['resultSchema'],
            prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
            onBeforeAttempt: async () => undefined,
            onAttemptTelemetry: async () => undefined,
        };
        const costLifecycle = {
            bind: () => ({
                onBeforeAttempt: async () => undefined,
                onAttemptTelemetry: async () => undefined,
                releaseBeforeDispatch: async () => null,
                manualReviewAfterExternalBoundary: async () => null,
            }),
        };
        const analyze = async (
            _prompt: string,
            _images: string[] | undefined,
            options: {
                schema: { parse(value: unknown): unknown };
                onBeforeAttempt?: (telemetry: GeminiAttemptStartTelemetry) => Promise<void>;
                onAttemptTelemetry?: (telemetry: GeminiAttemptTelemetry, result?: unknown) => Promise<void>;
            },
        ) => {
            await options.onBeforeAttempt?.(startTelemetry());
            const response = options.schema.parse({
                assessments: [
                    {
                        index: 0,
                        female_score: 0.8,
                        male_score: 0.1,
                        uncertainty_score: 0.1,
                        evidence: 'name_only',
                    },
                    {
                        index: 1,
                        female_score: 0.8,
                        male_score: 0.2,
                        uncertainty_score: 0.2,
                        evidence: 'name_only',
                    },
                    {
                        index: 2,
                        female_score: 0.7,
                        male_score: 0.2,
                        uncertainty_score: 0.1,
                        evidence: 'image_only',
                    },
                    {
                        index: 99,
                        female_score: 0.7,
                        male_score: 0.2,
                        uncertainty_score: 0.1,
                        evidence: 'name_only',
                    },
                    {
                        index: 3,
                        female_score: 0.6,
                        male_score: 0.3,
                        uncertainty_score: 0.1,
                        evidence: 'name_only',
                        invented_field: true,
                    },
                ],
            });
            await options.onAttemptTelemetry?.(successTelemetry(), response);
            return response;
        };
        const assessor = createRevenueGenderRoutingAssessorFactory({
            analyze: analyze as never,
            auditAdapterFactory: () => audit,
            costLifecycle,
        })({
            requestId,
            jobKey: 'track:relationships:collect',
            jobClaimToken: claimToken,
            jobInputHash: 'b'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'basic',
        });

        const result = await assessor([
            { candidateKey: 'mutual:0', fullname: 'Zero', imageBase64: null, inputHmac: '0'.repeat(64) },
            { candidateKey: 'mutual:1', fullname: 'One', imageBase64: null, inputHmac: '1'.repeat(64) },
            { candidateKey: 'mutual:2', fullname: 'Two', imageBase64: null, inputHmac: '2'.repeat(64) },
            { candidateKey: 'mutual:3', fullname: 'Three', imageBase64: null, inputHmac: '3'.repeat(64) },
        ], 1);

        expect([...result.entries()]).toEqual([[
            'mutual:0',
            {
                femaleScore: 0.8,
                maleScore: 0.1,
                uncertaintyScore: 0.1,
                evidence: 'name_only',
            },
        ]]);
    });

    it('fails closed into manual review when terminal audit persistence is lost after the Gemini boundary', async () => {
        const events: string[] = [];
        const audit: RevenueGenderRoutingAssessorAuditAdapter = {
            requestId,
            operationKey: `gender-triage:${'d'.repeat(64)}`,
            resultIdentity: {} as RevenueGenderRoutingAssessorAuditAdapter['resultIdentity'],
            resultSchema: {} as RevenueGenderRoutingAssessorAuditAdapter['resultSchema'],
            prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
            onBeforeAttempt: async () => { events.push('audit:reserve'); },
            onAttemptTelemetry: async () => {
                events.push('audit:terminal');
                throw new Error('terminal audit transport lost');
            },
        };
        const costLifecycle = {
            bind: () => ({
                onBeforeAttempt: async () => { events.push('cost:reserve-start'); },
                onAttemptTelemetry: async () => { events.push('cost:settle'); },
                releaseBeforeDispatch: async () => null,
                manualReviewAfterExternalBoundary: async () => {
                    events.push('cost:manual-review');
                    return null;
                },
            }),
        };
        const analyze = async (
            _prompt: string,
            _images: string[] | undefined,
            options: {
                onBeforeAttempt?: (telemetry: GeminiAttemptStartTelemetry) => Promise<void>;
                onAttemptTelemetry?: (telemetry: GeminiAttemptTelemetry, result?: unknown) => Promise<void>;
            },
        ) => {
            await options.onBeforeAttempt?.(startTelemetry());
            events.push('gemini');
            await options.onAttemptTelemetry?.(successTelemetry(), {
                assessments: [{
                    index: 0,
                    female_score: 0.8,
                    male_score: 0.1,
                    uncertainty_score: 0.1,
                    evidence: 'name_only',
                }],
            });
            throw new Error('unreachable');
        };
        const assessor = createRevenueGenderRoutingAssessorFactory({
            analyze: analyze as never,
            auditAdapterFactory: () => audit,
            costLifecycle,
        })({
            requestId,
            jobKey: 'track:relationships:collect',
            jobClaimToken: claimToken,
            jobInputHash: 'b'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'standard',
        });

        await expect(assessor([{
            candidateKey: 'mutual:1',
            fullname: 'Ari Kim',
            imageBase64: null,
            inputHmac: 'e'.repeat(64),
        }], 1)).rejects.toThrow('terminal audit transport lost');
        expect(events).toEqual([
            'audit:reserve',
            'cost:reserve-start',
            'gemini',
            'audit:terminal',
            'cost:manual-review',
        ]);
    });

    it('forces manual review before propagating an audit reservation response loss, but leaves deterministic replay blocks alone', async () => {
        const manualReviewAfterExternalBoundary = vi.fn(async () => null);
        const costLifecycle = {
            bind: () => ({
                onBeforeAttempt: async () => undefined,
                onAttemptTelemetry: async () => undefined,
                releaseBeforeDispatch: async () => null,
                manualReviewAfterExternalBoundary,
            }),
        };
        const audit: RevenueGenderRoutingAssessorAuditAdapter = {
            requestId,
            operationKey: `gender-triage:${'e'.repeat(64)}`,
            resultIdentity: {} as RevenueGenderRoutingAssessorAuditAdapter['resultIdentity'],
            resultSchema: {} as RevenueGenderRoutingAssessorAuditAdapter['resultSchema'],
            prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
            onBeforeAttempt: async () => {
                throw new Error('reservation response lost after commit');
            },
            onAttemptTelemetry: async () => undefined,
        };
        const analyze = async (
            _prompt: string,
            _images: string[] | undefined,
            options: { onBeforeAttempt?: (telemetry: GeminiAttemptStartTelemetry) => Promise<void> },
        ) => {
            await options.onBeforeAttempt?.(startTelemetry());
            throw new Error('unreachable');
        };
        const assessor = createRevenueGenderRoutingAssessorFactory({
            analyze: analyze as never,
            auditAdapterFactory: () => audit,
            costLifecycle,
        })({
            requestId,
            jobKey: 'track:relationships:collect',
            jobClaimToken: claimToken,
            jobInputHash: 'b'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'basic',
        });

        await expect(assessor([{
            candidateKey: 'mutual:1', fullname: 'Ari Kim', imageBase64: null, inputHmac: 'd'.repeat(64),
        }], 1)).rejects.toThrow('reservation response lost after commit');
        expect(manualReviewAfterExternalBoundary).toHaveBeenCalledOnce();
    });

    it('charges a response-rejected retry as a new immutable routing attempt while returning only failed candidates for retry', async () => {
        const auditAdapterFactory: RevenueGenderRoutingAssessorAuditAdapterFactory = vi.fn(options => ({
            requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
            onBeforeAttempt: async () => undefined,
            onAttemptTelemetry: async () => undefined,
        }));
        const operationKeys: string[] = [];
        const costLifecycle = {
            bind: vi.fn((input: { fence: { operationKey: string } }) => {
                operationKeys.push(input.fence.operationKey);
                return {
                    onBeforeAttempt: async () => undefined,
                    onAttemptTelemetry: async () => undefined,
                    releaseBeforeDispatch: async () => null,
                    manualReviewAfterExternalBoundary: async () => null,
                };
            }),
        };
        let generation = 0;
        const analyze = async (
            _prompt: string,
            _images: string[] | undefined,
            options: {
                onBeforeAttempt?: (telemetry: GeminiAttemptStartTelemetry) => Promise<void>;
                onAttemptTelemetry?: (telemetry: GeminiAttemptTelemetry, result?: unknown) => Promise<void>;
            },
        ) => {
            generation += 1;
            await options.onBeforeAttempt?.(startTelemetry());
            if (generation === 1) {
                await options.onAttemptTelemetry?.({
                    ...successTelemetry(),
                    disposition: 'response_rejected',
                });
                throw new Error(
                    'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.',
                );
            }
            const response = {
                assessments: [{
                    index: 0,
                    female_score: 0.7,
                    male_score: 0.2,
                    uncertainty_score: 0.1,
                    evidence: 'name_only',
                }],
            };
            await options.onAttemptTelemetry?.(successTelemetry(), response);
            return response;
        };
        const assessor = createRevenueGenderRoutingAssessorFactory({
            analyze: analyze as never,
            auditAdapterFactory,
            costLifecycle,
        })({
            requestId,
            jobKey: 'track:relationships:collect',
            jobClaimToken: claimToken,
            jobInputHash: 'b'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'basic',
        });
        const candidate = {
            candidateKey: 'mutual:1',
            fullname: 'Ari Kim',
            imageBase64: null,
            inputHmac: 'f'.repeat(64),
        } as const;

        await expect(assessor([candidate], 1)).resolves.toEqual(new Map());
        await expect(assessor([candidate], 2)).resolves.toEqual(new Map([[
            'mutual:1',
            {
                femaleScore: 0.7,
                maleScore: 0.2,
                uncertaintyScore: 0.1,
                evidence: 'name_only',
            },
        ]]));

        expect(costLifecycle.bind).toHaveBeenCalledTimes(2);
        expect(operationKeys[0]).toBeDefined();
        expect(operationKeys[1]).toBeDefined();
        expect(operationKeys[0]).not.toBe(operationKeys[1]);
        expect(auditAdapterFactory).toHaveBeenCalledTimes(2);
        expect(costLifecycle.bind).toHaveBeenNthCalledWith(1, expect.objectContaining({
            fence: expect.objectContaining({ routingAttempt: 1 }),
        }));
        expect(costLifecycle.bind).toHaveBeenNthCalledWith(2, expect.objectContaining({
            fence: expect.objectContaining({ routingAttempt: 2 }),
        }));
    });
});
