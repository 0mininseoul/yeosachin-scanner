import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    analyze: vi.fn(),
}));

vi.mock('@/lib/services/ai/gemini', () => ({
    analyzeWithGemini: mocks.analyze,
}));

import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import {
    createProGenderSecondLookResultIdentityV219,
    runProGenderSecondLookGenerationV219,
} from './replay-v219-ai-adapter';

const media = [
    {
        selectionId: 'source-profile',
        kind: 'profile' as const,
        jpegBase64: '/9j/2Q==',
    },
    {
        selectionId: 'source-feed-a',
        kind: 'feed' as const,
        postId: 'post-a',
        jpegBase64: '/9j/2Q==',
    },
    {
        selectionId: 'source-feed-b',
        kind: 'feed' as const,
        postId: 'post-b',
        jpegBase64: '/9j/2Q==',
    },
];

describe('V2.19 Pro gender second-look provider adapter', () => {
    beforeEach(() => {
        mocks.analyze.mockReset();
        mocks.analyze.mockResolvedValue({
            inferredGender: 'female',
            genderConfidence: 'high',
            ownerConsistency: 'same_person',
            accountContext: 'personal',
            contextConfidence: 'high',
            genderEvidenceIds: [
                'second-look-media:1',
                'second-look-media:2',
            ],
            contextEvidenceIds: ['second-look-media:2'],
        });
    });

    it('pins Pro HIGH/HIGH/2048 and finalizes opaque evidence IDs', async () => {
        const onBeforeAttempt = vi.fn();
        const onProviderDispatch = vi.fn();
        const onAttemptTelemetry = vi.fn();
        const runProviderAttempt = vi.fn(
            async <T>(task: () => Promise<T>) => task(),
        ) as unknown as (<T>(task: () => Promise<T>) => Promise<T>) & {
            mock: { calls: unknown[][] };
        };
        const result = await runProGenderSecondLookGenerationV219({
            media,
            replayCapability: issueReplayStatelessCapability(),
            audit: {
                requestId: '11111111-1111-4111-8111-111111111111',
                operationKey:
                    createProGenderSecondLookResultIdentityV219(media)
                        .operationKey,
                resultIdentity:
                    createProGenderSecondLookResultIdentityV219(media),
                prepare: async () => ({
                    result: null,
                    source: null,
                    startingAttempt: 1,
                }),
                onBeforeAttempt,
                onProviderDispatch,
                onAttemptTelemetry,
            },
            runProviderAttempt,
        });

        expect(result).toMatchObject({
            inferredGender: 'female',
            genderEvidenceIds: [
                'source-profile',
                'source-feed-a',
            ],
            contextEvidenceIds: ['source-feed-a'],
        });
        expect(mocks.analyze).toHaveBeenCalledOnce();
        const [prompt, images, options] = mocks.analyze.mock.calls[0]!;
        expect(prompt).not.toContain('source-profile');
        expect(prompt).not.toContain('source-feed');
        expect(prompt).not.toContain('post-a');
        expect(images).toHaveLength(3);
        expect(options).toMatchObject({
            analysisType: 'v2_pro_gender_second_look_v219',
            stage: 'featureAnalysis',
            aiStagePolicyVersion: 'ai-stage-policy-v2.19',
            model: 'gemini-3.1-pro-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            maxOutputTokens: 2_048,
            skipTokenLog: true,
            onBeforeAttempt: expect.any(Function),
            onProviderDispatch: expect.any(Function),
            onAttemptTelemetry: expect.any(Function),
            runProviderAttempt,
        });
        expect(options.onBeforeAttempt).not.toBe(onBeforeAttempt);
        expect(options.onProviderDispatch).not.toBe(
            onProviderDispatch,
        );
        expect(options.onAttemptTelemetry).not.toBe(
            onAttemptTelemetry,
        );
    });

    it('binds identity to Pro configuration, prompt, and projected media', () => {
        const identity = createProGenderSecondLookResultIdentityV219(media);

        expect(identity).toMatchObject({
            stage: 'featureAnalysis',
            modelName: 'gemini-3.1-pro-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            promptVersion: 'pro-gender-second-look-v1',
            schemaVersion: 1,
            maxOutputTokens: 2_048,
            cacheScope: 'request',
        });
        expect(identity.operationKey).toMatch(
            /^feature-analysis:[a-f0-9]{64}$/,
        );
    });

    it('rewrites shared feature-stage audit telemetry to the Pro prompt and schema provenance', async () => {
        const observedStarts: unknown[] = [];
        const observedTerminals: unknown[] = [];
        mocks.analyze.mockImplementation(async (
            _prompt,
            _images,
            options,
        ) => {
            const start = {
                requestId: '11111111-1111-4111-8111-111111111111',
                modelName: 'gemini-3.1-pro-preview',
                location: 'global',
                stage: 'featureAnalysis',
                thinkingLevel: 'HIGH',
                mediaCount: 3,
                mediaResolution: 'HIGH',
                promptVersion: 'feature-analysis-v3',
                schemaVersion: 3,
                maxOutputTokens: 2_048,
                attempt: 1,
                retryCount: 0,
            };
            await options.onBeforeAttempt(start);
            options.onProviderDispatch(start);
            await options.onAttemptTelemetry({
                ...start,
                tokenUsage: {
                    promptTokens: 1,
                    completionTokens: 1,
                    totalTokens: 2,
                    thinkingTokens: 0,
                },
                usageComplete: true,
                usageMetadataStatus: 'complete',
                latencyMs: 1,
                estimatedCostUsd: 0.000014,
                disposition: 'success',
                finishReason: 'STOP',
            });
            return {
                inferredGender: 'female',
                genderConfidence: 'high',
                ownerConsistency: 'same_person',
                accountContext: 'personal',
                contextConfidence: 'high',
                genderEvidenceIds: [
                    'second-look-media:1',
                    'second-look-media:2',
                ],
                contextEvidenceIds: ['second-look-media:2'],
            };
        });

        const identity =
            createProGenderSecondLookResultIdentityV219(media);
        await runProGenderSecondLookGenerationV219({
            media,
            replayCapability: issueReplayStatelessCapability(),
            audit: {
                requestId: '11111111-1111-4111-8111-111111111111',
                operationKey: identity.operationKey,
                resultIdentity: identity,
                prepare: async () => ({
                    result: null,
                    source: null,
                    startingAttempt: 1,
                }),
                onBeforeAttempt: value => {
                    observedStarts.push(value);
                },
                onProviderDispatch: value => {
                    observedStarts.push(value);
                },
                onAttemptTelemetry: value => {
                    observedTerminals.push(value);
                },
            },
            runProviderAttempt: async task => task(),
        });

        expect(observedStarts).toHaveLength(2);
        expect(observedStarts).toEqual([
            expect.objectContaining({
                location: 'global',
                promptVersion: 'pro-gender-second-look-v1',
                schemaVersion: 1,
            }),
            expect.objectContaining({
                location: 'global',
                promptVersion: 'pro-gender-second-look-v1',
                schemaVersion: 1,
            }),
        ]);
        expect(observedTerminals).toEqual([
            expect.objectContaining({
                location: 'global',
                promptVersion: 'pro-gender-second-look-v1',
                schemaVersion: 1,
            }),
        ]);
    });

    it('fails before provider dispatch when the shared runtime was not bootstrapped to global', async () => {
        const providerDispatch = vi.fn();
        mocks.analyze.mockImplementation(async (
            _prompt,
            _images,
            options,
        ) => {
            const start = {
                requestId: '11111111-1111-4111-8111-111111111111',
                modelName: 'gemini-3.1-pro-preview',
                location: 'us-central1',
                stage: 'featureAnalysis',
                thinkingLevel: 'HIGH',
                mediaCount: 3,
                mediaResolution: 'HIGH',
                promptVersion: 'feature-analysis-v3',
                schemaVersion: 3,
                maxOutputTokens: 2_048,
                attempt: 1,
                retryCount: 0,
            };
            await options.onBeforeAttempt(start);
            options.onProviderDispatch(start);
            providerDispatch();
            throw new Error('PROVIDER_REACHED');
        });
        const identity =
            createProGenderSecondLookResultIdentityV219(media);

        await expect(runProGenderSecondLookGenerationV219({
            media,
            replayCapability: issueReplayStatelessCapability(),
            audit: {
                requestId: '11111111-1111-4111-8111-111111111111',
                operationKey: identity.operationKey,
                resultIdentity: identity,
                prepare: async () => ({
                    result: null,
                    source: null,
                    startingAttempt: 1,
                }),
                onBeforeAttempt: vi.fn(),
                onProviderDispatch: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            },
            runProviderAttempt: async task => task(),
        })).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_V219_LOCATION_MISMATCH',
        );
        expect(providerDispatch).not.toHaveBeenCalled();
    });

    it('preserves the fixed hard budget ceiling error when shared telemetry follows a pre-dispatch rejection', async () => {
        const terminalAudit = vi.fn(() => {
            throw new Error(
                'ANALYSIS_V2_REPLAY_V219_TERMINAL_WITHOUT_DISPATCH',
            );
        });
        mocks.analyze.mockImplementation(async (
            _prompt,
            _images,
            options,
        ) => {
            const start = {
                requestId: '11111111-1111-4111-8111-111111111111',
                modelName: 'gemini-3.1-pro-preview',
                location: 'global',
                stage: 'featureAnalysis',
                thinkingLevel: 'HIGH',
                mediaCount: 3,
                mediaResolution: 'HIGH',
                promptVersion: 'feature-analysis-v3',
                schemaVersion: 3,
                maxOutputTokens: 2_048,
                attempt: 1,
                retryCount: 0,
            };
            try {
                options.onProviderDispatch(start);
            } catch {
                try {
                    await options.onAttemptTelemetry({
                        ...start,
                        tokenUsage: null,
                        usageComplete: false,
                        usageMetadataStatus: 'missing',
                        latencyMs: 0,
                        estimatedCostUsd: null,
                        disposition: 'ambiguous',
                        finishReason: null,
                    });
                } catch {
                    throw new Error(
                        'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR: Gemini attempt result was not durably stored.',
                    );
                }
                throw new Error(
                    'AI_GENERATION_REQUEST_ERROR: Gemini rejected the generation request.',
                );
            }
            throw new Error('PROVIDER_REACHED');
        });
        const identity =
            createProGenderSecondLookResultIdentityV219(media);

        await expect(runProGenderSecondLookGenerationV219({
            media,
            replayCapability: issueReplayStatelessCapability(),
            audit: {
                requestId: '11111111-1111-4111-8111-111111111111',
                operationKey: identity.operationKey,
                resultIdentity: identity,
                prepare: async () => ({
                    result: null,
                    source: null,
                    startingAttempt: 1,
                }),
                onBeforeAttempt: vi.fn(),
                onProviderDispatch: () => {
                    throw new Error(
                        'ANALYSIS_V2_REPLAY_V219_COST_CEILING_EXCEEDED',
                    );
                },
                onAttemptTelemetry: terminalAudit,
            },
            runProviderAttempt: async task => task(),
        })).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_V219_COST_CEILING_EXCEEDED',
        );
        expect(terminalAudit).not.toHaveBeenCalled();
    });
});
