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
import {
    AnalysisProviderAdmissionCapacityPendingError,
    AnalysisProviderAdmissionClaimConflictError,
    AnalysisProviderAdmissionIdentityConflictError,
    AnalysisProviderAdmissionPersistenceError,
    type AnalysisProviderAdmissionStore,
} from './provider-admission-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow
const expiresAt = '2026-07-24T10:04:00.000Z';

function setup(data: unknown) {
        const rpc = vi.fn(async (..._args: unknown[]) => ({ data, error: null }));
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
        jobClaimToken: '423e4567-e89b-42d3-a456-426614174000',
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

    it('adds the paid Gemini rate-budget fence without replacing the eight-slot lease', async () => {
        const providerAdmissionStore = {
            acquire: vi.fn(async (value) => ({
                ...value,
                outcome: 'acquired' as const,
                admissionId: 'd'.repeat(64),
                leaseToken: '323e4567-e89b-42d3-a456-426614174000',
                fence: 1,
                expiresAt,
                activeCount: 1,
                maxActive: 8,
            })),
            renew: vi.fn(async value => value),
            release: vi.fn(async () => undefined),
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn(async (name: string) => name.includes('release')
            ? {
                data: [{ released: true, lease_state: 'available', fence: 7 }],
                error: null,
            }
            : {
                data: [{
                    outcome: 'acquired',
                    slot: 3,
                    lease_claim_token: claimToken,
                    fence: 7,
                    expires_at: expiresAt,
                }],
                error: null,
            });
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });
        const lease = await store.acquire(input());
        expect(providerAdmissionStore.acquire).toHaveBeenCalledWith(expect.objectContaining({
            workloadRole: 'paid',
            logicalProvider: 'gemini',
            credentialSlot: 'gemini-3',
            budgetKey: 'paid:gemini:gemini-3',
            claimToken,
            jobClaimToken: input().jobClaimToken,
        }));
        expect(lease.providerAdmissionLease).toBeDefined();
        await store.release(lease);
        expect(providerAdmissionStore.release).toHaveBeenCalledOnce();
    });

    it('releases provider admission before the authoritative Gemini slot', async () => {
        const providerAdmissionStore = {
            acquire: vi.fn(async (value) => ({
                ...value,
                outcome: 'acquired' as const,
                admissionId: 'd'.repeat(64),
                leaseToken: '323e4567-e89b-42d3-a456-426614174000',
                fence: 1,
                expiresAt,
                activeCount: 1,
                maxActive: 8,
            })),
            renew: vi.fn(async value => value),
            release: vi.fn(async () => {
                throw new Error('transient admission release uncertainty');
            }),
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn(async () => ({
            data: [{
                outcome: 'acquired',
                slot: 3,
                lease_claim_token: claimToken,
                fence: 7,
                expires_at: expiresAt,
            }],
            error: null,
        }));
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });
        const lease = await store.acquire(input());
        await expect(store.release(lease)).rejects.toThrow(
            'transient admission release uncertainty',
        );
        expect(providerAdmissionStore.release).toHaveBeenCalledOnce();
        expect(rpc).toHaveBeenCalledOnce();
        expect((rpc.mock.calls[0] as unknown[] | undefined)?.[0]).not.toContain('release');
    });

    it('retains the Gemini fence when slot release fails after admission release', async () => {
        const providerAdmissionStore = {
            acquire: vi.fn(async (value) => ({
                ...value,
                outcome: 'acquired' as const,
                admissionId: 'd'.repeat(64),
                leaseToken: '323e4567-e89b-42d3-a456-426614174000',
                fence: 1,
                expiresAt,
                activeCount: 1,
                maxActive: 8,
            })),
            renew: vi.fn(async value => value),
            release: vi.fn(async () => undefined),
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: [{
                outcome: 'acquired', slot: 3, lease_claim_token: claimToken,
                fence: 7, expires_at: expiresAt,
            }], error: null })
            .mockResolvedValueOnce({ data: null, error: new Error('slot release unavailable') });
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });
        const lease = await store.acquire(input());
        await expect(store.release(lease)).rejects.toThrow(
            'ANALYSIS_V2_GEMINI_LEASE_PERSISTENCE_ERROR',
        );
        expect(providerAdmissionStore.release).toHaveBeenCalledOnce();
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('replays an ambiguous provider admission response before releasing the Gemini fence', async () => {
        const acquired = vi.fn()
            .mockRejectedValueOnce(new AnalysisProviderAdmissionPersistenceError())
            .mockResolvedValueOnce({
                ...input(),
                workloadRole: 'paid' as const,
                logicalProvider: 'gemini' as const,
                credentialSlot: 'gemini-3',
                budgetKey: 'paid:gemini:gemini-3',
                operationKey: 'gemini:legacy:unknown:attempt:1',
                claimToken,
                jobClaimToken: input().jobClaimToken,
                providerFence: 7,
                outcome: 'already_acquired' as const,
                admissionId: 'd'.repeat(64),
                leaseToken: '323e4567-e89b-42d3-a456-426614174000',
                fence: 1,
                expiresAt,
                activeCount: 1,
                maxActive: 8,
            });
        const providerAdmissionStore = {
            acquire: acquired,
            renew: vi.fn(async value => value),
            release: vi.fn(async () => undefined),
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn(async () => ({
            data: [{
                outcome: 'acquired', slot: 3, lease_claim_token: claimToken,
                fence: 7, expires_at: expiresAt,
            }],
            error: null,
        }));
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });
        await expect(store.acquire(input())).resolves.toMatchObject({
            providerAdmissionLease: expect.objectContaining({ outcome: 'already_acquired' }),
        });
        expect(acquired).toHaveBeenCalledTimes(2);
    });

    it.each([
        AnalysisProviderAdmissionCapacityPendingError,
        AnalysisProviderAdmissionClaimConflictError,
        AnalysisProviderAdmissionIdentityConflictError,
    ])('does not replay an explicit %s denial and returns the Gemini slot', async (Denial) => {
        const denial = new Denial();
        const acquire = vi.fn(async () => {
            throw denial;
        });
        const release = vi.fn(async () => undefined);
        const providerAdmissionStore = {
            acquire,
            renew: vi.fn(async value => value),
            release,
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn(async (name: string) => name.includes('release')
            ? {
                data: [{ released: true, lease_state: 'available', fence: 7 }],
                error: null,
            }
            : {
                data: [{
                    outcome: 'acquired',
                    slot: 3,
                    lease_claim_token: claimToken,
                    fence: 7,
                    expires_at: expiresAt,
                }],
                error: null,
            });
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });

        await expect(store.acquire(input())).rejects.toBe(denial);
        expect(acquire).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(rpc.mock.calls[1]?.[0]).toContain('release');
    });

    it('releases the Gemini slot and returns a replay typed denial after an unknown first result', async () => {
        const denial = new AnalysisProviderAdmissionCapacityPendingError();
        const acquire = vi.fn()
            .mockRejectedValueOnce(new AnalysisProviderAdmissionPersistenceError())
            .mockRejectedValueOnce(denial);
        const release = vi.fn(async () => undefined);
        const providerAdmissionStore = {
            acquire,
            renew: vi.fn(async value => value),
            release,
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn(async (name: string) => name.includes('release')
            ? {
                data: [{ released: true, lease_state: 'available', fence: 7 }],
                error: null,
            }
            : {
                data: [{
                    outcome: 'acquired',
                    slot: 3,
                    lease_claim_token: claimToken,
                    fence: 7,
                    expires_at: expiresAt,
                }],
                error: null,
            });
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });

        await expect(store.acquire(input())).rejects.toBe(denial);
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(release).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(rpc.mock.calls[1]?.[0]).toContain('release');
    });

    it('retains the Gemini slot when both admission attempts remain persistence-unknown', async () => {
        const acquire = vi.fn()
            .mockRejectedValueOnce(new AnalysisProviderAdmissionPersistenceError())
            .mockRejectedValueOnce(new AnalysisProviderAdmissionPersistenceError());
        const release = vi.fn(async () => undefined);
        const providerAdmissionStore = {
            acquire,
            renew: vi.fn(async value => value),
            release,
            recoverExpired: vi.fn(async () => false),
            resolve: vi.fn(async () => false),
            listExpired: vi.fn(async () => []),
        } as unknown as AnalysisProviderAdmissionStore;
        const rpc = vi.fn(async () => ({
            data: [{
                outcome: 'acquired',
                slot: 3,
                lease_claim_token: claimToken,
                fence: 7,
                expires_at: expiresAt,
            }],
            error: null,
        }));
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
            env: { NODE_ENV: 'test', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            providerAdmissionStore,
        });

        await expect(store.acquire(input())).rejects.toBeInstanceOf(
            AnalysisProviderAdmissionPersistenceError,
        );
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(release).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledOnce();
    });

    it('replays an ambiguous Gemini slot response with the same proposed token', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: null, error: new Error('slot response lost') })
            .mockResolvedValueOnce({ data: [{
                outcome: 'acquired', slot: 3, lease_claim_token: claimToken,
                fence: 7, expires_at: expiresAt,
            }], error: null });
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 1_000,
            randomUuid: () => claimToken,
        });
        await expect(store.acquire(input())).resolves.toMatchObject({ slot: 3, fence: 7 });
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(rpc.mock.calls[0]?.[1]).toEqual(rpc.mock.calls[1]?.[1]);
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

    it('allows the shorter monotonic deadline only for the exact B-lite identity and keeps a 240s lease', async () => {
        const { rpc, store } = setup([{
            outcome: 'acquired',
            slot: 3,
            lease_claim_token: claimToken,
            fence: 7,
            expires_at: expiresAt,
        }]);
        await expect(store.acquire({
            ...input(),
            jobKey: 'preflight:blite',
            handlerDeadlineAtMs: 44_000,
            leaseProfile: 'precheckout_blite',
        })).resolves.toMatchObject({ slot: 3, fence: 7 });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireRpc,
            expect.objectContaining({ p_lease_seconds: 240 }),
        );

        await expect(store.acquire({
            ...input(),
            leaseProfile: 'precheckout_blite',
        })).rejects.toBeInstanceOf(Error);
        expect(rpc).toHaveBeenCalledTimes(1);
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

    it.each([
        {
            name: 'legacy',
            lease: {
                slot: 3,
                claimToken,
                fence: 7,
                expiresAt,
            },
            expectedRpc: ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.releaseRpc,
        },
        {
            name: 'v2',
            lease: {
                slot: 3,
                claimToken,
                fence: 7,
                expiresAt,
                operationKey: `feature-analysis:${'d'.repeat(64)}`,
                stage: 'featureAnalysis' as const,
                aiStagePolicyVersion: 'ai-stage-policy-v2.7' as const,
            },
            expectedRpc: ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.releaseV2Rpc,
        },
    ])('accepts a committed $name release replay after response loss', async ({
        lease,
        expectedRpc,
    }) => {
        const rpc = vi.fn(async () => ({
            // The first release committed, but the retry sees the idempotent
            // available shape instead of the original `released=true` row.
            data: [{ released: false, lease_state: 'available', fence: 7 }],
            error: null,
        }));
        const store = createAnalysisV2GeminiLeaseStore({
            rpc,
            nowMs: () => 0,
            randomUuid: () => claimToken,
        });

        await expect(store.release(lease)).resolves.toBeUndefined();
        expect(rpc).toHaveBeenCalledWith(
            expectedRpc,
            expect.objectContaining({
                p_slot: 3,
                p_claim_token: claimToken,
                p_fence: 7,
            }),
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

    it('uses deployment-wide scheduler-stage admission only for v2.8 scheduled stages', async () => {
        const operationKey = `feature-analysis:${'b'.repeat(64)}`;
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
            stage: 'featureAnalysis',
            aiStagePolicyVersion: 'ai-stage-policy-v2.8',
        })).resolves.toMatchObject({
            operationKey,
            stage: 'featureAnalysis',
            aiStagePolicyVersion: 'ai-stage-policy-v2.8',
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireSchedulerV1Rpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_operation_key: operationKey,
                p_stage: 'featureAnalysis',
            })
        );
    });

    it('accepts the v2.11 launch policy for scheduler-stage admission', async () => {
        const operationKey = `gender-triage:${'c'.repeat(64)}`;
        const { rpc, store } = setup([{
            outcome: 'acquired',
            slot: 2,
            lease_claim_token: claimToken,
            fence: 10,
            expires_at: expiresAt,
        }]);

        await expect(store.acquire({
            ...input(),
            operationKey,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
        })).resolves.toMatchObject({
            operationKey,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireSchedulerV1Rpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_operation_key: operationKey,
                p_stage: 'genderTriage',
            })
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

    it('recovers reserved resolver cutoff attempts before reaping their leases', async () => {
        const { rpc, store } = setup(2);

        await expect(store.recoverCutoffAttempts({ limit: 2 })).resolves.toBe(2);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.recoverCutoffAttemptsV2Rpc,
            { p_limit: 2 }
        );
        await expect(store.recoverCutoffAttempts({ limit: 9 })).rejects.toThrow(
            'ANALYSIS_V2_GEMINI_LEASE_PERSISTENCE_ERROR'
        );
        expect(rpc).toHaveBeenCalledOnce();
    });
});
