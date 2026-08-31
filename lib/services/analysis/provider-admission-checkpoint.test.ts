import { describe, expect, it, vi } from 'vitest';
import type {
    ProviderRunCheckpoint,
    ProviderCostRunFinished,
} from '@/lib/services/instagram/providers/types';
import {
    AnalysisProviderAdmissionCapacityPendingError,
    AnalysisProviderAdmissionFenceError,
    AnalysisProviderAdmissionPersistenceError,
    analysisProviderAdmissionId,
    createAnalysisProviderAdmissionStore,
    type AnalysisProviderAdmissionLease,
    type AnalysisProviderAdmissionStore,
} from './provider-admission-store';
import { withAnalysisProviderAdmissionCheckpoint } from './provider-admission-checkpoint';

// gitleaks:allow -- deterministic UUID fixtures
const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const leaseToken = '33333333-3333-4333-8333-333333333333';
const actorId = 'apify/instagram-profile-scraper';
const operationKey = 'target-profile-fallback';
const identity = {
    logicalProvider: 'apify' as const,
    actorId,
    credentialSlot: 'primary' as const,
    maxChargeUsd: 0.25,
};

function lease(): AnalysisProviderAdmissionLease {
    return {
        workloadRole: 'preflight',
        logicalProvider: 'apify',
        credentialSlot: 'primary',
        budgetKey: 'preflight:apify:primary',
        requestId,
        jobKey: 'preflight:provider',
        operationKey,
        claimToken,
        jobClaimToken: claimToken,
        outcome: 'acquired',
        admissionId: 'a'.repeat(64),
        leaseToken,
        fence: 1,
        expiresAt: '2026-08-31T00:02:00.000Z',
        activeCount: 1,
        maxActive: 16,
        leaseSeconds: 120,
    };
}

function store(overrides: Partial<AnalysisProviderAdmissionStore> = {}) {
    return {
        acquire: vi.fn(async () => lease()),
        renew: vi.fn(async (value: AnalysisProviderAdmissionLease) => value),
        release: vi.fn(async () => undefined),
        recoverExpired: vi.fn(async () => false),
        resolve: vi.fn(async () => false),
        listExpired: vi.fn(async () => ({ candidates: [], hasMore: false })),
        ...overrides,
    } satisfies AnalysisProviderAdmissionStore;
}

function checkpoint(overrides: Partial<ProviderRunCheckpoint> = {}): ProviderRunCheckpoint {
    return {
        ...identity,
        onBeforeRunStart: vi.fn(async () => undefined),
        onRunStarted: vi.fn(async () => undefined),
        onRunStartRejected: vi.fn(async () => undefined),
        onRunStartAmbiguous: vi.fn(async () => undefined),
        onCostRunStarted: vi.fn(async () => undefined),
        onCostRunFinished: vi.fn(async () => undefined),
        ...overrides,
    };
}

const enabledEnv = {
    NODE_ENV: 'test',
    ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
};

describe('provider admission checkpoint', () => {
    it('replays one unknown acquire persistence failure before reserving a provider run', async () => {
        const admission = store({
            acquire: vi.fn()
                .mockRejectedValueOnce(new AnalysisProviderAdmissionPersistenceError())
                .mockResolvedValueOnce(lease()),
        });
        const base = checkpoint();
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        await wrapped.onBeforeRunStart?.(identity);

        expect(admission.acquire).toHaveBeenCalledTimes(2);
        expect(base.onBeforeRunStart).toHaveBeenCalledOnce();
    });

    it('replays an actual admission-store RPC after a lost acquire response', async () => {
        const admissionInput = {
            workloadRole: 'preflight' as const,
            logicalProvider: 'apify' as const,
            credentialSlot: 'primary' as const,
            budgetKey: 'preflight:apify:primary',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            jobClaimToken: claimToken,
            leaseSeconds: 120,
        };
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'ETIMEDOUT', message: 'transport unavailable' },
            })
            .mockResolvedValueOnce({
                data: {
                    outcome: 'acquired',
                    admissionId: analysisProviderAdmissionId(admissionInput),
                    workloadRole: 'preflight',
                    logicalProvider: 'apify',
                    credentialSlot: 'primary',
                    budgetKey: admissionInput.budgetKey,
                    requestId,
                    jobKey: admissionInput.jobKey,
                    operationKey,
                    leaseToken,
                    fence: 1,
                    expiresAt: '2026-08-31T00:02:00.000Z',
                    activeCount: 1,
                    maxActive: 16,
                },
                error: null,
            });
        const admission = createAnalysisProviderAdmissionStore({
            rpc,
            randomUuid: () => leaseToken,
        });
        const base = checkpoint();
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: admissionInput.jobKey,
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        await wrapped.onBeforeRunStart?.(identity);

        expect(rpc).toHaveBeenCalledTimes(2);
        expect(rpc).toHaveBeenNthCalledWith(
            1,
            'acquire_analysis_provider_admission',
            expect.objectContaining({
                p_admission_id: analysisProviderAdmissionId(admissionInput),
                p_job_claim_token: claimToken,
                p_claim_token: claimToken,
            }),
        );
        expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
        expect(base.onBeforeRunStart).toHaveBeenCalledOnce();
    });

    it('acquires before the durable provider callback and releases after terminal completion', async () => {
        const admission = store();
        const before = vi.fn(async () => undefined);
        const finishedCallback = vi.fn(async () => undefined);
        const base = checkpoint({
            onBeforeRunStart: before,
            onCostRunFinished: finishedCallback,
        });
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        await wrapped.onBeforeRunStart?.(identity);
        expect(admission.acquire).toHaveBeenCalledOnce();
        expect(before).toHaveBeenCalledOnce();
        expect(admission.acquire).toHaveBeenCalledBefore(before);

        const finished: ProviderCostRunFinished = {
            ...identity,
            runId: 'RunAbcd1234567890',
            status: 'succeeded',
            usageTotalUsd: 0.1,
        };
        await wrapped.onCostRunFinished?.(finished);
        expect(finishedCallback).toHaveBeenCalledWith(finished);
        expect(admission.release).toHaveBeenCalledOnce();
    });

    it('does not call the durable provider reservation when capacity is pending', async () => {
        const admission = store({
            acquire: vi.fn(async () => {
                throw new AnalysisProviderAdmissionCapacityPendingError();
            }),
        });
        const base = checkpoint();
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        await expect(wrapped.onBeforeRunStart?.(identity)).rejects
            .toBeInstanceOf(AnalysisProviderAdmissionCapacityPendingError);
        expect(base.onBeforeRunStart).not.toHaveBeenCalled();
    });

    it('retains the admission when the durable terminal ledger cannot be written', async () => {
        const admission = store();
        const base = checkpoint({
            onCostRunFinished: vi.fn(async () => {
                throw new Error('terminal ledger unavailable');
            }),
        });
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        await wrapped.onBeforeRunStart?.(identity);
        await expect(wrapped.onCostRunFinished?.({
            ...identity,
            runId: 'RunAbcd1234567890',
            status: 'succeeded',
            usageTotalUsd: 0.1,
        })).rejects.toThrow('terminal ledger unavailable');
        expect(admission.release).not.toHaveBeenCalled();
    });

    it('stops renewing an ambiguous lease so expiry recovery can observe it', async () => {
        vi.useFakeTimers();
        try {
            const renew = vi.fn(async (value: AnalysisProviderAdmissionLease) => value);
            const recoverExpired = vi.fn(async () => true);
            const admission = store({ renew, recoverExpired });
            const wrapped = await withAnalysisProviderAdmissionCheckpoint({
                checkpoint: checkpoint(),
                storedStatus: null,
                workloadRole: 'preflight',
                requestId,
                jobKey: 'preflight:provider',
                operationKey,
                claimToken,
                env: enabledEnv,
                store: admission,
            });

            await wrapped.onBeforeRunStart?.(identity);
            await wrapped.onRunStartAmbiguous?.({
                logicalProvider: identity.logicalProvider,
                actorId,
                credentialSlot: identity.credentialSlot,
                maxChargeUsd: identity.maxChargeUsd,
            });
            await vi.advanceTimersByTimeAsync(120_000);

            expect(renew).not.toHaveBeenCalled();
            await admission.recoverExpired({
                admissionId: lease().admissionId,
                recoveryToken: '44444444-4444-4444-8444-444444444444',
            });
            expect(recoverExpired).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops renewing after a terminal checkpoint failure while retaining the lease', async () => {
        vi.useFakeTimers();
        try {
            const renew = vi.fn(async (value: AnalysisProviderAdmissionLease) => value);
            const recoverExpired = vi.fn(async () => true);
            const admission = store({ renew, recoverExpired });
            const wrapped = await withAnalysisProviderAdmissionCheckpoint({
                checkpoint: checkpoint({
                    onCostRunFinished: vi.fn(async () => {
                        throw new Error('terminal ledger unavailable');
                    }),
                }),
                storedStatus: null,
                workloadRole: 'preflight',
                requestId,
                jobKey: 'preflight:provider',
                operationKey,
                claimToken,
                env: enabledEnv,
                store: admission,
            });

            await wrapped.onBeforeRunStart?.(identity);
            await expect(wrapped.onCostRunFinished?.({
                ...identity,
                runId: 'RunAbcd12345678',
                status: 'succeeded',
                usageTotalUsd: 0.1,
            })).rejects.toThrow('terminal ledger unavailable');
            await vi.advanceTimersByTimeAsync(120_000);

            expect(renew).not.toHaveBeenCalled();
            expect(admission.release).not.toHaveBeenCalled();
            await admission.recoverExpired({
                admissionId: lease().admissionId,
                recoveryToken: '55555555-5555-4555-8555-555555555555',
            });
            expect(recoverExpired).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('recovers an expired fence and resolves it only after ledger proof', async () => {
        const releaseMock = vi.fn(async () => {
            throw new AnalysisProviderAdmissionFenceError();
        });
        const admission = store({
            release: releaseMock,
            recoverExpired: vi.fn(async () => true),
            resolve: vi.fn(async () => true),
        });
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: checkpoint(),
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        await wrapped.onBeforeRunStart?.(identity);
        await wrapped.onCostRunFinished?.({
            ...identity,
            runId: 'RunAbcd1234567890',
            status: 'succeeded',
            usageTotalUsd: 0.1,
        });
        expect(admission.recoverExpired).toHaveBeenCalledWith({
            admissionId: lease().admissionId,
            recoveryToken: expect.any(String),
        });
        expect(admission.resolve).toHaveBeenCalledWith({
            admissionId: lease().admissionId,
            resolutionToken: expect.any(String),
        });
    });

    it('re-acquires an active resumed run idempotently and keeps ambiguity fenced', async () => {
        const admission = store();
        const base = checkpoint({ resumeRunId: 'RunAbcd1234567890' });
        const wrapped = await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: 'running',
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: enabledEnv,
            store: admission,
        });

        expect(admission.acquire).toHaveBeenCalledOnce();
        await wrapped.onRunStartAmbiguous?.({
            logicalProvider: identity.logicalProvider,
            actorId,
            credentialSlot: identity.credentialSlot,
            maxChargeUsd: identity.maxChargeUsd,
        });
        expect(admission.release).not.toHaveBeenCalled();
        expect(base.onRunStartAmbiguous).toHaveBeenCalledOnce();
    });

    it('is a no-op when the explicit gate is off', () => {
        const base = checkpoint();
        expect(withAnalysisProviderAdmissionCheckpoint({
            checkpoint: base,
            storedStatus: null,
            workloadRole: 'preflight',
            requestId,
            jobKey: 'preflight:provider',
            operationKey,
            claimToken,
            env: { NODE_ENV: 'test' },
            store: store(),
        })).toBe(base);
    });

    it('keeps paid relationship slots in distinct budgets for DB policy enforcement', async () => {
        const admission = store();
        const paidCheckpoint = checkpoint({
            credentialSlot: 'secondary',
        });
        const wrapped = await Promise.resolve(withAnalysisProviderAdmissionCheckpoint({
            checkpoint: paidCheckpoint,
            storedStatus: null,
            workloadRole: 'paid',
            requestId,
            jobKey: 'track:relationships:collect',
            operationKey: 'relationship-followers:' + 'a'.repeat(64),
            claimToken,
            env: enabledEnv,
            store: admission,
        }));
        await wrapped.onBeforeRunStart?.({
            ...identity,
            credentialSlot: 'secondary',
        });
        expect(admission.acquire).toHaveBeenCalledWith(expect.objectContaining({
            budgetKey: 'paid:apify:secondary:relationship',
        }));

        const nonSecondaryAdmission = store();
        const nonSecondaryWrapped = await Promise.resolve(withAnalysisProviderAdmissionCheckpoint({
            checkpoint: checkpoint({ credentialSlot: 'senary' }),
            storedStatus: null,
            workloadRole: 'paid',
            requestId,
            jobKey: 'track:relationships:collect',
            operationKey: 'relationship-followers:' + 'b'.repeat(64),
            claimToken,
            env: enabledEnv,
            store: nonSecondaryAdmission,
        }));
        await nonSecondaryWrapped.onBeforeRunStart?.({
            ...identity,
            credentialSlot: 'senary',
        });
        expect(nonSecondaryAdmission.acquire).toHaveBeenCalledWith(expect.objectContaining({
            budgetKey: 'paid:apify:senary:relationship',
        }));
    });
});
