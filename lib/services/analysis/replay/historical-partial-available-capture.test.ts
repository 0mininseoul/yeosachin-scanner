import { describe, expect, it } from 'vitest';
import { AnalysisImagePreparationError } from '@/lib/services/ai/image-preprocessing';
import { captureHistoricalPartialAvailableReplayBundle, partialAvailableSafeReport } from './historical-partial-available-capture';

const lineage = {
    selectedPlanId: 'standard' as const,
    policyVersions: {
        pipeline: 'v2' as const,
        aiStage: 'ai-stage-policy-v2.7' as const,
        risk: 'risk-policy-v2.3' as const,
    },
};

function publicProfile(username: string, posts = 1) {
    return {
        username,
        fullName: username,
        bio: 'bio',
        profilePicUrl: `https://cdn.example/${username}.jpg`,
        followersCount: 1,
        followingCount: 1,
        postsCount: posts,
        isPrivate: false,
        isVerified: false,
        latestPosts: Array.from({ length: posts }, (_, index) => ({
            id: `${username}-${index}`,
            shortCode: `${username}${index}`,
            type: 'image' as const,
            imageUrl: `https://cdn.example/${username}-${index}.jpg`,
            likesCount: 0,
            commentsCount: 0,
            timestamp: `2026-07-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`,
            taggedUsers: [],
            mentionedUsers: [],
        })),
    };
}

describe('historical partial-available replay capture', () => {
    it('records unavailable public media terminally while retaining passing public and private work at original ordinals', async () => {
        const result = await captureHistoricalPartialAvailableReplayBundle({
            requestFingerprint: 'a'.repeat(64),
            sourceLineage: lineage,
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
            source: {
                profiles: [
                    { ordinal: 3, partition: 'private', profile: { ...publicProfile('private'), isPrivate: true, profilePicUrl: undefined, latestPosts: undefined } },
                    { ordinal: 9, partition: 'public', profile: publicProfile('expired') },
                    { ordinal: 12, partition: 'public', profile: publicProfile('available') },
                    { ordinal: 15, partition: 'fetch_terminal', username: 'terminal' },
                ],
                evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
            },
            normalizeMedia: async media => {
                if (media.selectionId.includes('expired')) {
                    throw new AnalysisImagePreparationError('source_missing', 'permanent');
                }
                return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
            },
            now: Date.parse('2026-07-27T00:00:00.000Z'),
        });

        expect(result.bundle).toMatchObject({
            schemaVersion: 2,
            capture: {
                scope: 'ai-only-historical-partial-available',
                notExact: true,
                fullE2eEvidence: false,
                noMediaSubstitution: true,
            },
            profiles: [
                { ordinal: 3, isPrivate: true },
                { ordinal: 12, isPrivate: false },
            ],
        });
        expect(result.bundle.capture.partial?.sourceUniverseDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(result.bundle.capture.partial?.mediaUnavailable).toEqual([
            expect.objectContaining({ ordinal: 9, terminal: 'media_unavailable' }),
        ]);
        expect(result.report.partitions).toEqual({
            private: 1,
            fetch_terminal: 1,
            public_available: 1,
            public_media_unavailable: 1,
            total: 4,
        });
        expect(result.report.aiWorkload).toEqual({ publicTriage: 1, publicFeature: 1, privateNames: 1 });
    });

    it('applies canonical triage and feature gates independently and keeps its visible report identifier-free', async () => {
        const result = await captureHistoricalPartialAvailableReplayBundle({
            requestFingerprint: 'b'.repeat(64), sourceLineage: lineage,
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
            source: {
                profiles: [{ ordinal: 99, partition: 'public', profile: publicProfile('sensitive_name', 8) }],
                evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
            },
            normalizeMedia: async media => {
                if (media.selectionId.includes('sensitive_name-6') || media.selectionId.includes('sensitive_name-7')) {
                    throw new AnalysisImagePreparationError('source_missing', 'permanent');
                }
                return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
            },
        });

        expect(result.report.stages.triage).toMatchObject({ selected: 5, normalized: 5, failed: 0 });
        expect(result.report.stages.feature).toMatchObject({ selected: 9, normalized: 7, failed: 2 });
        expect(result.report.partitions.public_media_unavailable).toBe(1);
        const visible = JSON.stringify(partialAvailableSafeReport(result.report));
        expect(visible).not.toContain('sensitive_name');
        expect(visible).not.toContain('cdn.example');
        expect(visible).not.toContain('ordinal');
    });

    it('keeps a public profile missing from retained media as an encrypted media-unavailable terminal', async () => {
        const result = await captureHistoricalPartialAvailableReplayBundle({
            requestFingerprint: 'd'.repeat(64), sourceLineage: lineage,
            evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' },
            source: { profiles: [{ ordinal: 44, partition: 'public', username: 'not_visible' }], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] } },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        });
        expect(result.report.partitions).toMatchObject({ public_media_unavailable: 1, total: 1 });
        expect(result.bundle.capture.partial?.mediaUnavailable).toEqual([
            expect.objectContaining({ ordinal: 44, terminal: 'media_unavailable', reasons: ['profile_unavailable'] }),
        ]);
    });

    it('canonicalizes the universe digest by original ordinal and normalized username', async () => {
        const sourceProfiles = [
            { ordinal: 8, partition: 'public' as const, profile: publicProfile('Bravo') },
            { ordinal: 2, partition: 'private' as const, profile: { ...publicProfile('alpha'), isPrivate: true, latestPosts: undefined, profilePicUrl: undefined } },
        ];
        const capture = (profiles: typeof sourceProfiles) => captureHistoricalPartialAvailableReplayBundle({
            requestFingerprint: 'e'.repeat(64), sourceLineage: lineage,
            evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' },
            source: { profiles, evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] } },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        });
        const [forward, reversed] = await Promise.all([capture(sourceProfiles), capture([...sourceProfiles].reverse())]);
        expect(forward.bundle.capture.partial?.sourceUniverseDigest).toBe(reversed.bundle.capture.partial?.sourceUniverseDigest);
    });

    it.each([
        { profiles: [{ ordinal: 1, partition: 'public' as const, profile: publicProfile('one'), username: 'different' }] },
        { profiles: [{ ordinal: 1, partition: 'private' as const, profile: publicProfile('one') }] },
        { profiles: [{ ordinal: 1, partition: 'fetch_terminal' as const, profile: publicProfile('one') }] },
    ])('rejects inconsistent candidate partition identity %#', async ({ profiles }) => {
        await expect(captureHistoricalPartialAvailableReplayBundle({
            requestFingerprint: 'f'.repeat(64), sourceLineage: lineage,
            evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' },
            source: { profiles, evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] } },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    });

    it('rejects duplicate normalized usernames at distinct source ordinals', async () => {
        await expect(captureHistoricalPartialAvailableReplayBundle({
            requestFingerprint: '1'.repeat(64), sourceLineage: lineage,
            evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' },
            source: {
                profiles: [
                    { ordinal: 1, partition: 'public', profile: publicProfile('duplicate') },
                    { ordinal: 7, partition: 'fetch_terminal', username: '@DUPLICATE' },
                ],
                evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
            },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    });
});
