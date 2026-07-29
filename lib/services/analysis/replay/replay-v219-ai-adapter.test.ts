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
            onBeforeAttempt,
            onProviderDispatch,
            onAttemptTelemetry,
            runProviderAttempt,
        });
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
});
