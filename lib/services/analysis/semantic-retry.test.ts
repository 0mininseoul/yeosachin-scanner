import { describe, expect, it, vi } from 'vitest';
import {
    analysisSemanticRetryStateKey,
    incrementAnalysisSemanticRetry,
    type SemanticRetryRpcClient,
} from './semantic-retry';

function rpcClient(data: unknown, error: { code?: string } | null = null) {
    const rpc = vi.fn().mockResolvedValue({ data, error });
    return { client: { rpc } as SemanticRetryRpcClient, rpc };
}

describe('analysis semantic retry state', () => {
    it('separates every collect checkpoint without including collected values', () => {
        const initial = analysisSemanticRetryStateKey('collect');
        const profileComplete = analysisSemanticRetryStateKey('collect', {
            targetProfileCheckpoint: {
                profilePicUrl: 'https://example.test/private-value.jpg',
                followersCount: 123,
                followingCount: 456,
                isPrivate: false,
                targetPosts: [],
            },
        });
        const followersComplete = analysisSemanticRetryStateKey('collect', {
            relationshipCheckpoint: {
                followers: [{
                    username: 'private.username',
                    isPrivate: false,
                    isVerified: false,
                }],
            },
        });
        const bothRelationshipsComplete = analysisSemanticRetryStateKey('collect', {
            relationshipCheckpoint: { followers: [], following: [] },
        });

        expect(initial).toBe('v1:collect:p=0:f=0:g=0');
        expect(profileComplete).toBe('v1:collect:p=1:f=0:g=0');
        expect(followersComplete).toBe('v1:collect:p=0:f=1:g=0');
        expect(bothRelationshipsComplete).toBe('v1:collect:p=0:f=1:g=1');
        expect([initial, profileComplete, followersComplete].join(' '))
            .not.toContain('private');
    });

    it('uses only bounded cursors and enumerated stages for batch steps', () => {
        expect(analysisSemanticRetryStateKey('profiles', { profileBatchIndex: 7 }))
            .toBe('v1:profiles:b=7');
        expect(analysisSemanticRetryStateKey('analyze', { analyzeBatchIndex: 3 }))
            .toBe('v1:analyze:b=3');
        expect(analysisSemanticRetryStateKey('interactions', {
            interactionStage: 'candidates',
            interactionCandidateBatchIndex: 2,
        })).toBe('v1:interactions:s=candidates:b=2');
        expect(analysisSemanticRetryStateKey('deep_analysis', {
            deepAnalysisStage: 'complete',
        })).toBe('v1:deep_analysis:s=complete');
        expect(analysisSemanticRetryStateKey('profiles', {
            profileBatchIndex: Number.MAX_SAFE_INTEGER,
        })).toBe('v1:profiles:b=0');
    });

    it('calls the atomic RPC and accepts a bounded count', async () => {
        const { client, rpc } = rpcClient(2);
        await expect(incrementAnalysisSemanticRetry(client, {
            requestId: '00000000-0000-4000-8000-000000000001',
            userId: '00000000-0000-4000-8000-000000000002',
            expectedStep: 'profiles',
            stateKey: 'v1:profiles:b=4',
        })).resolves.toBe(2);
        expect(rpc).toHaveBeenCalledWith('increment_analysis_semantic_retry', {
            p_request_id: '00000000-0000-4000-8000-000000000001',
            p_user_id: '00000000-0000-4000-8000-000000000002',
            p_expected_step: 'profiles',
            p_state_key: 'v1:profiles:b=4',
        });
    });

    it('returns null for a stale state CAS miss', async () => {
        const { client } = rpcClient(null);
        await expect(incrementAnalysisSemanticRetry(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            stateKey: 'v1:collect:p=0:f=0:g=0',
        })).resolves.toBeNull();
    });

    it('rejects malformed keys, counts, and sanitized RPC errors', async () => {
        const invalidKey = rpcClient(1);
        await expect(incrementAnalysisSemanticRetry(invalidKey.client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'profiles',
            stateKey: 'v1:profiles:b=4:username=secret.user',
        })).rejects.toThrow('invalid semantic state key');
        expect(invalidKey.rpc).not.toHaveBeenCalled();

        const invalidCount = rpcClient(1001);
        await expect(incrementAnalysisSemanticRetry(invalidCount.client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'finalize',
            stateKey: 'v1:finalize',
        })).rejects.toThrow('returned invalid data');

        const failed = rpcClient(null, { code: '<private error>' });
        await expect(incrementAnalysisSemanticRetry(failed.client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'pending',
            stateKey: 'v1:pending',
        })).rejects.toThrow('(unknown)');
    });
});
