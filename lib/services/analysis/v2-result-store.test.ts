import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_RESULT_DATABASE_NAMES,
    AnalysisV2ResultConflictError,
    AnalysisV2ResultFenceError,
    AnalysisV2ResultNotReadyError,
    createSupabaseAnalysisV2ResultStore,
    paginateAnalysisV2FinalizedSnapshot,
    type AnalysisV2ProfileClassificationRow,
    type AnalysisV2ResultJobClaim,
    type AnalysisV2ResultSupabaseClient,
} from './v2-result-store';
import { RISK_POLICY_VERSION } from '@/lib/domain/analysis/risk-policy';
import { buildSafeFallbackRiskNarrative } from './narrative-privacy';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '123e4567-e89b-42d3-a456-426614174001';
const claimToken = '123e4567-e89b-42d3-a456-426614174002';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const rawImageUrl = 'https://SContent.cdninstagram.com/avatar.jpg?z=2&utm_source=test&a=1#fragment';
const canonicalImageUrl = 'https://scontent.cdninstagram.com/avatar.jpg?a=1&z=2';

function claim(jobKey = 'track:profile-ai:batch:0'): AnalysisV2ResultJobClaim {
    return { requestId, jobKey, claimToken, jobInputHash: hashA };
}

function manifest(jobKey = 'track:profile-ai:batch:0', batch: number | null = 0) {
    return {
        requestId,
        jobKey,
        batch,
        itemCount: 1,
        rowCount: 1,
        resultHash: hashB,
    };
}

function rpcClient(...responses: Array<{
    data: unknown;
    error: null | { code?: string; message?: string };
}>) {
    const rpc = vi.fn<(name: string, params: Record<string, unknown>) => Promise<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>>(async () => responses.shift() ?? { data: null, error: null });
    return { rpc, client: { rpc } as AnalysisV2ResultSupabaseClient };
}

function mediaContext() {
    return {
        bundleId: `bundle:${hashA}`,
        selectionIds: ['profile:candidate'],
        triageAnalyzedSelectionIds: ['profile:candidate'],
        featureAnalyzedSelectionIds: ['profile:candidate'],
        captions: [{
            evidenceRefId: 'caption:post-1',
            selectionId: 'profile:candidate',
            text: 'caption',
        }],
        posts: [{
            postId: 'post-1',
            taggedUsers: ['tagged.user'],
            mentionedUsers: ['mentioned.user'],
        }],
    } as const;
}

function terminalRow(
    classification: AnalysisV2ProfileClassificationRow['classification'],
    index: number
): AnalysisV2ProfileClassificationRow {
    const unavailable = classification === 'unavailable' || classification === 'media_unavailable';
    const requiresFeature = classification === 'verified_female'
        || classification === 'unresolved'
        || classification === 'unresolved_stage_conflict';
    return {
        candidateId: `candidate-${index}`,
        instagramId: `candidate.${index}`,
        fullName: null,
        profileImageUrl: index === 0 ? rawImageUrl : null,
        bio: null,
        classification,
        mediaContext: unavailable ? null : mediaContext(),
        genderOperationKey: unavailable ? null : `gender-triage:${hashA}`,
        genderResultHash: unavailable ? null : hashB,
        featureOperationKey: requiresFeature ? `feature-analysis:${hashB}` : null,
        featureResultHash: requiresFeature ? hashC : null,
        feature: classification === 'verified_female' ? {
            appearanceGrade: 3,
            exposureScore: 2,
            isBusinessAccount: false,
            featurePartnerEvidenceStrong: false,
            oneLineOverview: '사진 구성이 차분한 공개 계정으로 보여요',
        } : null,
    };
}

function coverage(count: number) {
    return {
        declared: count,
        collected: count,
        coverageRatio: 1,
        meetsCoverageGate: true,
        exactCountMatch: true,
    };
}

function rawSummary(count = 0) {
    return {
        targetInstagramId: 'target.account',
        targetProfileImageUrl: rawImageUrl,
        planId: 'basic',
        followers: coverage(count),
        following: coverage(count),
        detectedMutuals: count,
        publicMutuals: count,
        privateMutuals: 0,
        screenedMutuals: count,
        genderStats: { male: 0, female: count, unknown: 0 },
        successfullyScreenedMutuals: count,
        fetchUnavailableMutuals: 0,
        mediaUnavailableMutuals: 0,
        analysisUnavailableMutuals: 0,
        notScreenedMutuals: 0,
        exclusionApplied: true,
        scorePolicyVersion: RISK_POLICY_VERSION,
    };
}

function rawFemaleRow(index: number) {
    return {
        instagramId: `woman.${index}`,
        fullName: null,
        profileImageUrl: rawImageUrl,
        bio: null,
        displayScore: 2,
        riskBand: 'normal',
        featuredRank: null,
        recentMutualRank: null,
        analysisDepth: 'features',
        oneLineOverview: '차분한 사진을 올리는 공개 계정으로 보여요',
        highRiskNarrative: null,
    };
}

function rawSnapshot(count = 3) {
    return {
        requestId,
        summary: rawSummary(count),
        femaleAccounts: Array.from({ length: count }, (_, index) => ({
            candidateId: `candidate-${index + 1}`,
            sortOrdinal: index + 1,
            row: rawFemaleRow(index + 1),
        })),
        privateAccounts: [],
    };
}

describe('analysis V2 result checkpoint store', () => {
    it('persists every requested terminal profile classification in one complete batch', async () => {
        const classifications = [
            'verified_female',
            'verified_non_female',
            'unresolved',
            'unresolved_stage_conflict',
            'media_unavailable',
            'unavailable',
        ] as const;
        const rows = classifications.map(terminalRow).reverse();
        const fake = rpcClient({
            data: { ...manifest(), itemCount: rows.length, rowCount: rows.length },
            error: null,
        });
        const store = createSupabaseAnalysisV2ResultStore(fake.client);

        await expect(store.checkpointFeatureBatch({
            ...claim(), batch: 0, analyzedCount: rows.length, rows,
        })).resolves.toMatchObject({ itemCount: 6, rowCount: 6 });

        const [rpcName, params] = fake.rpc.mock.calls[0]!;
        expect(rpcName).toBe(ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointFeatureRpc);
        expect((params.p_rows as AnalysisV2ProfileClassificationRow[])
            .map(row => row.candidateId)).toEqual([
            'candidate-0', 'candidate-1', 'candidate-2',
            'candidate-3', 'candidate-4', 'candidate-5',
        ]);
        expect((params.p_rows as AnalysisV2ProfileClassificationRow[])[0]!.profileImageUrl)
            .toBe(canonicalImageUrl);
    });

    it('rejects duplicate candidates, incomplete batches, and malformed terminal payloads', async () => {
        const fake = rpcClient();
        const store = createSupabaseAnalysisV2ResultStore(fake.client);
        const row = terminalRow('verified_female', 1);

        await expect(store.checkpointFeatureBatch({
            ...claim(), batch: 0, analyzedCount: 2, rows: [row, row],
        })).rejects.toThrow('duplicate candidate id');
        await expect(store.checkpointFeatureBatch({
            ...claim(), batch: 0, analyzedCount: 2, rows: [row],
        })).rejects.toThrow('feature batch is incomplete');
        await expect(store.checkpointFeatureBatch({
            ...claim(), batch: 0, analyzedCount: 1,
            rows: [{ ...terminalRow('media_unavailable', 2), mediaContext: mediaContext() }],
        })).rejects.toThrow();
        expect(fake.rpc).not.toHaveBeenCalled();
    });

    it('checkpoints distinct preliminary, reverse, partner, final, private, and narrative stages', async () => {
        const responses = Array.from({ length: 6 }, () => ({
            data: manifest('track:score', null), error: null,
        }));
        const fake = rpcClient(...responses);
        const store = createSupabaseAnalysisV2ResultStore(fake.client);
        const scoreComponents = {
            candidateToTargetLikes: 0,
            candidateToTargetComments: 0,
            targetToCandidateLike: 0,
            tagOrCaptionMention: 0,
            recentMutual: 0,
            appearanceExposure: 0,
        };

        await store.checkpointPreliminaryScores({
            ...claim('track:score'),
            rows: [{
                candidateId: 'candidate-1', components: scoreComponents,
                preScore: 0, possibleUpperBound: 3,
                recentMutualRank: null, verificationShortlistRank: null,
            }],
        });
        await store.checkpointReverseLikes({
            ...claim('track:score'),
            rows: [{
                candidateId: 'candidate-1', status: 'observed',
                componentScore: 3, evidenceRefIds: ['like:post-1'],
            }],
        });
        await store.checkpointPartnerSafety({
            ...claim('track:score'),
            rows: [{
                candidateId: 'candidate-1', source: 'feature_only',
                hasStrongPartnerEvidence: false, hasWeakPartnerEvidence: false,
                strongEvidenceBasis: 'none',
                evidenceSelectionIds: [], bundleId: null,
                operationKey: null, aiResultHash: null,
            }],
        });
        await store.checkpointScores({
            ...claim('track:score'),
            rows: [{
                candidateId: 'candidate-1', displayScore: 1, riskBand: 'normal',
                featuredRank: null, recentMutualRank: null,
                verificationShortlistRank: null,
                partnerSafetySource: 'not_collected',
                partnerSafetyOperationKey: null, partnerSafetyResultHash: null,
                components: scoreComponents, weakPartnerAdjustment: 0,
                preScore: 0, rawScore: 0,
                possibleUpperBound: 3, publicScore: 1,
                possibleUpperPublicScore: 1.3, partnerCapApplied: false,
                partnerEvidenceSelectionIds: [],
            }],
        });
        await store.checkpointPrivateNames({
            ...claim('track:score'), batch: 0, source: 'checkpoint',
            operationKey: `private-account-name:${hashA}`, aiResultHash: hashB,
            rows: [{
                candidateId: 'private-1', instagramId: 'private.account',
                fullName: null, profileImageUrl: null,
                nameFemaleScore: 0.8, nameIsName: true, nameConfidence: 0.9,
            }],
        });
        await store.checkpointNarratives({
            ...claim('track:score'),
            rows: [{
                candidateId: 'candidate-1',
                lines: buildSafeFallbackRiskNarrative({
                    candidateLikedTarget: true,
                    candidateCommentedOnTarget: false,
                    targetLikedCandidate: false,
                }),
                source: 'checkpoint',
                operationKey: `high-risk-narrative:${hashA}`,
                aiResultHash: hashB,
            }],
        });

        expect(fake.rpc.mock.calls.map(call => call[0])).toEqual([
            ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointPreliminaryRpc,
            ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointReverseRpc,
            ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointPartnerRpc,
            ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointScoreRpc,
            ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointPrivateRpc,
            ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointNarrativeRpc,
        ]);
        expect(fake.rpc.mock.calls[3]![1].p_risk_policy_version).toBe(RISK_POLICY_VERSION);
        expect(fake.rpc.mock.calls[5]![1].p_rows).toEqual([expect.objectContaining({
            source: 'checkpoint',
            operationKey: `high-risk-narrative:${hashA}`,
            aiResultHash: hashB,
        })]);
    });

    it.each([
        ['ANALYSIS_V2_RESULT_FENCE_MISMATCH', AnalysisV2ResultFenceError],
        ['ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', AnalysisV2ResultFenceError],
        ['ANALYSIS_V2_RESULT_CONFLICT', AnalysisV2ResultConflictError],
        ['ANALYSIS_V2_FINALIZE_CONFLICT', AnalysisV2ResultConflictError],
        ['ANALYSIS_V2_RESULT_NOT_READY', AnalysisV2ResultNotReadyError],
        ['ANALYSIS_V2_FINALIZE_NOT_READY', AnalysisV2ResultNotReadyError],
    ])('maps %s to a stable domain error', async (message, ErrorType) => {
        const fake = rpcClient({ data: null, error: { code: 'P0001', message } });
        const store = createSupabaseAnalysisV2ResultStore(fake.client);
        await expect(store.checkpointPreliminaryScores({
            ...claim('track:score'), rows: [],
        })).rejects.toBeInstanceOf(ErrorType);
    });

    it('preserves uncertainty when reverse likes could not be collected for a shortlist row', async () => {
        const fake = rpcClient({ data: manifest('coordinator:join:final-score', null), error: null });
        const store = createSupabaseAnalysisV2ResultStore(fake.client);
        await expect(store.checkpointScores({
            ...claim('coordinator:join:final-score'),
            rows: [{
                candidateId: 'candidate-1', displayScore: 1, riskBand: 'normal',
                featuredRank: null, recentMutualRank: null,
                verificationShortlistRank: 1,
                partnerSafetySource: 'not_collected',
                partnerSafetyOperationKey: null, partnerSafetyResultHash: null,
                components: {
                    candidateToTargetLikes: 0, candidateToTargetComments: 0,
                    targetToCandidateLike: 0, tagOrCaptionMention: 0,
                    recentMutual: 0, appearanceExposure: 0,
                },
                weakPartnerAdjustment: 0,
                preScore: 0, rawScore: 0, possibleUpperBound: 3,
                publicScore: 1, possibleUpperPublicScore: 1.3,
                partnerCapApplied: false, partnerEvidenceSelectionIds: [],
            }],
        })).resolves.toMatchObject({ rowCount: 1 });
    });
});

describe('analysis V2 result finalization and loading', () => {
    it('canonicalizes the target URL and fresh-signs the finalization summary', async () => {
        const fake = rpcClient({
            data: { finalized: true, requestStatus: 'completed', summary: rawSummary() },
            error: null,
        });
        const signer = vi.fn((url: string | null) => url ? '/api/image-proxy?signed=1' : null);
        const store = createSupabaseAnalysisV2ResultStore(fake.client, { imageProxySigner: signer });

        await expect(store.finalize({
            ...claim('coordinator:finalize'), targetProfileImageUrl: rawImageUrl,
        })).resolves.toMatchObject({
            finalized: true,
            requestStatus: 'completed',
            summary: { targetProfileImage: '/api/image-proxy?signed=1' },
        });
        expect(fake.rpc.mock.calls[0]![1].p_target_profile_image_url).toBe(canonicalImageUrl);
        expect(signer).toHaveBeenCalledWith(canonicalImageUrl, {
            requestId,
            kind: 'target',
            candidateId: null,
        });
    });

    it('returns a compact opaque result image path even when the stored CDN URL is long', async () => {
        const previousSecret = process.env.IMAGE_PROXY_SIGNING_SECRET;
        process.env.IMAGE_PROXY_SIGNING_SECRET = 'result-image-secret-that-is-longer-than-thirty-two-characters';
        const longImageUrl = `https://cdninstagram.com/avatar.jpg?sig=${'a'.repeat(7_900)}`;
        const fake = rpcClient({
            data: {
                finalized: true,
                requestStatus: 'completed',
                summary: { ...rawSummary(), targetProfileImageUrl: longImageUrl },
            },
            error: null,
        });
        const store = createSupabaseAnalysisV2ResultStore(fake.client);

        try {
            const finalized = await store.finalize({
                ...claim('coordinator:finalize'),
                targetProfileImageUrl: longImageUrl,
            });
            const path = finalized.summary.targetProfileImage!;
            expect(path.length).toBeLessThan(512);
            expect(path).not.toContain('cdninstagram.com');
            expect(path).not.toContain('sig=');
        } finally {
            if (previousSecret === undefined) {
                delete process.env.IMAGE_PROXY_SIGNING_SECRET;
            } else {
                process.env.IMAGE_PROXY_SIGNING_SECRET = previousSecret;
            }
        }
    });

    it('loads only owner-scoped snapshots and signs every raw image on every read', async () => {
        const snapshot = rawSnapshot(2);
        const fake = rpcClient(
            { data: snapshot, error: null },
            { data: snapshot, error: null }
        );
        let signature = 0;
        const store = createSupabaseAnalysisV2ResultStore(fake.client, {
            imageProxySigner: url => url
                ? `/api/image-proxy?signature=${++signature}`
                : null,
        });

        const first = await store.loadSnapshot({ requestId, userId });
        const second = await store.loadSnapshot({ requestId, userId });

        expect(fake.rpc).toHaveBeenNthCalledWith(1, ANALYSIS_V2_RESULT_DATABASE_NAMES.loadRpc, {
            p_request_id: requestId,
            p_user_id: userId,
        });
        expect(first?.summary.targetProfileImage).toBe('/api/image-proxy?signature=3');
        expect(first?.femaleAccounts.map(entry => entry.row.profileImage)).toEqual([
            '/api/image-proxy?signature=1', '/api/image-proxy?signature=2',
        ]);
        expect(first?.summary.genderStats).toEqual({
            male: 0,
            female: 2,
            unknown: 0,
        });
        expect(second?.summary.targetProfileImage).toBe('/api/image-proxy?signature=6');
        expect(JSON.stringify(first)).not.toContain('cdninstagram.com');
    });

    it('normalizes a pre-migration summary while keeping the public contract complete', async () => {
        const snapshot = rawSnapshot(2);
        const legacySummary: Partial<typeof snapshot.summary> = { ...snapshot.summary };
        delete legacySummary.genderStats;
        const fake = rpcClient({
            data: { ...snapshot, summary: legacySummary },
            error: null,
        });
        const store = createSupabaseAnalysisV2ResultStore(fake.client, {
            imageProxySigner: () => '/api/image-proxy?signed=1',
        });

        await expect(store.loadSnapshot({ requestId, userId })).resolves.toMatchObject({
            summary: {
                genderStats: { male: 0, female: 0, unknown: 2 },
            },
        });
    });

    it('rejects unbounded or structurally invalid database snapshots', async () => {
        const invalid = { ...rawSnapshot(1), unexpected: true };
        const fake = rpcClient({ data: invalid, error: null });
        const store = createSupabaseAnalysisV2ResultStore(fake.client, {
            imageProxySigner: () => '/api/image-proxy?signed=1',
        });
        await expect(store.loadSnapshot({ requestId, userId }))
            .rejects.toThrow('invalid result snapshot');
    });

    it('paginates both result lists without duplicates and rejects a cross-list cursor', async () => {
        const fake = rpcClient({ data: rawSnapshot(3), error: null });
        const store = createSupabaseAnalysisV2ResultStore(fake.client, {
            imageProxySigner: () => '/api/image-proxy?signed=1',
        });
        const snapshot = await store.loadSnapshot({ requestId, userId });
        expect(snapshot).not.toBeNull();

        const first = paginateAnalysisV2FinalizedSnapshot({ snapshot: snapshot!, pageSize: 2 });
        const second = paginateAnalysisV2FinalizedSnapshot({
            snapshot: snapshot!, pageSize: 2, femaleCursor: first.femaleNextCursor,
        });
        expect(first.femaleAccounts.map(row => row.instagramId)).toEqual(['woman.1', 'woman.2']);
        expect(second.femaleAccounts.map(row => row.instagramId)).toEqual(['woman.3']);
        expect(new Set([...first.femaleAccounts, ...second.femaleAccounts]
            .map(row => row.instagramId)).size).toBe(3);
        expect(() => paginateAnalysisV2FinalizedSnapshot({
            snapshot: snapshot!, privateCursor: first.femaleNextCursor,
        })).toThrow('CURSOR_SCOPE_MISMATCH');
    });

    it('uses bounded owner-scoped keyset RPC pages instead of loading the full result', async () => {
        const firstDatabasePage = rawSnapshot(3);
        const fake = rpcClient({ data: firstDatabasePage, error: null });
        const store = createSupabaseAnalysisV2ResultStore(fake.client, {
            imageProxySigner: () => '/api/image-proxy?signed=1',
        });

        const first = await store.loadPage({ requestId, userId, pageSize: 2 });

        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_RESULT_DATABASE_NAMES.loadPageRpc,
            {
                p_request_id: requestId,
                p_user_id: userId,
                p_female_after_ordinal: null,
                p_female_after_candidate_id: null,
                p_private_after_ordinal: null,
                p_private_after_candidate_id: null,
                p_page_size: 2,
            }
        );
        expect(first?.femaleAccounts.map(row => row.instagramId)).toEqual([
            'woman.1', 'woman.2',
        ]);
        expect(first?.femaleNextCursor).not.toBeNull();

        const secondDatabasePage = {
            ...rawSnapshot(3),
            femaleAccounts: [rawSnapshot(3).femaleAccounts[2]],
        };
        const secondFake = rpcClient({ data: secondDatabasePage, error: null });
        const secondStore = createSupabaseAnalysisV2ResultStore(secondFake.client, {
            imageProxySigner: () => '/api/image-proxy?signed=1',
        });
        const second = await secondStore.loadPage({
            requestId,
            userId,
            pageSize: 2,
            femaleCursor: first!.femaleNextCursor,
        });
        expect(secondFake.rpc.mock.calls[0]![1]).toMatchObject({
            p_female_after_ordinal: 2,
            p_female_after_candidate_id: 'candidate-2',
        });
        expect(second?.femaleAccounts.map(row => row.instagramId)).toEqual(['woman.3']);
        expect(second?.femaleNextCursor).toBeNull();
    });

    it('fails from any exact live job claim without a finalizer-only restriction', async () => {
        const fake = rpcClient({
            data: { finalized: true, requestStatus: 'failed' }, error: null,
        });
        const store = createSupabaseAnalysisV2ResultStore(fake.client);

        await expect(store.fail({
            ...claim('track:interaction:target'), errorCode: 'ANALYSIS_FAILED',
        })).resolves.toEqual({ finalized: true, requestStatus: 'failed' });
        expect(fake.rpc).toHaveBeenCalledWith(ANALYSIS_V2_RESULT_DATABASE_NAMES.failRpc, {
            p_request_id: requestId,
            p_job_key: 'track:interaction:target',
            p_claim_token: claimToken,
            p_job_input_hash: hashA,
            p_error_code: 'ANALYSIS_FAILED',
        });
    });
});
