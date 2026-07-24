import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES,
    AnalysisV2AiCapacityPendingError,
    AnalysisV2AiDeadlineTooShortError,
    AnalysisV2AiQuarantineActiveError,
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
});
