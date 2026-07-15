import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_COLLECTION_CONTEXT_DATABASE_NAMES,
    AnalysisV2CollectionContextFenceError,
    createAnalysisV2CollectionRequestContextStore,
    type AnalysisV2CollectionRequestContextSupabaseClient,
} from './v2-request-context';

// gitleaks:allow -- deterministic UUID fixtures
const requestId = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
// gitleaks:allow -- deterministic UUID fixtures
const claimToken = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
const jobInputHash = 'a'.repeat(64);

function client(data: unknown, error: null | { code?: string; message?: string } = null) {
    const rpc = vi.fn(async () => ({ data, error }));
    return { rpc, value: { rpc } as AnalysisV2CollectionRequestContextSupabaseClient };
}

describe('analysis V2 collection request context', () => {
    it('loads the exact immutable plan and preflight count snapshot under the live claim', async () => {
        const fake = client({
            requestId,
            targetUsername: 'target',
            excludedUsername: 'girlfriend',
            accessMode: 'production',
            providerExecutionPolicy: null,
            planId: 'standard',
            followersDeclaredCount: 799,
            followingDeclaredCount: 800,
            detailedMutualLimit: 600,
        });
        const store = createAnalysisV2CollectionRequestContextStore(fake.value);

        await expect(store.load({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
        })).resolves.toMatchObject({ planId: 'standard', detailedMutualLimit: 600 });
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_COLLECTION_CONTEXT_DATABASE_NAMES.loadRpc,
            {
                p_request_id: requestId,
                p_job_key: 'track:relationships:collect',
                p_claim_token: claimToken,
                p_job_input_hash: jobInputHash,
            }
        );
    });

    it('fails closed on stale claims and plan/count drift', async () => {
        const stale = client(null, {
            code: 'P0001',
            message: 'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH',
        });
        await expect(createAnalysisV2CollectionRequestContextStore(stale.value).load({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
        })).rejects.toBeInstanceOf(AnalysisV2CollectionContextFenceError);

        const drift = client({
            requestId,
            targetUsername: 'target',
            excludedUsername: null,
            accessMode: 'production',
            providerExecutionPolicy: null,
            planId: 'basic',
            followersDeclaredCount: 401,
            followingDeclaredCount: 1,
            detailedMutualLimit: 300,
        });
        await expect(createAnalysisV2CollectionRequestContextStore(drift.value).load({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
        })).rejects.toThrow('snapshot drift');
    });

    it('loads an immutable operation split only for a signed test access snapshot', async () => {
        const providerExecutionPolicy = {
            mode: 'test_operation_split',
            policyVersion: 'authorized-free-e2e-v1',
            operationSlots: {
                'target-profile': 'tertiary',
                'relationship-followers': 'primary',
                'relationship-following': 'secondary',
                'profile-fallback': 'tertiary',
                'target-likers': 'quaternary',
                'target-comments': 'tertiary',
                'candidate-likers': 'quinary',
            },
        } as const;
        const authorized = client({
            requestId,
            targetUsername: 'target',
            excludedUsername: null,
            accessMode: 'test_entitlement',
            providerExecutionPolicy,
            planId: 'basic',
            followersDeclaredCount: 2,
            followingDeclaredCount: 2,
            detailedMutualLimit: 300,
        });
        await expect(createAnalysisV2CollectionRequestContextStore(authorized.value).load({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
        })).resolves.toMatchObject({ accessMode: 'test_entitlement', providerExecutionPolicy });

        const invalidProduction = client({
            requestId,
            targetUsername: 'target',
            excludedUsername: null,
            accessMode: 'production',
            providerExecutionPolicy,
            planId: 'basic',
            followersDeclaredCount: 2,
            followingDeclaredCount: 2,
            detailedMutualLimit: 300,
        });
        await expect(createAnalysisV2CollectionRequestContextStore(invalidProduction.value).load({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
        })).rejects.toThrow('snapshot drift');
    });
});
