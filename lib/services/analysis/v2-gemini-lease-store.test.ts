import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES,
    AnalysisV2AiCapacityPendingError,
    AnalysisV2AiDeadlineTooShortError,
    AnalysisV2AiQuarantineActiveError,
    AnalysisV2AiResolverCapacitySkippedError,
    AnalysisV2GeminiLeaseFenceError,
    createAnalysisV2GeminiLeaseStore,
    type AnalysisV2GeminiLeaseDependencies,
} from './v2-gemini-lease-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow
const expiresAt = '2026-07-24T10:04:00.000Z';

function setup(data: unknown) {
    const rpc = vi.fn(async () => ({ data, error: null }));
    const dependencies: AnalysisV2GeminiLeaseDependencies = {
        rpc,
        nowMs: () => 1_000,
        randomUuid: () => claimToken,
    };
    return {
        rpc,
        store: createAnalysisV2GeminiLeaseStore(dependencies),
    };
}

function input() {
    return {
        requestId,
        jobKey: 'track:profile-ai:batch:0',
        attempt: 1,
        handlerDeadlineAtMs: 226_000,
    };
}

describe('deployment-wide Gemini lease store', () => {
    it('acquires one fenced slot with a bounded database lease', async () => {
        const { rpc, store } = setup([{
            outcome: 'acquired',
            slot: 3,
            lease_claim_token: claimToken,
            fence: 7,
            expires_at: expiresAt,
        }]);
        await expect(store.acquire(input())).resolves.toEqual({
            slot: 3,
            claimToken,
            fence: 7,
            expiresAt,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireRpc,
            {
                p_request_id: requestId,
                p_job_key: 'track:profile-ai:batch:0',
                p_attempt: 1,
                p_claim_token: claimToken,
                p_lease_seconds: 240,
            }
        );
    });

    it.each([
        {
            outcome: 'capacity_pending',
            error: AnalysisV2AiCapacityPendingError,
        },
        {
            outcome: 'quarantine_active',
            error: AnalysisV2AiQuarantineActiveError,
        },
    ])('maps $outcome without fabricating a lease', async scenario => {
        const { store } = setup([{
            outcome: scenario.outcome,
            slot: null,
            lease_claim_token: null,
            fence: null,
            expires_at: null,
        }]);
        await expect(store.acquire(input())).rejects.toBeInstanceOf(scenario.error);
    });

    it('rejects a short handler deadline before any RPC', async () => {
        const { rpc, store } = setup([]);
        await expect(store.acquire({
            ...input(),
            handlerDeadlineAtMs: 225_999,
        })).rejects.toBeInstanceOf(AnalysisV2AiDeadlineTooShortError);
        expect(rpc).not.toHaveBeenCalled();
    });

    it('renews and releases only an exact token and fence', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    renewed: true,
                    lease_state: 'leased',
                    expires_at: '2026-07-24T10:05:00.000Z',
                }],
                error: null,
            })
            .mockResolvedValueOnce({
                data: [{ released: true, lease_state: 'available', fence: 7 }],
                error: null,
            });
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 0,
            randomUuid: () => claimToken,
        });
        const lease = {
            slot: 3,
            claimToken,
            fence: 7,
            expiresAt,
        };
        const renewed = await store.renew(lease);
        await expect(store.release(renewed)).resolves.toBeUndefined();
        expect(rpc).toHaveBeenNthCalledWith(
            2,
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.releaseRpc,
            {
                p_slot: 3,
                p_claim_token: claimToken,
                p_fence: 7,
            }
        );
    });

    it('fails closed on a stale release result', async () => {
        const { store } = setup([{
            released: false,
            lease_state: 'leased',
            fence: 8,
        }]);
        await expect(store.release({
            slot: 3,
            claimToken,
            fence: 7,
            expiresAt,
        })).rejects.toBeInstanceOf(AnalysisV2GeminiLeaseFenceError);
    });

    it('uses operation-aware v2 admission for a v2.7 resolver without queueing', async () => {
        const operationKey = `gender-resolution:${'a'.repeat(64)}`;
        const { rpc, store } = setup([{
            outcome: 'acquired',
            slot: 2,
            lease_claim_token: claimToken,
            fence: 9,
            expires_at: expiresAt,
        }]);

        await expect(store.acquire({
            ...input(),
            operationKey,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.7',
        })).resolves.toMatchObject({
            slot: 2,
            operationKey,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.7',
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireV2Rpc,
            {
                p_request_id: requestId,
                p_job_key: 'track:profile-ai:batch:0',
                p_operation_key: operationKey,
                p_stage: 'genderResolution',
                p_attempt: 1,
                p_claim_token: claimToken,
                p_lease_seconds: 240,
            }
        );
    });

    it('maps resolver-only deployment capacity to an internal skip signal', async () => {
        const { store } = setup([{
            outcome: 'resolver_capacity_pending',
            slot: null,
            lease_claim_token: null,
            fence: null,
            expires_at: null,
        }]);

        await expect(store.acquire({
            ...input(),
            operationKey: `gender-resolution:${'a'.repeat(64)}`,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.7',
        })).rejects.toBeInstanceOf(AnalysisV2AiResolverCapacitySkippedError);
    });

    it('quarantines a cutoff v2 resolver lease instead of making it immediately available', async () => {
        const operationKey = `gender-resolution:${'a'.repeat(64)}`;
        const { rpc, store } = setup([{
            cutoff: true,
            lease_state: 'quarantined',
            fence: 9,
            expires_at: expiresAt,
        }]);

        await expect(store.cutoff({
            slot: 2,
            claimToken,
            fence: 9,
            expiresAt,
            operationKey,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.7',
        })).resolves.toBeUndefined();
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.cutoffV2Rpc,
            {
                p_slot: 2,
                p_claim_token: claimToken,
                p_fence: 9,
                p_operation_key: operationKey,
            }
        );
    });

    it('atomically terminalizes a resolver cutoff and quarantines its exact lease', async () => {
        const operationKey = `gender-resolution:${'a'.repeat(64)}`;
        const { rpc, store } = setup({
            outcome: 'cutoff',
            attempt_status: 'cutoff',
            lease_state: 'quarantined',
            fence: 9,
            expires_at: expiresAt,
        });
        const lease = {
            slot: 2,
            claimToken,
            fence: 9,
            expiresAt,
            operationKey,
            stage: 'genderResolution' as const,
            aiStagePolicyVersion: 'ai-stage-policy-v2.7' as const,
        };

        await expect(store.cutoffAttempt({
            lease,
            attempt: {
                requestId,
                jobKey: 'track:profile-ai:batch:0',
                claimToken: '323e4567-e89b-42d3-a456-426614174000',
                operationKey,
                attempt: 1,
                retryCount: 0,
                reservationToken: '423e4567-e89b-42d3-a456-426614174000',
                modelName: 'gemini-3-flash-preview',
                location: 'global',
                stage: 'genderResolution',
                thinkingLevel: 'LOW',
                mediaCount: 5,
                mediaResolution: 'MEDIUM',
                promptVersion: 'gender-resolution-v1',
                schemaVersion: 1,
                maxOutputTokens: 512,
                status: 'cutoff',
                usageMetadataStatus: 'missing',
                usageComplete: false,
                tokenUsage: null,
                latencyMs: 12,
                estimatedCostUsd: null,
                finishReason: null,
            },
        })).resolves.toBe('cutoff');
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.cutoffAttemptV2Rpc,
            {
                p_request_id: requestId,
                p_job_key: 'track:profile-ai:batch:0',
                p_job_claim_token: '323e4567-e89b-42d3-a456-426614174000',
                p_operation_key: operationKey,
                p_attempt: 1,
                p_reservation_token: '423e4567-e89b-42d3-a456-426614174000',
                p_telemetry: expect.objectContaining({
                    stage: 'genderResolution',
                    usage_metadata_status: 'missing',
                    usage_complete: false,
                }),
                p_slot: 2,
                p_lease_claim_token: claimToken,
                p_lease_fence: 9,
            }
        );
    });

    it('reaps only a bounded number of expired resolver cutoff leases', async () => {
        const { rpc, store } = setup(2);

        await expect(store.reapCutoff({ limit: 2 })).resolves.toBe(2);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.reapCutoffV2Rpc,
            { p_limit: 2 }
        );
        await expect(store.reapCutoff({ limit: 0 })).rejects.toThrow(
            'ANALYSIS_V2_GEMINI_LEASE_PERSISTENCE_ERROR'
        );
        expect(rpc).toHaveBeenCalledOnce();
    });
});
