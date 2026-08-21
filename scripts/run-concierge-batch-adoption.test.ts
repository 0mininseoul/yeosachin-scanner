import { describe, expect, it, vi } from 'vitest';

const conciergeBatchTestMocks = vi.hoisted(() => ({
    analyzeWithGemini: vi.fn(),
    readFileSync: vi.fn(),
    supabaseRpc: vi.fn(),
    provider: {
        getProfile: vi.fn(),
        getFollowers: vi.fn(),
        getFollowing: vi.fn(),
        getProfilesBatchOutcomes: vi.fn(),
    },
    makeApifyProvider: vi.fn(),
    interactionAdapter: {
        getPostLikers: vi.fn(),
        getPostComments: vi.fn(),
    },
    makeApifyInteractionAdapter: vi.fn(),
    captureFirstPaymentConciergeAiBundle: vi.fn(),
}));

vi.mock('@/lib/services/ai/gemini', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/ai/gemini')>(),
    analyzeWithGemini: conciergeBatchTestMocks.analyzeWithGemini,
}));

vi.mock('node:fs', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs')>(),
    readFileSync: conciergeBatchTestMocks.readFileSync,
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: conciergeBatchTestMocks.supabaseRpc },
}));

vi.mock('@/lib/services/instagram/providers/apify', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/instagram/providers/apify')>(),
    makeApifyProvider: conciergeBatchTestMocks.makeApifyProvider,
}));

vi.mock('@/lib/services/instagram/providers/apify-interactions', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/instagram/providers/apify-interactions')>(),
    makeApifyInteractionAdapter: conciergeBatchTestMocks.makeApifyInteractionAdapter,
}));

vi.mock('@/lib/services/analysis/first-payment-concierge', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/analysis/first-payment-concierge')>(),
    captureFirstPaymentConciergeAiBundle: conciergeBatchTestMocks.captureFirstPaymentConciergeAiBundle,
}));

import {
    buildConciergeBatchHighRiskCopyPrompt,
    collectBatchCopyFacts,
    conciergeBatchAiClassificationFields,
    conciergeBatchNameOnlyEnabled,
    conciergeBatchFeedTriageEnabled,
    conciergeBatchNameFallbackEnabled,
    conciergeBatchCandidateHygieneEnabled,
    conciergeGenderRosterCounts,
    conciergeUpsertAccountDetail,
    relationshipCollectionSlots,
    collectOrder,
    conciergeGenderResolverAdmissionDiagnosticMessage,
    conciergeNameOnlyDiagnosticMessage,
    conciergeBatchFailureDiagnostic,
    generateConciergeBatchCandidateCopies,
    generateConciergeBatchHighRiskCopy,
    conciergeBatchCopyRetryFeedbackEnabled,
    conciergeBatchCopyRetryFeedbackInstruction,
    hydrateConciergeProfilesFromPack,
    isRecoverableTargetProfileArtifactError,
    isMatchingTargetProfileArtifactRun,
    loadConciergeProfilePack,
    mergeConciergeBatchTargetFullNameStepData,
    CONCIERGE_BATCH_MUTABLE_REQUEST_STATUSES,
    nameOnlyFirstPass,
    nameOnlySecondPass,
    parseConciergeProfilePack,
    parseConciergeExistingRelationshipArtifacts,
    relationshipArtifactProviderContext,
    retryableFailureCode,
    sanitizeConciergeBatchDiagnostic,
    selectConciergeBatchOnlyOrders,
    selectConciergeBatchActiveScope,
    conciergeBatchIncludeExcludedTargetEnabled,
    type ConciergeBatchHighRiskCopyEvidence,
    validateConciergeBatchHighRiskCopy,
} from './run-concierge-batch';
import { runConciergeBatch, type ConciergeBatchStageContext } from '@/lib/services/analysis/concierge-batch-runner';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { ConciergeClassificationRecord } from '@/lib/services/analysis/concierge-classification-import';
import type { ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';

function profilePackItem(username: string, overrides: Record<string, unknown> = {}) {
    return {
        username,
        private: false,
        followersCount: 10,
        followsCount: 10,
        postsCount: 0,
        biography: 'profile pack fixture',
        fullName: `${username} name`,
        profilePicUrl: 'https://example.com/profile.jpg',
        verified: false,
        latestPosts: [],
        ...overrides,
    };
}

function interactionProfilePackItem(username: string) {
    return profilePackItem(username, {
        followersCount: 0,
        followsCount: 0,
        postsCount: 1,
        latestPosts: [{
            id: 'post-1',
            shortCode: 'post1',
            type: 'image',
            displayUrl: 'https://example.com/post.jpg',
            likesCount: 1,
            commentsCount: 1,
            timestamp: '2026-08-17T00:00:00.000Z',
        }],
    });
}

function interactionCollectOrderFixture() {
    const order = {
        orderId: '00000000-0000-4000-8000-000000000011',
        ownerId: '00000000-0000-4000-8000-000000000012',
        targetUsername: 'interaction_target',
        planId: 'basic' as const,
        cohort: 'awaiting_operator' as const,
        preflightId: '00000000-0000-4000-8000-000000000013',
        targetFollowers: 0,
        targetFollowing: 0,
    };
    const prepared = {
        sourceRequestId: '00000000-0000-4000-8000-000000000014',
        requestId: '00000000-0000-4000-8000-000000000015',
        preflightId: order.preflightId,
    };
    const context: ConciergeBatchStageContext = {
        actorConcurrency: 2,
        tokenPriority: [],
        withActorSlot: operation => operation(),
    };
    const artifacts = parseConciergeExistingRelationshipArtifacts(JSON.stringify({
        interaction_target: {
            followers: { runId: 'Abcdef12', credentialSlot: 'secondary', sourceDeclaredCount: 1 },
            following: { runId: 'Zyxwvu98', credentialSlot: 'secondary', sourceDeclaredCount: 1 },
        },
    }));
    return { order, prepared, context, artifacts };
}

describe('concierge profile pack adapter', () => {
    it('retains existing request step data while storing the target full name', () => {
        const merged = mergeConciergeBatchTargetFullNameStepData({
            conciergeBatchBootstrap: { orderId: 'order' },
            targetFullName: 'old name',
        }, '  임태욱  ');

        expect(merged).toMatchObject({
            conciergeBatchBootstrap: { orderId: 'order' },
            targetFullName: '임태욱',
        });
        expect(mergeConciergeBatchTargetFullNameStepData(merged, '   ')).toEqual(merged);
    });

    it('stores a valid Instagram-hosted target profile image URL', () => {
        const merged = mergeConciergeBatchTargetFullNameStepData(
            { conciergeBatchBootstrap: { orderId: 'order' } },
            null,
            'https://scontent.cdninstagram.com/v/target-profile.jpg?_nc_ht=1',
        );

        expect(merged).toMatchObject({
            targetProfileImage: 'https://scontent.cdninstagram.com/v/target-profile.jpg?_nc_ht=1',
        });
        expect(merged.targetFullName).toBeUndefined();
    });

    it('skips a non-Instagram-hosted or blank target profile image URL instead of storing it', () => {
        const existing = { conciergeBatchBootstrap: { orderId: 'order' } };

        expect(mergeConciergeBatchTargetFullNameStepData(
            existing, null, 'https://evil.example.com/steal.jpg',
        )).toEqual(existing);
        expect(mergeConciergeBatchTargetFullNameStepData(existing, null, '')).toEqual(existing);
        expect(mergeConciergeBatchTargetFullNameStepData(existing, null, null)).toEqual(existing);
        expect(mergeConciergeBatchTargetFullNameStepData(existing, null, undefined)).toEqual(existing);
        // http (not https) must also be rejected, even on an allowed host.
        expect(mergeConciergeBatchTargetFullNameStepData(
            existing, null, 'http://scontent.cdninstagram.com/v/target.jpg',
        )).toEqual(existing);
    });

    it('stores the target full name and profile image together in one merge/persist pass', () => {
        const merged = mergeConciergeBatchTargetFullNameStepData(
            { conciergeBatchBootstrap: { orderId: 'order' } },
            '  임태욱  ',
            'https://scontent.fbcdn.net/v/target-profile.jpg',
        );

        expect(merged).toMatchObject({
            targetFullName: '임태욱',
            targetProfileImage: 'https://scontent.fbcdn.net/v/target-profile.jpg',
        });
    });

    it('treats a failed request as mutable so retried orders can publish', () => {
        // loadRetryCodeByOrder only admits an order whose request sits at
        // 'failed', so the publish-stage guards must accept that status.
        expect([...CONCIERGE_BATCH_MUTABLE_REQUEST_STATUSES]).toEqual(
            ['pending', 'processing', 'failed'],
        );
    });

    it('loads the profile pack once for repeated order loads at the same path', () => {
        conciergeBatchTestMocks.readFileSync.mockReset().mockReturnValue(JSON.stringify({
            version: 1,
            profiles: { packed_user: profilePackItem('packed_user') },
        }));

        const first = loadConciergeProfilePack('/tmp/concierge-profile-pack-memo.json');
        const second = loadConciergeProfilePack('/tmp/concierge-profile-pack-memo.json');

        expect(second).toBe(first);
        expect(conciergeBatchTestMocks.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('hydrates pack hits and sends only pack misses to the provider', () => {
        const pack = parseConciergeProfilePack({
            version: 1,
            profiles: { packed_user: profilePackItem('packed_user') },
        });

        const result = hydrateConciergeProfilesFromPack(
            ['packed_user', 'provider_user'],
            pack,
        );

        expect([...result.profilesByUsername.keys()]).toEqual(['packed_user']);
        expect(result.providerUsernames).toEqual(['provider_user']);
    });

    it('keeps the existing provider path when the pack path is not configured', () => {
        const pack = loadConciergeProfilePack('');
        const result = hydrateConciergeProfilesFromPack(['provider_user'], pack);

        expect(pack).toBeNull();
        expect(result.profilesByUsername).toEqual(new Map());
        expect(result.providerUsernames).toEqual(['provider_user']);
    });

    it('downgrades a contaminated pack item to a provider miss for that username only', () => {
        const pack = parseConciergeProfilePack({
            version: 1,
            profiles: {
                bad_user: profilePackItem('bad_user', { postsCount: 1 }),
                good_user: profilePackItem('good_user'),
            },
        });

        const result = hydrateConciergeProfilesFromPack(['bad_user', 'good_user'], pack);

        expect([...result.profilesByUsername.keys()]).toEqual(['good_user']);
        expect(result.providerUsernames).toEqual(['bad_user']);
    });

    it('does not call provider.getProfile when collectOrder finds the target in the pack', async () => {
        const previousPackPath = process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
        const previousSecondaryToken = process.env.APIFY_SECONDARY_API_TOKEN;
        process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = '/tmp/concierge-target-profile-pack.json';
        process.env.APIFY_SECONDARY_API_TOKEN = 'test-token';
        conciergeBatchTestMocks.readFileSync.mockReset().mockReturnValue(JSON.stringify({
            version: 1,
            profiles: {
                target_user: profilePackItem('target_user', {
                    followersCount: 0,
                    followsCount: 0,
                    postsCount: 0,
                    latestPosts: [],
                }),
            },
        }));
        conciergeBatchTestMocks.supabaseRpc.mockResolvedValue({ data: [], error: null });
        conciergeBatchTestMocks.provider.getProfile.mockReset().mockResolvedValue(null);
        conciergeBatchTestMocks.provider.getFollowers.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.provider.getFollowing.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.makeApifyProvider.mockReset().mockReturnValue(conciergeBatchTestMocks.provider);
        conciergeBatchTestMocks.captureFirstPaymentConciergeAiBundle.mockReset().mockResolvedValue({
            bundle: { capture: {} },
        });

        const artifacts = parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: { runId: 'Abcdef12', credentialSlot: 'secondary', sourceDeclaredCount: 1 },
                following: { runId: 'Zyxwvu98', credentialSlot: 'secondary', sourceDeclaredCount: 1 },
            },
        }));
        const order = {
            orderId: '00000000-0000-4000-8000-000000000001',
            ownerId: '00000000-0000-4000-8000-000000000002',
            targetUsername: 'target_user',
            planId: 'basic' as const,
            cohort: 'awaiting_operator' as const,
            preflightId: '00000000-0000-4000-8000-000000000003',
            targetFollowers: 0,
            targetFollowing: 0,
        };
        const prepared = {
            sourceRequestId: '00000000-0000-4000-8000-000000000004',
            requestId: '00000000-0000-4000-8000-000000000005',
            preflightId: order.preflightId,
        };
        const context: ConciergeBatchStageContext = {
            actorConcurrency: 2,
            tokenPriority: [],
            withActorSlot: operation => operation(),
        };

        try {
            await collectOrder(order, prepared, context, artifacts);
            expect(conciergeBatchTestMocks.provider.getProfile).not.toHaveBeenCalled();
        } finally {
            if (previousPackPath === undefined) delete process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
            else process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = previousPackPath;
            if (previousSecondaryToken === undefined) delete process.env.APIFY_SECONDARY_API_TOKEN;
            else process.env.APIFY_SECONDARY_API_TOKEN = previousSecondaryToken;
        }
    });

    it('drops candidate posts without ids before interaction evidence is forwarded', async () => {
        const previousPackPath = process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
        const previousSecondaryToken = process.env.APIFY_SECONDARY_API_TOKEN;
        process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = '/tmp/concierge-invalid-interaction-post-pack.json';
        process.env.APIFY_SECONDARY_API_TOKEN = 'test-token';
        conciergeBatchTestMocks.readFileSync.mockReset().mockReturnValue(JSON.stringify({
            version: 1,
            profiles: {
                interaction_target: profilePackItem('interaction_target', {
                    followersCount: 1,
                    followsCount: 1,
                    postsCount: 0,
                    latestPosts: [],
                }),
            },
        }));
        conciergeBatchTestMocks.supabaseRpc.mockReset().mockResolvedValue({ data: [], error: null });
        conciergeBatchTestMocks.provider.getProfile.mockReset().mockResolvedValue(null);
        conciergeBatchTestMocks.provider.getFollowers.mockReset().mockResolvedValue([{
            username: 'candidate_user', fullName: 'Candidate Name', profilePicUrl: null,
            isPrivate: false, isVerified: false,
        }]);
        conciergeBatchTestMocks.provider.getFollowing.mockReset().mockResolvedValue([{
            username: 'candidate_user', fullName: 'Candidate Name', profilePicUrl: null,
            isPrivate: false, isVerified: false,
        }]);
        conciergeBatchTestMocks.provider.getProfilesBatchOutcomes.mockReset().mockResolvedValue([{
            outcome: { status: 'success' },
            profile: {
                username: 'candidate_user', isPrivate: false, isVerified: false,
                followersCount: 1, followingCount: 1, postsCount: 2,
                profilePicUrl: 'https://example.com/candidate.jpg', fullName: 'Candidate Name',
                bio: 'candidate profile',
                latestPosts: [
                    {
                        id: 'candidate-post-1', shortCode: 'candidate-1', type: 'image',
                        displayUrl: 'https://example.com/candidate-1.jpg', likesCount: 1,
                        commentsCount: 0, timestamp: '2026-08-17T00:00:00.000Z',
                    },
                    {
                        id: '', shortCode: 'candidate-no-id', type: 'image',
                        displayUrl: 'https://example.com/candidate-no-id.jpg', likesCount: 1,
                        commentsCount: 0, timestamp: '2026-08-16T00:00:00.000Z',
                    },
                ],
            },
        }]);
        conciergeBatchTestMocks.makeApifyProvider.mockReset().mockReturnValue(conciergeBatchTestMocks.provider);
        conciergeBatchTestMocks.captureFirstPaymentConciergeAiBundle.mockReset().mockResolvedValue({
            bundle: { capture: {} },
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        try {
            const fixture = interactionCollectOrderFixture();
            fixture.order.targetFollowers = 1;
            fixture.order.targetFollowing = 1;
            const result = await collectOrder(
                fixture.order,
                fixture.prepared,
                fixture.context,
                fixture.artifacts,
            );
            expect(result.interaction.candidatePostsByUsername.get('candidate_user')).toMatchObject([
                { id: 'candidate-post-1' },
            ]);
            expect(stderrSpy.mock.calls.some(([chunk]) => (
                String(chunk).includes(
                    'sanitized candidate posts for candidate_user: dropped 1 (no-id 1, dup 0)',
                )
            ))).toBe(true);
        } finally {
            stderrSpy.mockRestore();
            if (previousPackPath === undefined) delete process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
            else process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = previousPackPath;
            if (previousSecondaryToken === undefined) delete process.env.APIFY_SECONDARY_API_TOKEN;
            else process.env.APIFY_SECONDARY_API_TOKEN = previousSecondaryToken;
        }
    });

    it('keeps the first post when candidate and target post ids are duplicated', async () => {
        const previousPackPath = process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
        const previousSecondaryToken = process.env.APIFY_SECONDARY_API_TOKEN;
        process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = '/tmp/concierge-duplicate-interaction-post-pack.json';
        process.env.APIFY_SECONDARY_API_TOKEN = 'test-token';
        const targetPost = {
            id: 'target-duplicate', shortCode: 'target-duplicate', type: 'image',
            displayUrl: 'https://example.com/target.jpg', likesCount: 1, commentsCount: 0,
            timestamp: '2026-08-17T00:00:00.000Z',
        };
        conciergeBatchTestMocks.readFileSync.mockReset().mockReturnValue(JSON.stringify({
            version: 1,
            profiles: {
                interaction_target: profilePackItem('interaction_target', {
                    followersCount: 1,
                    followsCount: 1,
                    postsCount: 2,
                    latestPosts: [targetPost, { ...targetPost, shortCode: 'target-duplicate-copy' }],
                }),
            },
        }));
        conciergeBatchTestMocks.supabaseRpc.mockReset().mockResolvedValue({ data: [], error: null });
        conciergeBatchTestMocks.provider.getProfile.mockReset().mockResolvedValue(null);
        conciergeBatchTestMocks.provider.getFollowers.mockReset().mockResolvedValue([{
            username: 'candidate_user', fullName: 'Candidate Name', profilePicUrl: null,
            isPrivate: false, isVerified: false,
        }]);
        conciergeBatchTestMocks.provider.getFollowing.mockReset().mockResolvedValue([{
            username: 'candidate_user', fullName: 'Candidate Name', profilePicUrl: null,
            isPrivate: false, isVerified: false,
        }]);
        conciergeBatchTestMocks.provider.getProfilesBatchOutcomes.mockReset().mockResolvedValue([{
            outcome: { status: 'success' },
            profile: {
                username: 'candidate_user', isPrivate: false, isVerified: false,
                followersCount: 1, followingCount: 1, postsCount: 3,
                profilePicUrl: 'https://example.com/candidate.jpg', fullName: 'Candidate Name',
                bio: 'candidate profile',
                latestPosts: [
                    {
                        id: 'candidate-duplicate', shortCode: 'candidate-duplicate-1', type: 'image',
                        displayUrl: 'https://example.com/candidate-duplicate-1.jpg', likesCount: 1,
                        commentsCount: 0, timestamp: '2026-08-17T00:00:00.000Z',
                    },
                    {
                        id: 'candidate-duplicate', shortCode: 'candidate-duplicate-2', type: 'image',
                        displayUrl: 'https://example.com/candidate-duplicate-2.jpg', likesCount: 1,
                        commentsCount: 0, timestamp: '2026-08-16T00:00:00.000Z',
                    },
                    {
                        id: 'candidate-unique', shortCode: 'candidate-unique', type: 'image',
                        displayUrl: 'https://example.com/candidate-unique.jpg', likesCount: 1,
                        commentsCount: 0, timestamp: '2026-08-15T00:00:00.000Z',
                    },
                ],
            },
        }]);
        conciergeBatchTestMocks.makeApifyProvider.mockReset().mockReturnValue(conciergeBatchTestMocks.provider);
        conciergeBatchTestMocks.makeApifyInteractionAdapter.mockReset()
            .mockReturnValue(conciergeBatchTestMocks.interactionAdapter);
        conciergeBatchTestMocks.interactionAdapter.getPostLikers.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.interactionAdapter.getPostComments.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.captureFirstPaymentConciergeAiBundle.mockReset().mockResolvedValue({
            bundle: { capture: {} },
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        try {
            const fixture = interactionCollectOrderFixture();
            fixture.order.targetFollowers = 1;
            fixture.order.targetFollowing = 1;
            const result = await collectOrder(
                fixture.order,
                fixture.prepared,
                fixture.context,
                fixture.artifacts,
            );
            expect(result.interaction.targetPosts.map(post => post.id)).toEqual(['target-duplicate']);
            expect(result.interaction.candidatePostsByUsername.get('candidate_user')?.map(post => post.id))
                .toEqual(['candidate-duplicate', 'candidate-unique']);
            expect(stderrSpy.mock.calls.some(([chunk]) => (
                String(chunk).includes(
                    'sanitized target posts for interaction_target: dropped 1 (no-id 0, dup 1)',
                )
            ))).toBe(true);
            expect(stderrSpy.mock.calls.some(([chunk]) => (
                String(chunk).includes(
                    'sanitized candidate posts for candidate_user: dropped 1 (no-id 0, dup 1)',
                )
            ))).toBe(true);
        } finally {
            stderrSpy.mockRestore();
            if (previousPackPath === undefined) delete process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
            else process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = previousPackPath;
            if (previousSecondaryToken === undefined) delete process.env.APIFY_SECONDARY_API_TOKEN;
            else process.env.APIFY_SECONDARY_API_TOKEN = previousSecondaryToken;
        }
    });

    it('continues the order with empty comments when comment collection fails', async () => {
        const previousPackPath = process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
        const previousSecondaryToken = process.env.APIFY_SECONDARY_API_TOKEN;
        process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = '/tmp/concierge-comments-best-effort-pack.json';
        process.env.APIFY_SECONDARY_API_TOKEN = 'test-token';
        conciergeBatchTestMocks.readFileSync.mockReset().mockReturnValue(JSON.stringify({
            version: 1,
            profiles: {
                interaction_target: interactionProfilePackItem('interaction_target'),
            },
        }));
        conciergeBatchTestMocks.supabaseRpc.mockReset().mockResolvedValue({ data: [], error: null });
        conciergeBatchTestMocks.provider.getProfile.mockReset().mockResolvedValue(null);
        conciergeBatchTestMocks.provider.getFollowers.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.provider.getFollowing.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.makeApifyProvider.mockReset().mockReturnValue(conciergeBatchTestMocks.provider);
        conciergeBatchTestMocks.makeApifyInteractionAdapter.mockReset()
            .mockReturnValue(conciergeBatchTestMocks.interactionAdapter);
        conciergeBatchTestMocks.interactionAdapter.getPostLikers.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.interactionAdapter.getPostComments.mockReset()
            .mockRejectedValue(new Error('SCRAPING_PROVIDER_START_REJECTED_ERROR'));
        conciergeBatchTestMocks.captureFirstPaymentConciergeAiBundle.mockReset().mockResolvedValue({
            bundle: { capture: {} },
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        try {
            const fixture = interactionCollectOrderFixture();
            const result = await collectOrder(
                fixture.order,
                fixture.prepared,
                fixture.context,
                fixture.artifacts,
            );

            expect(result.interaction.targetToCandidate.commentCoverage).toEqual([]);
            expect(stderrSpy.mock.calls.some(([chunk]) => (
                String(chunk).includes(
                    'comments unavailable for interaction_target: SCRAPING_PROVIDER_START_REJECTED_ERROR',
                )
            ))).toBe(true);
        } finally {
            stderrSpy.mockRestore();
            if (previousPackPath === undefined) delete process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
            else process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = previousPackPath;
            if (previousSecondaryToken === undefined) delete process.env.APIFY_SECONDARY_API_TOKEN;
            else process.env.APIFY_SECONDARY_API_TOKEN = previousSecondaryToken;
        }
    });

    it('keeps liker collection failures fatal to the order', async () => {
        const previousPackPath = process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
        const previousSecondaryToken = process.env.APIFY_SECONDARY_API_TOKEN;
        process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = '/tmp/concierge-likers-fatal-pack.json';
        process.env.APIFY_SECONDARY_API_TOKEN = 'test-token';
        conciergeBatchTestMocks.readFileSync.mockReset().mockReturnValue(JSON.stringify({
            version: 1,
            profiles: {
                interaction_target: interactionProfilePackItem('interaction_target'),
            },
        }));
        conciergeBatchTestMocks.supabaseRpc.mockReset().mockResolvedValue({ data: [], error: null });
        conciergeBatchTestMocks.provider.getProfile.mockReset().mockResolvedValue(null);
        conciergeBatchTestMocks.provider.getFollowers.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.provider.getFollowing.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.makeApifyProvider.mockReset().mockReturnValue(conciergeBatchTestMocks.provider);
        conciergeBatchTestMocks.makeApifyInteractionAdapter.mockReset()
            .mockReturnValue(conciergeBatchTestMocks.interactionAdapter);
        conciergeBatchTestMocks.interactionAdapter.getPostLikers.mockReset()
            .mockRejectedValue(new Error('LIKERS_COLLECTION_FAILURE'));
        conciergeBatchTestMocks.interactionAdapter.getPostComments.mockReset().mockResolvedValue([]);
        conciergeBatchTestMocks.captureFirstPaymentConciergeAiBundle.mockReset().mockResolvedValue({
            bundle: { capture: {} },
        });

        try {
            const fixture = interactionCollectOrderFixture();
            await expect(collectOrder(
                fixture.order,
                fixture.prepared,
                fixture.context,
                fixture.artifacts,
            )).rejects.toThrow('LIKERS_COLLECTION_FAILURE');
        } finally {
            if (previousPackPath === undefined) delete process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH;
            else process.env.CONCIERGE_BATCH_PROFILE_PACK_PATH = previousPackPath;
            if (previousSecondaryToken === undefined) delete process.env.APIFY_SECONDARY_API_TOKEN;
            else process.env.APIFY_SECONDARY_API_TOKEN = previousSecondaryToken;
        }
    });
});

describe('concierge batch only-order allowlist', () => {
    it('keeps only allowlisted orders and rejects an id outside the frozen scope', () => {
        const first = '00000000-0000-4000-8000-000000000001';
        const second = '00000000-0000-4000-8000-000000000002';
        const outside = '00000000-0000-4000-8000-000000000003';
        const scope = [{ orderId: first }, { orderId: second }];

        expect(selectConciergeBatchOnlyOrders(scope, `${second}`)).toEqual([{ orderId: second }]);
        expect(() => selectConciergeBatchOnlyOrders(scope, `${first},${outside}`))
            .toThrow('CONCIERGE_BATCH_ONLY_ORDERS_INVALID');
    });
});

describe('concierge name-only gender classification', () => {
    it('derives ledger AI and effective classifications from replay final classification', () => {
        expect(conciergeBatchAiClassificationFields({
            finalClassification: 'verified_non_female',
        } as never)).toEqual({
            originalAiClassification: 'male',
            effectiveClassification: 'male',
        });
        expect(conciergeBatchAiClassificationFields({
            finalClassification: 'verified_female',
        } as never)).toEqual({
            originalAiClassification: 'female',
            effectiveClassification: 'female',
        });
        expect(conciergeBatchAiClassificationFields({
            finalClassification: 'unresolved',
        } as never)).toEqual({
            originalAiClassification: 'unknown',
            effectiveClassification: 'unknown',
        });
    });

    it('formats a redacted, count-only classification diagnostic for the execution log', () => {
        const message = conciergeNameOnlyDiagnosticMessage({
            totalPublicDetails: 10,
            droppedNoProfile: 1,
            droppedNoTriageAssessment: 1,
            droppedHasFeature: 1,
            droppedUsableProfileImage: 1,
            droppedNotUnknown: 1,
            candidateCount: 5,
            droppedNoFullName: 1,
            droppedInferredUnknown: 1,
            droppedBelowMinConfidence: 1,
            eligibleCount: 1,
            eligibleMaleCount: 1,
            eligibleFemaleCount: 0,
            batchCount: 1,
            classifiedCount: 1,
            femaleCount: 0,
            maleCount: 1,
            unknownCount: 0,
            unknownRatio: 0.9,
        });

        expect(message).toContain('concierge name-only classification:');
        expect(message).toContain('"totalPublicDetails":10');
        expect(message).toContain('"droppedNoProfile":1');
        expect(message).toContain('"batchCount":1');
        expect(message).toContain('"unknownRatio":0.9');
        expect(message).not.toContain('https://');
    });

    it('formats a gender-resolver admission diagnostic covering all 5 reasons for the execution log', () => {
        // Criterion 6: the 45-of-88 image-path resolver drop-off had no
        // post-hoc reason breakdown; this line is what makes it auditable.
        // uncertain_or_absent stays in the shape even though it is normally
        // zero (wide admission default) - it is the only reason that becomes
        // nonzero when CONCIERGE_BATCH_RESOLVER_WIDE_ADMISSION is rolled back,
        // and a rollback's drop-off needs to be observable too.
        const message = conciergeGenderResolverAdmissionDiagnosticMessage({
            eligible: 43,
            alreadyVerified: 5,
            officialOrGroup: 2,
            uncertainOrAbsent: 7,
            insufficientMedia: 38,
        });

        expect(message).toContain('concierge gender-resolver admission:');
        expect(message).toContain('"eligible":43');
        expect(message).toContain('"already_verified":5');
        expect(message).toContain('"official_or_group":2');
        expect(message).toContain('"uncertain_or_absent":7');
        expect(message).toContain('"insufficient_media":38');
    });

    it('records a name-only ledger pass as no-image even when the raw profile URL looks like a real photo', () => {
        // Name-only routing already decided (via the AI pipeline's byte-verified
        // hasProfileImage signal) that this candidate has no usable profile image.
        // The ledger record must assert that directly instead of re-deriving it
        // from hasUsableInstagramProfileImage, a weaker URL-only heuristic that
        // can disagree with the byte-verified check and produce a false
        // CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID rejection.
        const profile = {
            username: 'candidate',
            fullName: 'Jane Doe',
            profilePicUrl: 'https://example.com/definitely-a-real-photo.jpg',
            profilePicUrlHD: null,
        } as unknown as InstagramProfile;

        const firstPass = nameOnlyFirstPass(profile, 'a'.repeat(64));
        const secondPass = nameOnlySecondPass(profile);

        expect(firstPass).toMatchObject({ status: 'failed', profilePicPresent: false });
        expect(secondPass).toMatchObject({ status: 'not_collected', profilePicPresent: false, completeMedia: null });
    });

    it('reads CONCIERGE_BATCH_NAME_ONLY_ENABLED with a default-enabled, explicit-false-only flag', () => {
        expect(conciergeBatchNameOnlyEnabled(undefined)).toBe(true);
        expect(conciergeBatchNameOnlyEnabled('')).toBe(true);
        expect(conciergeBatchNameOnlyEnabled('true')).toBe(true);
        expect(conciergeBatchNameOnlyEnabled('anything-else')).toBe(true);
        expect(conciergeBatchNameOnlyEnabled('false')).toBe(false);
    });

    it('reads CONCIERGE_BATCH_FEED_TRIAGE_ENABLED with a default-off, explicit-true-only flag', () => {
        expect(conciergeBatchFeedTriageEnabled(undefined)).toBe(false);
        expect(conciergeBatchFeedTriageEnabled('')).toBe(false);
        expect(conciergeBatchFeedTriageEnabled('false')).toBe(false);
        expect(conciergeBatchFeedTriageEnabled('anything-else')).toBe(false);
        expect(conciergeBatchFeedTriageEnabled('true')).toBe(true);
        expect(conciergeBatchFeedTriageEnabled('1')).toBe(true);
    });

    it('reads CONCIERGE_BATCH_NAME_FALLBACK_ENABLED with a default-off, explicit-true-only flag', () => {
        expect(conciergeBatchNameFallbackEnabled(undefined)).toBe(false);
        expect(conciergeBatchNameFallbackEnabled('')).toBe(false);
        expect(conciergeBatchNameFallbackEnabled('false')).toBe(false);
        expect(conciergeBatchNameFallbackEnabled('true')).toBe(true);
        expect(conciergeBatchNameFallbackEnabled('1')).toBe(true);
    });

    it('reads CONCIERGE_BATCH_CANDIDATE_HYGIENE_ENABLED with a default-off, explicit-true-only flag', () => {
        expect(conciergeBatchCandidateHygieneEnabled(undefined)).toBe(false);
        expect(conciergeBatchCandidateHygieneEnabled('')).toBe(false);
        expect(conciergeBatchCandidateHygieneEnabled('false')).toBe(false);
        expect(conciergeBatchCandidateHygieneEnabled('true')).toBe(true);
        expect(conciergeBatchCandidateHygieneEnabled('1')).toBe(true);
    });
});

describe('relationshipCollectionSlots (CONCIERGE_BATCH_RELATIONSHIP_SLOTS override)', () => {
    function withEnv(value: string | undefined, run: () => void): void {
        const previous = process.env.CONCIERGE_BATCH_RELATIONSHIP_SLOTS;
        if (value === undefined) delete process.env.CONCIERGE_BATCH_RELATIONSHIP_SLOTS;
        else process.env.CONCIERGE_BATCH_RELATIONSHIP_SLOTS = value;
        try {
            run();
        } finally {
            if (previous === undefined) delete process.env.CONCIERGE_BATCH_RELATIONSHIP_SLOTS;
            else process.env.CONCIERGE_BATCH_RELATIONSHIP_SLOTS = previous;
        }
    }

    it('defaults to [nonary, secondary] when unset - byte parity with the frozen priority', () => {
        withEnv(undefined, () => {
            expect(relationshipCollectionSlots()).toEqual(['nonary', 'secondary']);
        });
        withEnv('', () => {
            expect(relationshipCollectionSlots()).toEqual(['nonary', 'secondary']);
        });
    });

    it('overrides to a balance-holding slot outside the default pair when set', () => {
        withEnv('tertiary', () => {
            expect(relationshipCollectionSlots()).toEqual(['tertiary']);
        });
        withEnv('septenary, primary', () => {
            expect(relationshipCollectionSlots()).toEqual(['septenary', 'primary']);
        });
    });

    it('accepts the tenth slot (a fresh-quota operator token) once the other two default slots run out of balance', () => {
        withEnv('tenth', () => {
            expect(relationshipCollectionSlots()).toEqual(['tenth']);
        });
        withEnv('tenth, nonary', () => {
            expect(relationshipCollectionSlots()).toEqual(['tenth', 'nonary']);
        });
    });

    it('rejects an unknown slot name and a blank/whitespace-only list, but dedups a repeated valid slot instead of rejecting it', () => {
        withEnv('not_a_real_slot', () => {
            expect(() => relationshipCollectionSlots()).toThrow('CONCIERGE_BATCH_RELATIONSHIP_SLOTS_INVALID');
        });
        withEnv(' , ', () => {
            expect(() => relationshipCollectionSlots()).toThrow('CONCIERGE_BATCH_RELATIONSHIP_SLOTS_INVALID');
        });
        withEnv('secondary,secondary', () => {
            expect(relationshipCollectionSlots()).toEqual(['secondary']);
        });
    });
});

describe('concierge account-detail collection dedupes by ordinal (CONCIERGE_PUBLICATION_ANALYZED_COUNT_MISMATCH regression)', () => {
    function fixtureDetail(
        ordinal: number,
        overrides: Partial<ReplayAccountAiDetail> = {},
    ): ReplayAccountAiDetail {
        return {
            ordinal,
            finalClassification: 'unresolved',
            classificationSource: 'unknown',
            featureOverview: null,
            triage: null,
            feature: null,
            ...overrides,
        };
    }

    it('a second onAccountAnalyzed emission for an already-seen ordinal replaces it in place instead of appending a duplicate', () => {
        const details: ReplayAccountAiDetail[] = [];

        conciergeUpsertAccountDetail(details, fixtureDetail(1, { finalClassification: 'verified_female', classificationSource: 'triage' }));
        conciergeUpsertAccountDetail(details, fixtureDetail(2, { finalClassification: 'unresolved', classificationSource: 'unknown' }));
        conciergeUpsertAccountDetail(details, fixtureDetail(3, { finalClassification: 'verified_non_female', classificationSource: 'triage' }));
        // (A) name-fallback re-emits ordinal 2's update to its post-fallback
        // classification, exactly like replay-runner.ts's fallback loop does
        // for a candidate it already emitted once.
        conciergeUpsertAccountDetail(details, fixtureDetail(2, { finalClassification: 'verified_non_female', classificationSource: 'name_only' }));

        // Three distinct public candidates were analyzed - details.length
        // must equal that (the ledger's hydratedPublicCount analog), not 4.
        expect(details).toHaveLength(3);
        expect(details.map(detail => detail.ordinal).sort((a, b) => a - b)).toEqual([1, 2, 3]);
        expect(details.find(detail => detail.ordinal === 2)).toMatchObject({
            finalClassification: 'verified_non_female',
            classificationSource: 'name_only',
        });
    });

    it('a first-time emission for a new ordinal still appends normally', () => {
        const details: ReplayAccountAiDetail[] = [fixtureDetail(1)];

        conciergeUpsertAccountDetail(details, fixtureDetail(2, { finalClassification: 'verified_female', classificationSource: 'feature' }));

        expect(details).toHaveLength(2);
        expect(details[1]).toMatchObject({ ordinal: 2, finalClassification: 'verified_female' });
    });
});

describe('(B3.1) concierge gender roster counts - private/unresolved exclusion', () => {
    function record(
        partition: 'public' | 'private' | 'unresolved',
        effectiveClassification: 'male' | 'female' | 'unknown' | null,
    ): ConciergeClassificationRecord {
        return {
            candidateId: `candidate:${partition}:${effectiveClassification}:${Math.random()}`,
            instagramId: 'fixture_user',
            mutualOrdinal: 1,
            partition,
            profileFetchStatus: partition === 'unresolved' ? 'unavailable' : 'success',
            firstPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null },
            secondPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null },
            originalAiClassification: effectiveClassification,
            effectiveClassification,
            confidence: null,
            evidenceCoverage: null,
            classifier: null,
            modelName: null,
            promptVersion: null,
            schemaVersion: null,
            classificationOperationKey: null,
            classificationResultHash: null,
            classificationSource: 'ai',
            manualOverride: null,
        };
    }

    it('always excludes private candidates - they carry no AI gender evidence', () => {
        const records = [
            record('public', 'male'),
            record('public', 'unknown'),
            record('private', null),
        ];

        expect(conciergeGenderRosterCounts(records, false)).toMatchObject({
            male: 1, female: 0, unknown: 1, excludedPrivateCount: 1, excludedUnresolvedCount: 0,
        });
        expect(conciergeGenderRosterCounts(records, true)).toMatchObject({
            male: 1, female: 0, unknown: 1, excludedPrivateCount: 1, excludedUnresolvedCount: 0,
        });
    });

    it('hygiene off (default) counts an unresolved (private/fetch-unavailable) candidate as unknown - byte parity with the pre-fix roster', () => {
        const records = [
            record('public', 'male'),
            record('public', 'female'),
            record('unresolved', 'unknown'),
        ];

        const roster = conciergeGenderRosterCounts(records, false);

        expect(roster).toMatchObject({
            male: 1, female: 1, unknown: 1, excludedUnresolvedCount: 0,
        });
        expect(roster.unknownRate).toBeCloseTo(1 / 3, 4);
    });

    it('hygiene on excludes an unresolved candidate from the unknown roster entirely', () => {
        const records = [
            record('public', 'male'),
            record('public', 'female'),
            record('unresolved', 'unknown'),
        ];

        const roster = conciergeGenderRosterCounts(records, true);

        expect(roster).toMatchObject({
            male: 1, female: 1, unknown: 0, excludedUnresolvedCount: 1,
        });
        expect(roster.unknownRate).toBe(0);
    });
});

describe('concierge batch failure diagnostics', () => {
    it('redacts credentials and bounds durable diagnostic fields', () => {
        const message = [
            'apify_api_AbC123',
            'eyJheader.payload.signature',
            'postgresql://user:password@example.test/db?secret=value',
            'https://example.test/path?token=value',
        ].join(' ');
        const diagnostic = conciergeBatchFailureDiagnostic(new Error(message), 'collect');

        expect(diagnostic.stage).toBe('collect');
        expect(diagnostic.message).not.toContain('apify_api_AbC123');
        expect(diagnostic.message).not.toContain('eyJheader.payload.signature');
        expect(diagnostic.message).not.toContain('postgresql://');
        expect(diagnostic.message).not.toContain('?token=value');
        expect(diagnostic.message.length).toBeLessThanOrEqual(500);
        expect(diagnostic.stack?.split('\n').length).toBeLessThanOrEqual(6);
        expect(sanitizeConciergeBatchDiagnostic('x'.repeat(20), 7)).toHaveLength(7);
    });

    it('records nested error causes in order from the immediate cause to the root', () => {
        const root = new Error('CONCIERGE_BATCH_COPY_INTERACTION_GROUNDING_INVALID');
        const middle = new Error('CONCIERGE_BATCH_COPY_CONTRACT_INVALID', { cause: root });
        const outer = new Error('CONCIERGE_BATCH_COPY_GENERATION_FAILED', { cause: middle });

        expect(conciergeBatchFailureDiagnostic(outer, 'publish').causes).toEqual([
            { name: 'Error', message: 'CONCIERGE_BATCH_COPY_CONTRACT_INVALID' },
            { name: 'Error', message: 'CONCIERGE_BATCH_COPY_INTERACTION_GROUNDING_INVALID' },
        ]);
    });

    it('passes the failing pipeline stage to the durable failure callback', async () => {
        let stage: string | undefined;
        const summary = await runConciergeBatch([{
            orderId: '00000000-0000-4000-8000-000000000001',
            ownerId: '00000000-0000-4000-8000-000000000002',
            targetUsername: 'target_user',
            planId: 'basic',
            cohort: 'awaiting_operator',
        }], {
            async collect() { throw new Error('CONCIERGE_COLLECTION_TEST_FAILURE'); },
            async classify() { return null; },
            async publish() { return { status: 'completed' as const }; },
            async onFailure(_order, _error, failedStage) { stage = failedStage; },
        });

        expect(summary).toMatchObject({ total: 1, completed: 0, failed: 1 });
        expect(stage).toBe('collect');
    });
});

describe('concierge existing relationship artifact resolver', () => {
    function activeScopeMembers() {
        return [
            ...Array.from({ length: 25 }, (_, index) => ({
                id: `active-${index}`,
                paidAt: '2026-08-07T00:00:00.000Z',
                currentOrderStatus: 'analysis_in_progress',
                targetUsername: `target_${index}`,
            })),
            {
                id: 'outside-before-window',
                paidAt: '2026-08-06T23:59:59.999Z',
                currentOrderStatus: 'analysis_in_progress',
                targetUsername: 'target_before',
            },
            {
                id: 'outside-excluded-target',
                paidAt: '2026-08-07T00:00:00.000Z',
                currentOrderStatus: 'analysis_in_progress',
                targetUsername: 'che.rish_0.0_',
            },
            {
                id: 'outside-completed',
                paidAt: '2026-08-07T00:00:00.000Z',
                currentOrderStatus: 'completed',
                targetUsername: 'target_completed',
            },
            {
                id: 'outside-refunded',
                paidAt: '2026-08-07T00:00:00.000Z',
                currentOrderStatus: 'refunded',
                targetUsername: 'target_refunded',
            },
            {
                id: 'outside-paid-status',
                paidAt: '2026-08-07T00:00:00.000Z',
                currentOrderStatus: 'paid',
                targetUsername: 'target_paid',
            },
        ];
    }

    it('selects exactly the audited active-25 order scope and excludes outside statuses/target', () => {
        const members = activeScopeMembers();

        expect(selectConciergeBatchActiveScope(members)).toEqual(members.slice(0, 25));
    });

    it('fails closed when the audited active scope is not exactly 25 rows', () => {
        expect(() => selectConciergeBatchActiveScope([])).toThrow('CONCIERGE_ACTIVE_SCOPE_COUNT_CONFLICT');
    });

    describe('CONCIERGE_BATCH_INCLUDE_EXCLUDED_TARGET', () => {
        function withEnv(name: string, value: string | undefined, run: () => void): void {
            const previous = process.env[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
            try {
                run();
            } finally {
                if (previous === undefined) delete process.env[name];
                else process.env[name] = previous;
            }
        }

        it('reads the flag with a default-off, explicit-true/1-only shape', () => {
            expect(conciergeBatchIncludeExcludedTargetEnabled(undefined)).toBe(false);
            expect(conciergeBatchIncludeExcludedTargetEnabled('')).toBe(false);
            expect(conciergeBatchIncludeExcludedTargetEnabled('false')).toBe(false);
            expect(conciergeBatchIncludeExcludedTargetEnabled('true')).toBe(true);
            expect(conciergeBatchIncludeExcludedTargetEnabled('1')).toBe(true);
        });

        it('on: includes che.rish_0.0_ in the selected active scope once the expected count accounts for it', () => {
            withEnv('CONCIERGE_BATCH_INCLUDE_EXCLUDED_TARGET', 'true', () => {
                withEnv('CONCIERGE_BATCH_EXPECTED_SCOPE_COUNT', '26', () => {
                    const members = activeScopeMembers();

                    const selected = selectConciergeBatchActiveScope(members);

                    expect(selected).toHaveLength(26);
                    expect(selected.some(member => member.targetUsername === 'che.rish_0.0_')).toBe(true);
                    // Every other guard (before-window/completed/refunded/paid)
                    // must stay untouched - only the target exclusion lifts.
                    expect(selected.some(member => member.targetUsername === 'target_before')).toBe(false);
                    expect(selected.some(member => member.targetUsername === 'target_completed')).toBe(false);
                    expect(selected.some(member => member.targetUsername === 'target_refunded')).toBe(false);
                    expect(selected.some(member => member.targetUsername === 'target_paid')).toBe(false);
                });
            });
        });

        it('off (unset and explicit false): excludes che.rish_0.0_ exactly as before - byte parity', () => {
            const members = activeScopeMembers();
            const baseline = selectConciergeBatchActiveScope(members);
            expect(baseline).toEqual(members.slice(0, 25));

            withEnv('CONCIERGE_BATCH_INCLUDE_EXCLUDED_TARGET', undefined, () => {
                expect(selectConciergeBatchActiveScope(members)).toEqual(baseline);
            });
            withEnv('CONCIERGE_BATCH_INCLUDE_EXCLUDED_TARGET', 'false', () => {
                expect(selectConciergeBatchActiveScope(members)).toEqual(baseline);
            });
        });
    });

    it('keeps only bounded retry codes and drops unknown or raw failure details', () => {
        expect(retryableFailureCode(new Error('CONCIERGE_PUBLICATION_RPC_FAILED')))
            .toBe('CONCIERGE_PUBLICATION_RPC_FAILED');
        expect(retryableFailureCode(new Error('CONCIERGE_BATCH_COPY_GENERATION_FAILED')))
            .toBe('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
        expect(retryableFailureCode(new Error('CONCIERGE_UNKNOWN_INTERNAL_FAILURE')))
            .toBe('CONCIERGE_BATCH_RETRYABLE');
        expect(retryableFailureCode(new Error('provider secret for user@example.com')))
            .toBe('CONCIERGE_BATCH_RETRYABLE');
    });

    it('accepts only approved callback-free resume identities', () => {
        const artifacts = parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: {
                    runId: 'Abcdef12',
                    credentialSlot: 'secondary',
                    sourceDeclaredCount: 120,
                },
                following: {
                    runId: 'Zyxwvu98',
                    credentialSlot: 'nonary',
                    sourceDeclaredCount: 80,
                },
            },
        }));

        expect(artifacts.get('target_user')).toEqual({
            followers: {
                runId: 'Abcdef12',
                credentialSlot: 'secondary',
                sourceDeclaredCount: 120,
            },
            following: {
                runId: 'Zyxwvu98',
                credentialSlot: 'nonary',
                sourceDeclaredCount: 80,
            },
        });
        expect(relationshipArtifactProviderContext(
            'request-id',
            artifacts.get('target_user')!.followers!,
            100,
        )).toMatchObject({
            requestId: 'request-id',
            resumeRunId: 'Abcdef12',
            logicalProvider: 'apify',
            actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
            credentialSlot: 'secondary',
            maxChargeUsd: 100,
            allowAdoptedRelationshipTruncation: true,
            adoptedRelationshipSourceDeclaredCount: 120,
        });
        expect(relationshipArtifactProviderContext(
            'request-id',
            artifacts.get('target_user')!.following!,
            80,
        )).toMatchObject({
            credentialSlot: 'nonary',
            allowConciergeBatchNonary: true,
        });
    });

    it('rejects an unapproved or malformed artifact identity', () => {
        expect(() => parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: {
                    runId: 'bad run id',
                    credentialSlot: 'tertiary',
                    sourceDeclaredCount: 0,
                },
            },
        }))).toThrow('CONCIERGE_BATCH_EXISTING_ARTIFACT_MAP_INVALID');
        expect(() => parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                following: {
                    runId: 'Abcdef12',
                    credentialSlot: 'octonary',
                    sourceDeclaredCount: 80,
                },
            },
        }))).toThrow('CONCIERGE_BATCH_EXISTING_ARTIFACT_MAP_INVALID');
    });

    it('falls back only for target-profile artifact lineage failures', () => {
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID'))).toBe(true);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_LOOKUP_FAILED'))).toBe(true);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_TARGET_PROFILE_PRIVATE'))).toBe(false);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID_EXTRA'))).toBe(false);
    });

    it('matches the opaque canonical actor id returned by Apify, not the actor slug', () => {
        const run = {
            id: 'Abcdef12',
            actId: 'opaqueCanonicalActorId123',
            status: 'SUCCEEDED',
            defaultDatasetId: 'dataset123',
        };

        expect(isMatchingTargetProfileArtifactRun(
            run,
            'Abcdef12',
            'opaqueCanonicalActorId123',
        )).toBe(true);
        expect(isMatchingTargetProfileArtifactRun(
            run,
            'Abcdef12',
            'apify/instagram-profile-scraper',
        )).toBe(false);
    });

    const copyEvidence = (facts: ConciergeBatchHighRiskCopyEvidence['facts']): ConciergeBatchHighRiskCopyEvidence => ({
        requestId: '00000000-0000-4000-8000-000000000001',
        targetUsername: 'target_user',
        targetFullName: '대상 이름',
        candidateUsername: 'candidate_user',
        candidateFullName: '후보 이름',
        bio: '여행과 커피를 즐기는 기록',
        captions: ['주말 여행과 커피 기록'],
        appearanceGrade: 4,
        facts,
        images: [],
    });

    it.each([
        ['강민주', '민주님'],
        ['이지훈', '지훈님'],
        ['수경', '수경님'],
        ['Alex Kim', 'Alex Kim님'],
        [null, 'candidate_user'],
        // Canary rank 9 (@imm.h_l): a full name of nothing but a braille-pattern
        // blank (U+2800) isn't caught by String#trim(), so it used to pass the
        // "has a full name" check and produce a subject-less "⠀님은 ..." line.
        ['⠀', 'candidate_user'],
        ['ㅤ', 'candidate_user'],
        ['​', 'candidate_user'],
        ['   ⠀ㅤ   ', 'candidate_user'],
        // A display name that appends a job title/affiliation after a separator
        // used to become the literal the model had to echo verbatim twice, which
        // it never did: rabbisseu_ burned six attempts on
        // CONCIERGE_BATCH_COPY_SUBJECT_GROUNDING_INVALID before the order failed.
        ['송하빈 | 청소년상담사 • 청소년지도사', '하빈님'],
        ['인정 | Travel • DJ SARAH', '인정님'],
        ['약당당 | 약사 이현정', '당당님'],
        ['Alex Kim | Photographer', 'Alex Kim님'],
        // Decoration around the name is dropped the same way.
        ['👑한채연✿ᑕᕼᗩEYEOᑎ(ᒍEᑎᑎY)', '채연님'],
        ['ʜᴇɪᴢᴇ👯혜주', '혜주님'],
        ['이쑤•スジン', '이쑤님'],
        ['Jiyoon Park  박지윤', '지윤님'],
        ['박지예 朴 志 芮', '지예님'],
        // Names that already read as a name are returned unchanged.
        ['세 연', '세 연님'],
        ['Kim Jihee', 'Kim Jihee님'],
        ['후보 이름', '후보 이름님'],
    ])('formats %s as %s', (fullName, expected) => {
        const evidence = { ...copyEvidence([]), candidateFullName: fullName };
        expect(buildConciergeBatchHighRiskCopyPrompt(evidence))
            .toContain(`후보 이름: ${expected}`);
    });

    it('falls back to unique normalized usernames when formatted subject labels collide', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: '김지민',
            candidateFullName: '이지민',
        };

        expect(buildConciergeBatchHighRiskCopyPrompt(evidence))
            .toContain('대상 이름: target_user');
        expect(buildConciergeBatchHighRiskCopyPrompt(evidence))
            .toContain('후보 이름: candidate_user');
    });

    it('states the verbatim candidate-name requirement the validator enforces', () => {
        // validateConciergeBatchHighRiskCopy requires the exact candidate label in
        // oneLineOverview and in at least one riskAnalysis sentence. That rule used
        // to appear only in the retry feedback, so every first attempt had to guess
        // it; state it in the base prompt instead.
        const prompt = buildConciergeBatchHighRiskCopyPrompt(copyEvidence([]));

        expect(prompt).toContain('oneLineOverview에 후보 이름 "후보 이름님"을(를) 글자 그대로 반드시 포함하고, riskAnalysis 두 문장 중 최소 한 문장에도 똑같이 글자 그대로 포함하세요.');
    });

    it('states the image availability and bans internal person labels in the prompt', () => {
        const prompt = buildConciergeBatchHighRiskCopyPrompt({
            ...copyEvidence([]),
            images: [],
            bio: null,
            captions: [],
            appearanceGrade: 0,
        });

        expect(prompt).toContain('후보 프로필 이미지 제공 여부: 없음');
        expect(prompt).toContain('대상 계정·후보·후보 계정 같은 내부 역할명은 쓰지 마세요.');
        expect(prompt).toContain('이미지에서 실제로 보이는 요소만 묘사하세요');
        expect(prompt).toContain('이미지가 없으면 실루엣·이목구비·얼굴·표정·헤어스타일·체형·옷차림·포즈를 만들지 마세요.');
        // The no-evidence branch must explicitly ban 사진/이미지 as literal words
        // (not just "don't fabricate visuals"), spell out the full forbidden set,
        // and give the required-signal-word list plus safe worked examples so
        // the model isn't left to guess how to phrase "no usable evidence".
        expect(prompt).toContain('사진이 없다", "이미지가 없다"처럼 사진·이미지라는 낱말 자체를 절대 쓰지 마세요.');
        expect(prompt).toContain('실루엣, 이목구비, 얼굴, 표정, 헤어스타일, 머리카락, 체형, 옷차림, 포즈, 외모, 분위기, 스타일, 사진, 이미지, 장면, 행동, 태도, 성격, 관계, 호감, 긴장, 시선, 매력');
        expect(prompt).toContain('단서, 재료, 정보, 근거, 확인, 판단, 드러난, 남겨진, 찾을, 읽을, 없다, 부족, 어렵다, 제한, 적다');
        expect(prompt).toContain('참고할 안전한 문장 예시입니다');
    });

    it('rejects visual claims when no candidate image exists', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: [],
            appearanceGrade: 0,
        };

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 선명한 이목구비와 차분한 실루엣으로 묘한 긴장감을 남깁니다.',
            riskAnalysis: [
                'candidate_user는 얼굴 표정만으로 주변 시선을 붙드는 인상을 선명하게 보여줍니다.',
                'candidate_user는 헤어스타일과 체형에서 도발적인 분위기를 자연스럽게 드러냅니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_UNOBSERVED_APPEARANCE');
    });

    it('allows visual claims when a profile image exists', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: ['profile-image'],
            appearanceGrade: 0,
        };

        expect(validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 선명한 이목구비와 차분한 실루엣으로 묘한 긴장감을 남깁니다.',
            riskAnalysis: [
                'candidate_user는 얼굴 표정만으로 주변 시선을 붙드는 인상을 선명하게 보여줍니다.',
                'candidate_user는 헤어스타일과 체형에서 도발적인 분위기를 자연스럽게 드러냅니다.',
            ],
        }, evidence)).toMatchObject({ candidateUsername: 'candidate_user' });
    });

    it('does not treat a retained placeholder image as visual evidence', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: ['placeholder-image'],
            visualEvidenceAvailable: false,
            appearanceGrade: 0,
        };

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 선명한 이목구비와 차분한 실루엣으로 묘한 긴장감을 남깁니다.',
            riskAnalysis: [
                'candidate_user는 얼굴 표정만으로 주변 시선을 붙드는 인상을 선명하게 보여줍니다.',
                'candidate_user는 헤어스타일과 체형에서 도발적인 분위기를 자연스럽게 드러냅니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_UNOBSERVED_APPEARANCE');
    });

    it('accepts varied honest copy when every evidence source is absent', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: [],
            appearanceGrade: 4,
        };

        expect(validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 현재 확인할 수 있는 유용한 단서와 판단 재료가 거의 남아 있지 않습니다.',
            riskAnalysis: [
                'candidate_user에 대해 지금 확인할 수 있는 정보와 근거가 부족해 더 읽어낼 만한 단서가 없습니다.',
                'candidate_user는 현재 남겨진 자료만으로 유용한 재료를 찾기 어려워 판단을 덧붙이지 않습니다.',
            ],
        }, evidence)).toMatchObject({ candidateUsername: 'candidate_user' });
    });

    it('accepts the exact no-evidence worked examples the prompt itself suggests', () => {
        // These mirror the safe-example sentences embedded in the no-evidence
        // prompt branch verbatim (with the candidate name substituted). If the
        // model follows the prompt's own worked examples, the response must
        // pass validation: it must hit BATCH_COPY_NO_EVIDENCE_SIGNAL and must
        // never hit BATCH_COPY_NO_EVIDENCE_FORBIDDEN.
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: [],
            appearanceGrade: 0,
        };

        expect(validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user에 대해 확인할 만한 공개 단서가 남지 않아 뚜렷한 판단을 내리기엔 정보가 부족합니다.',
            riskAnalysis: [
                '겉으로 드러난 단서가 거의 없어 candidate_user을(를) 자신 있게 짚어낼 근거를 찾기가 쉽지 않습니다.',
                '남겨진 정보가 적어 candidate_user에 대해 더 깊이 판단하기는 제한적입니다.',
            ],
        }, evidence)).toMatchObject({ candidateUsername: 'candidate_user' });
    });

    it('still rejects a no-evidence copy that leaks a banned appearance word like 이미지 or 사진', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: [],
            appearanceGrade: 0,
        };

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 이미지가 없어 확인할 단서가 부족합니다.',
            riskAnalysis: [
                'candidate_user에 대해 확인할 정보와 근거가 부족해 판단을 내리기 어렵습니다.',
                'candidate_user는 남겨진 자료가 적어 더 판단하기는 제한적입니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_NO_EVIDENCE_REQUIRED');
    });

    it('keeps the existing nonempty Zod guard for blank copy', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
        };

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: '   ',
            riskAnalysis: [
                'candidate_user의 여행과 커피 기록이 가벼운 호기심을 남깁니다.',
                'candidate_user의 공개 기록이 자연스러운 분위기를 만듭니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_SCHEMA_INVALID');
    });

    it('uses the expanded output budget only for the candidate-copy Gemini call', async () => {
        conciergeBatchTestMocks.analyzeWithGemini.mockReset();
        conciergeBatchTestMocks.analyzeWithGemini.mockResolvedValue({
            oneLineOverview: 'candidate_user의 여행과 커피 기록이 서로 다른 장면에서 자연스럽게 이어져 가벼운 호기심을 남깁니다.',
            riskAnalysis: [
                'candidate_user의 여행 장면과 커피 취향이 피드의 분위기를 가볍게 끌어당깁니다.',
                'candidate_user의 공개 기록에서 주말의 결이 은근한 긴장감을 만들어 시선을 붙잡습니다.',
            ],
        });

        await generateConciergeBatchHighRiskCopy({
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            appearanceGrade: 0,
        });

        const options = conciergeBatchTestMocks.analyzeWithGemini.mock.calls[0]?.[2];
        expect(options).toMatchObject({
            model: 'gemini-3-flash-preview',
            maxOutputTokens: 4_096,
            maxAttempts: 1,
        });
    });

    it('makes both overview and detail depend on the observed direction', async () => {
        const result = await generateConciergeBatchHighRiskCopy(
            copyEvidence([{ direction: 'candidate_to_target', kind: 'like' }]),
            async prompt => {
                expect(prompt).toContain('후보 이름님 -> 대상 이름님');
                return {
                    oneLineOverview: '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 장면이 먼저 눈에 들어와 흐름이 장난스럽게 번집니다.',
                    riskAnalysis: [
                        '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 흐름이 공개 기록의 분위기와 겹쳐 보입니다.',
                        '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 사실을 중심으로 두 사람의 장난스러운 결을 읽습니다.',
                    ],
                };
            },
        );
        expect(result.candidateUsername).toBe('candidate_user');
        expect(result.oneLineOverview).toContain('좋아요');
        expect(result.riskAnalysis).toHaveLength(2);
    });

    it('requires the overview to ground the strongest interaction while details cover each unique direction and kind', () => {
        const evidence = copyEvidence([
            { direction: 'candidate_to_target', kind: 'like' },
            { direction: 'candidate_to_target', kind: 'comment', content: '첫 번째 댓글' },
            { direction: 'candidate_to_target', kind: 'comment', content: '두 번째 댓글' },
            { direction: 'target_to_candidate', kind: 'like' },
        ]);

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 장면이 먼저 눈에 들어와 가벼운 긴장감을 남깁니다.',
            riskAnalysis: [
                '후보 이름님이 대상 이름님 게시물에 좋아요와 댓글을 남긴 흐름이 공개 기록의 결을 바꿔 보입니다.',
                '대상 이름님이 후보 이름님 게시물에 좋아요를 남긴 장면까지 이어져 두 사람의 온도를 읽게 합니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_OVERVIEW_INTERACTION_GROUNDING_INVALID');
    });

    it('deduplicates repeated raw facts by direction and kind before prompting Gemini', () => {
        const prompt = buildConciergeBatchHighRiskCopyPrompt(copyEvidence([
            { direction: 'candidate_to_target', kind: 'comment', content: '첫 번째 댓글' },
            { direction: 'candidate_to_target', kind: 'comment', content: '두 번째 댓글' },
            { direction: 'candidate_to_target', kind: 'like' },
        ]));

        expect(prompt.match(/방향=후보 이름님 -> 대상 이름님; 유형=댓글/gu)).toHaveLength(1);
        expect(prompt).toContain('첫 번째 댓글');
        expect(prompt).not.toContain('두 번째 댓글');
    });

    // Regression for the previously-unexercised wiring path: a verified-female
    // candidate whose username also appears in the collected
    // targetToCandidate (target's own posts, liked/commented on by mutuals)
    // evidence. Real production data had never produced this overlap, so the
    // machinery below (collectBatchCopyFacts -> facts -> the prompt/validator
    // contract already covered above) had no fixture proving it actually
    // fires end to end.
    function targetToCandidateEvidenceInput(
        rows: readonly {
            actorUsername: string;
            postId: string;
            signal: 'target_post_like' | 'target_post_comment';
            sourceInteractionId: string;
            content?: string;
        }[],
    ): Parameters<typeof collectBatchCopyFacts>[0] {
        return {
            replay: {
                bidirectionalInteractions: {
                    targetToCandidate: { status: 'collected', evidence: rows },
                    candidateToTarget: { status: 'not_collected', evidence: [] },
                    reverseLikeStatusByUsername: new Map(),
                },
            },
        } as unknown as Parameters<typeof collectBatchCopyFacts>[0];
    }

    it('collectBatchCopyFacts turns a collected target-post like into a grounded candidate_to_target fact', () => {
        const facts = collectBatchCopyFacts(
            targetToCandidateEvidenceInput([{
                actorUsername: 'candidate_user',
                postId: 'target-post-1',
                signal: 'target_post_like',
                sourceInteractionId: 'like-1',
            }]),
            { username: 'target_user', latestPosts: [] } as unknown as InstagramProfile,
            { username: 'candidate_user', latestPosts: [] } as unknown as InstagramProfile,
        );

        expect(facts).toEqual([{ direction: 'candidate_to_target', kind: 'like' }]);
    });

    it('collectBatchCopyFacts carries a collected target-post comment and its content', () => {
        const facts = collectBatchCopyFacts(
            targetToCandidateEvidenceInput([{
                actorUsername: 'candidate_user',
                postId: 'target-post-1',
                signal: 'target_post_comment',
                sourceInteractionId: 'comment-1',
                content: '너무 예쁘세요',
            }]),
            { username: 'target_user', latestPosts: [] } as unknown as InstagramProfile,
            { username: 'candidate_user', latestPosts: [] } as unknown as InstagramProfile,
        );

        expect(facts).toEqual([{ direction: 'candidate_to_target', kind: 'comment', content: '너무 예쁘세요' }]);
    });

    it('collectBatchCopyFacts ignores target-post evidence belonging to a different actor', () => {
        const facts = collectBatchCopyFacts(
            targetToCandidateEvidenceInput([{
                actorUsername: 'someone_else',
                postId: 'target-post-1',
                signal: 'target_post_like',
                sourceInteractionId: 'like-1',
            }]),
            { username: 'target_user', latestPosts: [] } as unknown as InstagramProfile,
            { username: 'candidate_user', latestPosts: [] } as unknown as InstagramProfile,
        );

        expect(facts).toEqual([]);
    });

    it('produces a Gemini prompt and passes validation for a verified-female candidate grounded in real collected like evidence', async () => {
        // End-to-end: real collected targetToCandidate evidence -> collectBatchCopyFacts
        // -> buildConciergeBatchHighRiskCopyPrompt -> a well-formed grounded
        // response passes validateConciergeBatchHighRiskCopy, exactly the path
        // that had never been exercised together before.
        const facts = collectBatchCopyFacts(
            targetToCandidateEvidenceInput([{
                actorUsername: 'candidate_user',
                postId: 'target-post-1',
                signal: 'target_post_like',
                sourceInteractionId: 'like-1',
            }]),
            { username: 'target_user', latestPosts: [] } as unknown as InstagramProfile,
            { username: 'candidate_user', latestPosts: [] } as unknown as InstagramProfile,
        );
        const evidence = copyEvidence(facts);

        const prompt = buildConciergeBatchHighRiskCopyPrompt(evidence);
        expect(prompt).toContain('방향=후보 이름님 -> 대상 이름님; 유형=좋아요');

        const result = validateConciergeBatchHighRiskCopy({
            oneLineOverview: '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 장면이 먼저 눈에 들어와 흐름이 장난스럽게 번집니다.',
            riskAnalysis: [
                '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 흐름이 공개 기록의 분위기와 겹쳐 보입니다.',
                '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 사실을 중심으로 두 사람의 장난스러운 결을 읽습니다.',
            ],
        }, evidence);

        expect(result.candidateUsername).toBe('candidate_user');
    });

    it('allows provocative no-interaction copy without trust-eroding wording', async () => {
        const result = await generateConciergeBatchHighRiskCopy(
            copyEvidence([]),
            async () => ({
                oneLineOverview: '후보 이름님의 여행과 커피 취향이 사진마다 은근한 신호처럼 번져 장난스러운 상상을 부릅니다.',
                riskAnalysis: [
                    '후보 이름님의 여행 기록과 커피 장면이 한 편의 가벼운 관계극처럼 이어져 시선을 잡습니다.',
                    '후보 이름님의 사진 속 분위기가 평범한 일상보다 조금 더 도발적인 여운을 남깁니다.',
                ],
            }),
        );
        const text = [result.oneLineOverview, ...result.riskAnalysis].join(' ');
        expect(text).not.toMatch(/확인되지 않았다|알 수 없다|수집 범위|공개 자료만으로는/u);
        expect(text).not.toMatch(/좋아요|댓글|태그|멘션/u);
    });

    it('does not require an exact retained-evidence term echo for no-interaction copy', () => {
        expect(validateConciergeBatchHighRiskCopy({
            oneLineOverview: '후보 이름님이 대상 이름님과 주고받은 결이 은근한 긴장감을 만들며 장난스러운 상상을 부릅니다.',
            riskAnalysis: [
                '후보 이름님과 대상 이름님의 결이 단순한 일상보다 조금 더 도발적인 관계극처럼 읽힙니다.',
                '후보 이름님은 말보다 여운으로 대상 이름님의 시선을 오래 붙잡는 인상을 남깁니다.',
            ],
        }, {
            ...copyEvidence([]),
            bio: '등산과 재즈 공연을 좋아하는 기록',
            captions: ['산길과 재즈 무대의 순간을 담은 기록'],
            appearanceGrade: 0,
            images: [],
        })).toMatchObject({ candidateUsername: 'candidate_user' });
    });

    it('rejects sparse deterministic prose and retries Gemini once', async () => {
        let attempts = 0;
        await expect(generateConciergeBatchHighRiskCopy(
            copyEvidence([]),
            async () => {
                attempts += 1;
                return {
                    oneLineOverview: '후보 이름님의 공개된 소개·캡션 문구가 비어 있어, 사진에서 이야기를 지어내지 않고 이름으로 확인되는 범위만 차분히 읽어봅니다.',
                    riskAnalysis: [
                        '후보 이름님의 공개 기록에서 사진과 소개의 결을 중심으로 장난스러운 분위기를 읽습니다.',
                        '후보 이름님의 피드에 남은 장면이 가벼운 긴장감을 만들어 시선을 붙잡습니다.',
                    ],
                };
            },
        )).rejects.toThrow('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
        expect(attempts).toBe(2);
    });

    it('keeps two copy attempts when the max-attempts env is not configured', async () => {
        const previousMaxAttempts = process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
        delete process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
        let attempts = 0;
        try {
            await expect(generateConciergeBatchHighRiskCopy(
                copyEvidence([]),
                async () => {
                    attempts += 1;
                    return { oneLineOverview: '짧음', riskAnalysis: ['짧음', '짧음'] };
                },
            )).rejects.toThrow('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
            expect(attempts).toBe(2);
        } finally {
            if (previousMaxAttempts === undefined) delete process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
            else process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = previousMaxAttempts;
        }
    });

    it('uses the configured copy max-attempts value and reports the final count', async () => {
        const previousMaxAttempts = process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = '4';
        let attempts = 0;
        try {
            await expect(generateConciergeBatchHighRiskCopy(
                copyEvidence([]),
                async () => {
                    attempts += 1;
                    return { oneLineOverview: '짧음', riskAnalysis: ['짧음', '짧음'] };
                },
            )).rejects.toThrow('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
            expect(attempts).toBe(4);
            expect(stderrSpy.mock.calls.some(([message]) => (
                typeof message === 'string' && message.includes('after 4 attempts')
            ))).toBe(true);
        } finally {
            stderrSpy.mockRestore();
            if (previousMaxAttempts === undefined) delete process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
            else process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = previousMaxAttempts;
        }
    });

    describe('CONCIERGE_BATCH_COPY_RETRY_FEEDBACK_ENABLED', () => {
        function withRetryFeedbackEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
            const previous = process.env.CONCIERGE_BATCH_COPY_RETRY_FEEDBACK_ENABLED;
            if (value === undefined) delete process.env.CONCIERGE_BATCH_COPY_RETRY_FEEDBACK_ENABLED;
            else process.env.CONCIERGE_BATCH_COPY_RETRY_FEEDBACK_ENABLED = value;
            return run().finally(() => {
                if (previous === undefined) delete process.env.CONCIERGE_BATCH_COPY_RETRY_FEEDBACK_ENABLED;
                else process.env.CONCIERGE_BATCH_COPY_RETRY_FEEDBACK_ENABLED = previous;
            });
        }

        const validCopy = {
            oneLineOverview: '후보 이름님의 여행과 커피 취향이 사진마다 은근한 신호처럼 번져 장난스러운 상상을 부릅니다.',
            riskAnalysis: [
                '후보 이름님의 여행 기록과 커피 장면이 한 편의 가벼운 관계극처럼 이어져 시선을 잡습니다.',
                '후보 이름님의 사진 속 분위기가 평범한 일상보다 조금 더 도발적인 여운을 남깁니다.',
            ],
        };

        it('reads the flag with a default-off, explicit-true/1-only shape', () => {
            expect(conciergeBatchCopyRetryFeedbackEnabled(undefined)).toBe(false);
            expect(conciergeBatchCopyRetryFeedbackEnabled('')).toBe(false);
            expect(conciergeBatchCopyRetryFeedbackEnabled('false')).toBe(false);
            expect(conciergeBatchCopyRetryFeedbackEnabled('true')).toBe(true);
            expect(conciergeBatchCopyRetryFeedbackEnabled('1')).toBe(true);
        });

        it('maps each covered contract-failure code to its correction instruction, and leaves an uncovered code/non-error unmapped', () => {
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_UNOBSERVED_INTERACTION')))
                .toBe('직전 출력이 관측되지 않은 상호작용을 언급해 실패했습니다. 이 후보는 관측된 상호작용이 전혀 없습니다. \'좋아요\',\'댓글\',\'태그\',\'멘션\'과 그 파생·유사 표현(호감 표시, 반응, 소통, 주고받은 등)을 단 한 번도 쓰지 마세요. 오직 사진에서 실제로 보이는 외모·분위기·스타일·색감·장면·포즈만으로 세 문장을 쓰고, 각 문장에 후보 이름을 넣으세요.');
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_APPEARANCE_GROUNDING_INVALID')))
                .toBe('이미지에서 실제로 보이는 요소를 사진/분위기/스타일/표정/색감/장면/포즈 같은 외모 어휘로 최소 한 번 명시하세요.');
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_OVERVIEW_INTERACTION_GROUNDING_INVALID')))
                .toBe('overview·riskAnalysis에 수집된 상호작용 방향·유형을 직접 근거로 인용하세요.');
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_INTERACTION_GROUNDING_INVALID')))
                .toBe('overview·riskAnalysis에 수집된 상호작용 방향·유형을 직접 근거로 인용하세요.');
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_SUBJECT_GROUNDING_INVALID')))
                .toBe('overview와 riskAnalysis 각각에 후보 이름을 그대로 포함하세요.');
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_UNSAFE')))
                .toBe('역할 라벨·금지 표현·숫자·공개식별자를 제거하고 다시 쓰세요.');
            expect(conciergeBatchCopyRetryFeedbackInstruction(new Error('CONCIERGE_BATCH_COPY_SCHEMA_INVALID'))).toBeNull();
            expect(conciergeBatchCopyRetryFeedbackInstruction(null)).toBeNull();
        });

        it.each([
            ['CONCIERGE_BATCH_COPY_UNOBSERVED_INTERACTION', "'좋아요','댓글','태그','멘션'과 그 파생·유사 표현"],
            ['CONCIERGE_BATCH_COPY_APPEARANCE_GROUNDING_INVALID', '외모 어휘로 최소 한 번 명시'],
            ['CONCIERGE_BATCH_COPY_SUBJECT_GROUNDING_INVALID', 'overview와 riskAnalysis 각각에 후보 이름을 그대로 포함'],
            ['CONCIERGE_BATCH_COPY_UNSAFE', '역할 라벨·금지 표현·숫자·공개식별자를 제거'],
        ])('on: appends the %s correction to the next attempt prompt, not the first', async (code, expectedSnippet) => {
            await withRetryFeedbackEnv('true', async () => {
                const prompts: string[] = [];
                const result = await generateConciergeBatchHighRiskCopy(
                    copyEvidence([]),
                    async prompt => {
                        prompts.push(prompt);
                        if (prompts.length === 1) throw new Error(code);
                        return validCopy;
                    },
                );
                expect(result.candidateUsername).toBe('candidate_user');
                expect(prompts).toHaveLength(2);
                expect(prompts[0]).not.toContain(expectedSnippet);
                expect(prompts[1]).toContain(expectedSnippet);
            });
        });

        it('on: accumulates two distinct contract failures instead of whack-a-mole - the third attempt prompt keeps both corrections', async () => {
            const previousMaxAttempts = process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
            process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = '3';
            try {
                await withRetryFeedbackEnv('true', async () => {
                    const prompts: string[] = [];
                    const result = await generateConciergeBatchHighRiskCopy(
                        copyEvidence([]),
                        async prompt => {
                            prompts.push(prompt);
                            // Mirrors the reported regression: correcting the
                            // interaction mention on attempt 2 then drops the
                            // candidate name and fails a different contract.
                            if (prompts.length === 1) throw new Error('CONCIERGE_BATCH_COPY_UNOBSERVED_INTERACTION');
                            if (prompts.length === 2) throw new Error('CONCIERGE_BATCH_COPY_SUBJECT_GROUNDING_INVALID');
                            return validCopy;
                        },
                    );
                    expect(result.candidateUsername).toBe('candidate_user');
                    expect(prompts).toHaveLength(3);
                    expect(prompts[0]).not.toContain("'좋아요','댓글','태그','멘션'과 그 파생·유사 표현");
                    expect(prompts[1]).toContain("'좋아요','댓글','태그','멘션'과 그 파생·유사 표현");
                    // Not yet observed on attempt 2's prompt (built before the
                    // SUBJECT_GROUNDING_INVALID failure happened).
                    expect(prompts[1]).not.toContain('overview와 riskAnalysis 각각에 후보 이름을 그대로 포함하세요');
                    // Attempt 3 must retain BOTH corrections cumulatively.
                    expect(prompts[2]).toContain("'좋아요','댓글','태그','멘션'과 그 파생·유사 표현");
                    expect(prompts[2]).toContain('overview와 riskAnalysis 각각에 후보 이름을 그대로 포함하세요');
                });
            } finally {
                if (previousMaxAttempts === undefined) delete process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
                else process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = previousMaxAttempts;
            }
        });

        it('on: always includes the candidate-name/no-unobserved-interaction common reminder alongside any specific correction', async () => {
            await withRetryFeedbackEnv('true', async () => {
                const prompts: string[] = [];
                await generateConciergeBatchHighRiskCopy(
                    copyEvidence([]),
                    async prompt => {
                        prompts.push(prompt);
                        if (prompts.length === 1) throw new Error('CONCIERGE_BATCH_COPY_UNSAFE');
                        return validCopy;
                    },
                );
                expect(prompts).toHaveLength(2);
                expect(prompts[1]).toContain(
                    'overview와 riskAnalysis 각각에 후보 이름을 그대로 포함하고, 관측되지 않은 상호작용은 언급하지 마세요.',
                );
            });
        });

        it('off (default): the retry prompt is byte-identical to the first attempt even after two distinct covered contract failures', async () => {
            const previousMaxAttempts = process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
            process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = '3';
            try {
                await withRetryFeedbackEnv(undefined, async () => {
                    const prompts: string[] = [];
                    await generateConciergeBatchHighRiskCopy(
                        copyEvidence([]),
                        async prompt => {
                            prompts.push(prompt);
                            if (prompts.length === 1) throw new Error('CONCIERGE_BATCH_COPY_UNOBSERVED_INTERACTION');
                            if (prompts.length === 2) throw new Error('CONCIERGE_BATCH_COPY_SUBJECT_GROUNDING_INVALID');
                            return validCopy;
                        },
                    );
                    expect(prompts).toHaveLength(3);
                    expect(prompts[1]).toBe(prompts[0]);
                    expect(prompts[2]).toBe(prompts[0]);
                    expect(prompts[0]).toBe(buildConciergeBatchHighRiskCopyPrompt(copyEvidence([])));
                });
            } finally {
                if (previousMaxAttempts === undefined) delete process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS;
                else process.env.CONCIERGE_BATCH_COPY_MAX_ATTEMPTS = previousMaxAttempts;
            }
        });
    });

    it('retries a cross-candidate template once and rejects it when it repeats', async () => {
        const first = copyEvidence([]);
        const second = {
            ...first,
            candidateUsername: 'second_candidate',
            candidateFullName: '두번째 이름',
        };
        let attempts = 0;
        const template = (candidate: string) => ({
            oneLineOverview: `${candidate}부터 대상 이름님까지 여행과 커피 기록이 사진마다 같은 결로 이어집니다.`,
            riskAnalysis: [
                `${candidate}부터 대상 이름님까지 여행과 커피 기록이 가벼운 긴장감을 만듭니다.`,
                `${candidate}부터 대상 이름님까지 여행과 커피 기록을 장난스럽게 읽습니다.`,
            ],
        });
        await expect(generateConciergeBatchCandidateCopies(
            [first, second],
            async prompt => {
                attempts += 1;
                return template(prompt.includes('두번째 이름') ? '두번째 이름님' : '후보 이름님');
            },
        )).rejects.toThrow('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
        expect(attempts).toBe(3);
    });

    it('accepts distinct Gemini copy for every candidate in one batch', async () => {
        const first = copyEvidence([]);
        const second = {
            ...first,
            candidateUsername: 'second_candidate',
            candidateFullName: '두번째 이름',
            bio: '산책과 음악을 즐기는 기록',
        };
        let calls = 0;
        const copies = await generateConciergeBatchCandidateCopies(
            [first, second],
            async prompt => {
                calls += 1;
                if (prompt.includes('두번째 이름')) {
                    return {
                        oneLineOverview: '두번째 이름님의 산책과 음악 기록이 사진마다 다른 리듬으로 이어져 자연스러운 호기심을 남깁니다.',
                        riskAnalysis: [
                            '두번째 이름님의 산책 장면과 음악 취향이 피드의 분위기를 가볍게 끌어당깁니다.',
                            '두번째 이름님의 기록에서 일상과 취향이 섞인 결이 은근한 긴장감을 만듭니다.',
                        ],
                    };
                }
                return {
                    oneLineOverview: '후보 이름님의 여행과 커피 기록이 사진마다 다른 온도로 이어져 장난스러운 호기심을 남깁니다.',
                    riskAnalysis: [
                        '후보 이름님의 여행 장면과 커피 취향이 피드의 분위기를 가볍게 끌어당깁니다.',
                        '후보 이름님의 기록에서 주말의 결이 은근한 긴장감을 만들어 시선을 붙잡습니다.',
                    ],
                };
            },
        );
        expect(calls).toBe(2);
        expect(copies).toHaveLength(2);
        expect(new Set(copies.map(copy => copy.oneLineOverview)).size).toBe(2);
    });

    it('keeps an order retryable after the second copy contract failure', async () => {
        let attempts = 0;
        let publicationCalls = 0;
        let failureCode: string | null = null;
        const summary = await runConciergeBatch([
            {
                orderId: '00000000-0000-4000-8000-000000000002',
                ownerId: '00000000-0000-4000-8000-000000000003',
                targetUsername: 'target_user',
                planId: 'basic',
                cohort: 'awaiting_operator',
            },
        ], {
            async collect() { return null; },
            async classify() { return null; },
            async publish() {
                await generateConciergeBatchHighRiskCopy(
                    copyEvidence([{ direction: 'candidate_to_target', kind: 'comment' }]),
                    async () => {
                        attempts += 1;
                        return { oneLineOverview: '짧음', riskAnalysis: ['짧음', '짧음'] };
                    },
                );
                publicationCalls += 1;
                return { status: 'completed' as const };
            },
            async onFailure(_order, error) {
                failureCode = error instanceof Error ? error.message : null;
            },
        });
        expect(attempts).toBe(2);
        expect(publicationCalls).toBe(0);
        expect(summary).toMatchObject({ total: 1, completed: 0, failed: 1, running: 0 });
        expect(failureCode).toBe('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
    });
});
