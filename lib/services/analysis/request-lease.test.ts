import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_STEP_LEASE_SECONDS,
    acquireAnalysisRequestLease,
    isAnalysisRequestOwner,
    releaseAnalysisRequestLease,
    type AnalysisLeaseRpcClient,
} from './request-lease';

function clientWith(data: unknown, error: { code?: string } | null = null) {
    const rpc = vi.fn().mockResolvedValue({ data, error });
    return { client: { rpc } as AnalysisLeaseRpcClient, rpc };
}

describe('analysis request ownership and lease', () => {
    it('expires shortly after the serverless hard timeout so queue retries can recover', () => {
        expect(ANALYSIS_STEP_LEASE_SECONDS).toBeGreaterThan(300);
        expect(ANALYSIS_STEP_LEASE_SECONDS).toBeLessThanOrEqual(360);
    });

    it('requires the authenticated user to own the analysis request', () => {
        expect(isAnalysisRequestOwner('user-1', 'user-1')).toBe(true);
        expect(isAnalysisRequestOwner('user-1', 'user-2')).toBe(false);
        expect(isAnalysisRequestOwner('user-1', null)).toBe(false);
    });

    it('acquires an expected-step lease atomically through the RPC', async () => {
        const { client, rpc } = clientWith(true);
        const lease = await acquireAnalysisRequestLease(client, {
            requestId: 'request-1',
            userId: 'user-1',
            expectedStep: 'collect',
            leaseSeconds: 900,
        }, () => 'lease-token');

        expect(lease).toEqual({ requestId: 'request-1', token: 'lease-token' });
        expect(rpc).toHaveBeenCalledWith('acquire_analysis_request_lease', {
            p_request_id: 'request-1',
            p_user_id: 'user-1',
            p_expected_step: 'collect',
            p_lease_token: 'lease-token',
            p_lease_seconds: 900,
        });
    });

    it('returns null on contention and fails closed when the RPC is unavailable', async () => {
        const contended = clientWith(false);
        await expect(acquireAnalysisRequestLease(contended.client, {
            requestId: 'request-1',
            userId: 'user-1',
            expectedStep: 'collect',
            leaseSeconds: 900,
        })).resolves.toBeNull();

        const unavailable = clientWith(null, { code: 'PGRST202' });
        await expect(acquireAnalysisRequestLease(unavailable.client, {
            requestId: 'request-1',
            userId: 'user-1',
            expectedStep: 'collect',
            leaseSeconds: 900,
        })).rejects.toThrow('PGRST202');
    });

    it('releases only by request and opaque lease token', async () => {
        const { client, rpc } = clientWith(true);
        await releaseAnalysisRequestLease(client, {
            requestId: 'request-1',
            token: 'lease-token',
        });
        expect(rpc).toHaveBeenCalledWith('release_analysis_request_lease', {
            p_request_id: 'request-1',
            p_lease_token: 'lease-token',
        });
    });
});
