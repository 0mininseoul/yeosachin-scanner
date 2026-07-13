import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_DAG_STATE_DATABASE_NAMES,
    AnalysisV2DagScopeMissingError,
    AnalysisV2DagStateConflictError,
    AnalysisV2DagStateFenceError,
    createSupabaseAnalysisV2DagStateStore,
    type AnalysisV2DagStateSupabaseClient,
} from './v2-dag-state-store';
import { buildAnalysisV2DagPlan, type AnalysisV2DagState } from './v2-dag-planner';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

function digest(label: string): string {
    return createHash('sha256').update(label, 'utf8').digest('hex');
}

function rpcClient(rpc: ReturnType<typeof vi.fn>): AnalysisV2DagStateSupabaseClient {
    return { rpc };
}

function baseState(): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: digest('request'),
        planId: 'basic',
        planSnapshotHash: digest('plan'),
        girlfriendExclusion: {
            decisionHash: digest('exclusion'),
            excludedCount: 1,
        },
        profileFetchBatches: [],
        profileAiBatches: [],
        privateNameBatches: [],
    };
}

function claim(jobKey: string, inputHash = digest(`input:${jobKey}`)) {
    return {
        requestId,
        jobKey,
        inputHash,
        claimToken: randomUUID(),
    };
}

describe('analysis V2 durable DAG state store', () => {
    it('initializes DB-derived immutable scope only through the bootstrap lease', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: baseState(), error: null });
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));
        const bootstrap = {
            ...claim('coordinator:bootstrap'),
            jobKey: 'coordinator:bootstrap' as const,
        };

        const state = await store.initializeScope(bootstrap);
        expect(state).toEqual(baseState());
        expect(Object.isFrozen(state)).toBe(true);
        expect(Object.isFrozen(state.girlfriendExclusion)).toBe(true);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.initializeScopeRpc,
            {
                p_request_id: requestId,
                p_job_key: 'coordinator:bootstrap',
                p_input_hash: bootstrap.inputHash,
                p_claim_token: bootstrap.claimToken,
            }
        );
    });

    it('writes a strict relationship manifest and returns planner-valid state', async () => {
        const relationshipJob = claim('track:relationships:collect');
        const relationship = {
            revision: 1,
            resultHash: digest('relationships'),
            detectedMutualCount: 2,
            publicCount: 1,
            privateCount: 1,
            detailedSelectedPublicCount: 1,
            notScreenedPublicCount: 0,
            profileBatches: [{ batch: 0, itemCount: 1, inputHash: digest('profile:0') }],
            privateNameBatches: [{ batch: 0, itemCount: 1, inputHash: digest('private:0') }],
        };
        const state = { ...baseState(), relationships: relationship };
        const rpc = vi.fn().mockResolvedValue({ data: [state], error: null });
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));

        await expect(store.checkpointManifest(relationshipJob, {
            kind: 'relationships',
            manifest: relationship,
        })).resolves.toEqual(state);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.checkpointManifestRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: relationshipJob.jobKey,
                p_input_hash: relationshipJob.inputHash,
                p_manifest_kind: 'relationships',
                p_manifest: relationship,
            })
        );
    });

    it('preserves exact profile batch producer lineage', async () => {
        const relationship = {
            revision: 1,
            resultHash: digest('relationships'),
            detectedMutualCount: 1,
            publicCount: 1,
            privateCount: 0,
            detailedSelectedPublicCount: 1,
            notScreenedPublicCount: 0,
            profileBatches: [{ batch: 0, itemCount: 1, inputHash: digest('profile:0') }],
            privateNameBatches: [],
        };
        const relationshipState = { ...baseState(), relationships: relationship };
        const plannedProfileJob = buildAnalysisV2DagPlan(requestId, relationshipState).jobs
            .find(job => job.jobKey === 'track:profiles:batch:0');
        if (!plannedProfileJob) throw new Error('Missing planned profile batch job.');
        const profileJob = claim(plannedProfileJob.jobKey, plannedProfileJob.inputHash);
        const batch = {
            batch: 0,
            itemCount: 1,
            producerInputHash: profileJob.inputHash,
            revision: 1,
            resultHash: digest('profile-result'),
        };
        const state = {
            ...relationshipState,
            profileFetchBatches: [batch],
        };
        const rpc = vi.fn().mockResolvedValue({ data: state, error: null });
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));

        await expect(store.checkpointManifest(profileJob, {
            kind: 'profile_fetch_batch',
            manifest: batch,
        })).resolves.toEqual(state);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.checkpointManifestRpc,
            expect.objectContaining({
                p_manifest_kind: 'profile_fetch_batch',
                p_manifest: expect.objectContaining({
                    producerInputHash: profileJob.inputHash,
                }),
            })
        );
    });

    it('rejects mismatched producer lineage before making an RPC', async () => {
        const rpc = vi.fn();
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));

        await expect(store.checkpointManifest(claim('track:profiles:batch:0'), {
            kind: 'profile_fetch_batch',
            manifest: {
                batch: 0,
                itemCount: 1,
                producerInputHash: digest('different-input'),
                revision: 1,
                resultHash: digest('result'),
            },
        })).rejects.toThrow('producer input hash mismatch');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects malformed or planner-inconsistent state returned by persistence', async () => {
        const malformed = { ...baseState(), targetUsername: 'pii' };
        const inconsistent = {
            ...baseState(),
            primaryJoin: {
                revision: 1,
                resultHash: digest('early-join'),
                verifiedFemaleCount: 0,
            },
        };
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: malformed, error: null })
            .mockResolvedValueOnce({ data: inconsistent, error: null });
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));

        await expect(store.load(requestId)).rejects.toThrow('invalid state result');
        await expect(store.load(requestId)).rejects.toThrow('inconsistent state result');
    });

    it('loads null without inventing a scope', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));

        await expect(store.load(requestId)).resolves.toBeNull();
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.loadStateRpc,
            { p_request_id: requestId }
        );
    });

    it.each([
        ['ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', AnalysisV2DagStateFenceError],
        ['ANALYSIS_V2_DAG_STATE_CONFLICT', AnalysisV2DagStateConflictError],
        ['ANALYSIS_V2_DAG_SCOPE_MISSING', AnalysisV2DagScopeMissingError],
    ])('maps %s to its stable domain error', async (message, ErrorType) => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { code: 'P0001', message },
        });
        const store = createSupabaseAnalysisV2DagStateStore(rpcClient(rpc));

        await expect(store.load(requestId)).rejects.toBeInstanceOf(ErrorType);
    });

    it('does not expose provider payloads or PII fields in the database contract', () => {
        expect(Object.values(ANALYSIS_V2_DAG_STATE_DATABASE_NAMES).join(' '))
            .not.toMatch(/username|comment|caption|provider/i);
    });
});
