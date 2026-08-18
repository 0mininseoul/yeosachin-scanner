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
    collectOrder,
    conciergeBatchFailureDiagnostic,
    generateConciergeBatchCandidateCopies,
    generateConciergeBatchHighRiskCopy,
    hydrateConciergeProfilesFromPack,
    isRecoverableTargetProfileArtifactError,
    isMatchingTargetProfileArtifactRun,
    loadConciergeProfilePack,
    parseConciergeProfilePack,
    parseConciergeExistingRelationshipArtifacts,
    relationshipArtifactProviderContext,
    retryableFailureCode,
    sanitizeConciergeBatchDiagnostic,
    selectConciergeBatchOnlyOrders,
    selectConciergeBatchActiveScope,
    type ConciergeBatchHighRiskCopyEvidence,
    validateConciergeBatchHighRiskCopy,
} from './run-concierge-batch';
import { runConciergeBatch, type ConciergeBatchStageContext } from '@/lib/services/analysis/concierge-batch-runner';

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
    it('selects exactly the audited active-25 order scope and excludes outside statuses/target', () => {
        const members = [
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

        expect(selectConciergeBatchActiveScope(members)).toEqual(members.slice(0, 25));
    });

    it('fails closed when the audited active scope is not exactly 25 rows', () => {
        expect(() => selectConciergeBatchActiveScope([])).toThrow('CONCIERGE_ACTIVE_SCOPE_COUNT_CONFLICT');
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
        expect(prompt).toContain('유용한 단서가 없었다는 내용만 쓰세요.');
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
