import { describe, expect, it, vi } from 'vitest';
import {
    AnalysisProviderAdmissionCapacityPendingError,
    AnalysisProviderAdmissionClaimConflictError,
    AnalysisProviderAdmissionFenceError,
    AnalysisProviderAdmissionResolutionPendingError,
    analysisProviderAdmissionId,
    createAnalysisProviderAdmissionStore,
    type AnalysisProviderAdmissionLease,
} from './provider-admission-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000';
const leaseToken = '323e4567-e89b-42d3-a456-426614174000';

function acquired(): AnalysisProviderAdmissionLease {
    const lease = {
        outcome: 'acquired',
        admissionId: '',
        workloadRole: 'paid',
        logicalProvider: 'apify',
        credentialSlot: 'secondary',
        budgetKey: 'paid:apify:global',
        operationKey: 'relationship-followers:' + 'b'.repeat(64),
        requestId,
        jobKey: 'track:relationships:collect',
        claimToken,
        jobClaimToken: claimToken,
        leaseSeconds: 30,
        leaseToken,
        fence: 7,
        expiresAt: '2026-08-31T00:00:10.000Z',
        activeCount: 1,
        maxActive: 8,
    } satisfies Omit<AnalysisProviderAdmissionLease, 'admissionId'> & { admissionId: string };
    return { ...lease, admissionId: analysisProviderAdmissionId(lease) };
}

describe('database-global provider admission store', () => {
    it('uses the operation identity for idempotent acquire and fenced release', async () => {
        const response = acquired();
        const {
            claimToken: _claimToken,
            jobClaimToken: _jobClaimToken,
            leaseSeconds: _leaseSeconds,
            ...rpcResponse
        } = response;
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: rpcResponse, error: null })
            .mockResolvedValueOnce({ data: { released: true }, error: null });
        const store = createAnalysisProviderAdmissionStore({ rpc, nowMs: () => 0 });
        const input = {
            workloadRole: 'paid' as const,
            logicalProvider: 'apify' as const,
            credentialSlot: 'secondary' as const,
            budgetKey: 'paid:apify:global',
            requestId,
            jobKey: 'track:relationships:collect',
            operationKey: acquired().operationKey,
            claimToken,
            jobClaimToken: claimToken,
            leaseSeconds: 30,
        };

        await expect(store.acquire(input)).resolves.toEqual(acquired());
        await expect(store.release(acquired())).resolves.toBeUndefined();
        expect(rpc).toHaveBeenNthCalledWith(1, 'acquire_analysis_provider_admission',
            expect.objectContaining({
                p_operation_key: input.operationKey,
                p_workload_role: 'paid',
                p_credential_slot: 'secondary',
            }));
        expect(rpc).toHaveBeenNthCalledWith(2, 'release_analysis_provider_admission',
            expect.objectContaining({
                p_fence: 7,
                p_lease_token: leaseToken,
                p_release_reason: 'terminal',
            }));
    });

    it('maps capacity pending and stale fences to sanitized typed errors', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: {
                    outcome: 'capacity_pending',
                    admissionId: analysisProviderAdmissionId({
                        ...acquired(),
                    }),
                    workloadRole: 'paid',
                    logicalProvider: 'apify',
                    credentialSlot: 'secondary',
                    budgetKey: 'paid:apify:global',
                    operationKey: acquired().operationKey,
                    requestId,
                    jobKey: 'track:relationships:collect',
                    leaseToken: null,
                    fence: null,
                    expiresAt: null,
                    activeCount: 8,
                    maxActive: 8,
                },
                error: null,
            })
            .mockResolvedValueOnce({
                data: { released: false, reason: 'fence_mismatch' },
                error: null,
            });
        const store = createAnalysisProviderAdmissionStore({ rpc, nowMs: () => 0 });
        await expect(store.acquire({
            workloadRole: 'paid',
            logicalProvider: 'apify',
            credentialSlot: 'secondary',
            budgetKey: 'paid:apify:global',
            requestId,
            jobKey: 'track:relationships:collect',
            operationKey: acquired().operationKey,
            claimToken,
            jobClaimToken: claimToken,
            leaseSeconds: 30,
        })).rejects.toBeInstanceOf(AnalysisProviderAdmissionCapacityPendingError);
        await expect(store.release(acquired())).rejects.toBeInstanceOf(
            AnalysisProviderAdmissionFenceError
        );
    });

    it('lists only bounded expired lease identities for recovery', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: {
                candidates: [
                    {
                        admissionId: 'a'.repeat(64),
                        fence: 4,
                        expiresAt: '2026-08-31T00:00:00.000Z',
                    },
                ],
                hasMore: false,
            },
            error: null,
        });
        const store = createAnalysisProviderAdmissionStore({ rpc, nowMs: () => 0 });

        await expect(store.listExpired({ limit: 12 })).resolves.toEqual({
            candidates: [{
                admissionId: 'a'.repeat(64),
                fence: 4,
                expiresAt: '2026-08-31T00:00:00.000Z',
            }],
            hasMore: false,
        });
        expect(rpc).toHaveBeenCalledWith(
            'list_expired_analysis_provider_admissions_page',
            {
                p_limit: 12,
                p_after_expires_at: null,
                p_after_fence: null,
                p_after_admission_id: null,
            },
        );
    });

    it('accepts an explicit recovery cursor on the page RPC', async () => {
        const cursor = {
            expiresAt: '2026-08-31T00:00:00.000Z',
            fence: 4,
            admissionId: 'a'.repeat(64),
        } as const;
        const rpc = vi.fn().mockResolvedValue({
            data: {
                candidates: [],
                hasMore: false,
            },
            error: null,
        });
        const store = createAnalysisProviderAdmissionStore({ rpc, nowMs: () => 0 });

        await expect(store.listExpired({ limit: 12, cursor })).resolves.toEqual({
            candidates: [],
            hasMore: false,
        });
        expect(rpc).toHaveBeenCalledWith(
            'list_expired_analysis_provider_admissions_page',
            {
                p_limit: 12,
                p_after_expires_at: cursor.expiresAt,
                p_after_fence: cursor.fence,
                p_after_admission_id: cursor.admissionId,
            },
        );
    });

    it('fails closed when hasMore has no valid continuation cursor', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: {
                candidates: [],
                hasMore: true,
                nextCursor: null,
            },
            error: null,
        });
        const store = createAnalysisProviderAdmissionStore({ rpc, nowMs: () => 0 });

        await expect(store.listExpired({ limit: 12 })).rejects.toThrow(
            'ANALYSIS_PROVIDER_ADMISSION_PERSISTENCE_ERROR',
        );
    });

    it('maps claim and resolution conflicts without exposing RPC details', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT' },
            })
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING' },
            });
        const store = createAnalysisProviderAdmissionStore({ rpc, nowMs: () => 0 });
        await expect(store.acquire({
            workloadRole: 'paid',
            logicalProvider: 'apify',
            credentialSlot: 'secondary',
            budgetKey: 'paid:apify:global',
            requestId,
            jobKey: 'track:relationships:collect',
            operationKey: acquired().operationKey,
            claimToken,
            jobClaimToken: claimToken,
            leaseSeconds: 30,
        })).rejects.toBeInstanceOf(AnalysisProviderAdmissionClaimConflictError);
        await expect(store.resolve({
            admissionId: 'a'.repeat(64),
            resolutionToken: leaseToken,
        })).rejects.toBeInstanceOf(AnalysisProviderAdmissionResolutionPendingError);
    });
});
