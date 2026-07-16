import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: vi.fn() } }));

import {
    FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES,
    PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT,
    PREFLIGHT_PROVIDER_RECONCILIATION_CALL_TIMEOUT_MS,
    PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES,
    bindPreflightProviderRunCheckpoint,
    createFreshAdmissionProviderRunStore,
    createPreflightProviderRunStore,
    preflightProviderIdentity,
    reconcileSettledPreflightProviderCosts,
    type StoredPreflightProviderRun,
} from './preflight-provider-run';
import type { ClaimedPreflight } from './preflight';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- fixture
const inputHash = 'ba942c19b6d4896505db8b3a400802896e9ef5a7fb3155d564d852e934215c7e';
const runId = 'StoredRun12345678';

function row(
    status: StoredPreflightProviderRun['status'] = 'running',
    overrides: Record<string, unknown> = {}
) {
    const reservedAt = '2026-07-14T17:59:00.000Z';
    const runStartedAt = status === 'starting' ? null : '2026-07-14T17:59:30.000Z';
    const terminalizedAt = ['starting', 'running'].includes(status)
        ? null
        : '2026-07-14T18:05:00.000Z';
    return {
        preflightId,
        operationKey: 'target-profile-fallback',
        inputHash,
        logicalProvider: 'apify',
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
        status,
        runId: status === 'starting' ? null : runId,
        actualUsageUsd: null,
        reservedAt,
        runStartedAt,
        terminalizedAt,
        ...overrides,
    };
}

describe('preflight provider-run adapter', () => {
    it('binds fresh admission to its generation-scoped RPC and operation', async () => {
        const rpc = vi.fn(async () => ({
            data: row('running', {
                operationKey: 'target-profile-fresh-admission:g4',
            }),
            error: null,
        }));
        const store = createFreshAdmissionProviderRunStore({ rpc }, 4);

        await expect(store.load({ preflightId, claimToken, inputHash })).resolves.toMatchObject({
            operationKey: 'target-profile-fresh-admission:g4',
            runId,
        });
        expect(rpc).toHaveBeenCalledWith(
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            {
                p_preflight_id: preflightId,
                p_claim_token: claimToken,
                p_input_hash: inputHash,
                p_admission_generation: 4,
            }
        );

        const wrongOperation = createFreshAdmissionProviderRunStore({
            rpc: vi.fn(async () => ({ data: row(), error: null })),
        }, 4);
        await expect(wrongOperation.load({ preflightId, claimToken, inputHash }))
            .rejects.toThrow('IDENTITY_CONFLICT');
    });

    it('marks one exact fresh-admission run as schema-v1 reusable through its generation fence', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ data: false, error: null });
        const store = createFreshAdmissionProviderRunStore({ rpc }, 4);
        const input = { preflightId, claimToken, inputHash, runId };

        await expect(store.markReusableProfileSchemaV1(input)).resolves.toBe('marked');
        await expect(store.markReusableProfileSchemaV1(input)).resolves.toBe('already_marked');
        expect(rpc).toHaveBeenNthCalledWith(
            1,
            FRESH_ADMISSION_PROVIDER_RUN_DATABASE_NAMES.markReusableProfileSchemaV1Rpc,
            {
                p_preflight_id: preflightId,
                p_admission_generation: 4,
                p_claim_token: claimToken,
                p_input_hash: inputHash,
                p_run_id: runId,
            }
        );
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('target.name');
    });

    it('loads a fenced hashed identity without sending raw provider input', async () => {
        const rpc = vi.fn(async () => ({ data: row(), error: null }));
        const store = createPreflightProviderRunStore({ rpc });

        await expect(store.load({ preflightId, claimToken, inputHash })).resolves.toMatchObject({
            credentialSlot: 'quinary',
            status: 'running',
            runId,
        });
        expect(rpc).toHaveBeenCalledWith(PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.loadRpc, {
            p_preflight_id: preflightId,
            p_claim_token: claimToken,
            p_input_hash: inputHash,
        });
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('target.name');
    });

    it('fails closed when an RPC returns a different hash or billing identity', async () => {
        const wrongHash = createPreflightProviderRunStore({
            rpc: vi.fn(async () => ({
                data: row('running', { inputHash: 'a'.repeat(64) }),
                error: null,
            })),
        });
        await expect(wrongHash.load({ preflightId, claimToken, inputHash }))
            .rejects.toThrow('IDENTITY_CONFLICT');

        const wrongCharge = createPreflightProviderRunStore({
            rpc: vi.fn(async () => ({
                data: { created: true, run: row('starting', { maxChargeUsd: 0.01 }) },
                error: null,
            })),
        });
        await expect(wrongCharge.reserve({
            preflightId,
            claimToken,
            inputHash,
            ...preflightProviderIdentity('quinary'),
        })).rejects.toThrow('invalid money');
    });

    it('replays starting without exposing a new start callback', async () => {
        const store = {
            load: vi.fn(async () => row('starting') as StoredPreflightProviderRun),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointTerminal: vi.fn(),
        };
        const result = await bindPreflightProviderRunCheckpoint({
            store,
            claim: { preflightId, claimToken } as ClaimedPreflight,
            inputHash,
            identity: preflightProviderIdentity('quinary'),
        });

        expect(result.checkpoint).toMatchObject({ startReserved: true });
        expect(result.checkpoint.onBeforeRunStart).toBeUndefined();
        expect(result.checkpoint.onRunStarted).toBeUndefined();
        expect(store.reserve).not.toHaveBeenCalled();
    });

    it('resumes a terminal success by the same run for a bounded dataset reread', async () => {
        const store = {
            load: vi.fn(async () => row('succeeded') as StoredPreflightProviderRun),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointTerminal: vi.fn(),
        };
        const result = await bindPreflightProviderRunCheckpoint({
            store,
            claim: { preflightId, claimToken } as ClaimedPreflight,
            inputHash,
            identity: preflightProviderIdentity('quinary'),
        });

        expect(result.checkpoint).toMatchObject({
            resumeRunId: runId,
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
        });
        expect(store.reserve).not.toHaveBeenCalled();
    });

    it('rejects terminal usage above the fixed charge before any RPC', async () => {
        const rpc = vi.fn();
        const store = createPreflightProviderRunStore({ rpc });

        await expect(store.checkpointTerminal({
            preflightId,
            claimToken,
            inputHash,
            ...preflightProviderIdentity('quinary'),
            runId,
            status: 'succeeded',
            actualUsageUsd: 0.0027,
        })).rejects.toThrow('VALIDATION_ERROR');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('lists and reconciles one PII-free terminal identity through service RPCs', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: [row('succeeded')], error: null })
            .mockResolvedValueOnce({
                data: row('succeeded', { actualUsageUsd: 0.0025 }),
                error: null,
            });
        const store = createPreflightProviderRunStore({ rpc });

        const [candidate] = await store.listUnreconciled(1);
        await expect(store.reconcileUsage({
            preflightId: candidate.preflightId,
            inputHash: candidate.inputHash,
            ...preflightProviderIdentity(candidate.credentialSlot),
            runId: candidate.runId!,
            status: 'succeeded',
            actualUsageUsd: 0.0025,
            providerFinishedAt: '2026-07-14T18:04:00.000Z',
        })).resolves.toMatchObject({ actualUsageUsd: 0.0025 });

        expect(rpc.mock.calls).toEqual([
            [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.listUnreconciledRpc, { p_limit: 1 }],
            [PREFLIGHT_PROVIDER_RUN_DATABASE_NAMES.reconcileUsageRpc, {
                p_preflight_id: preflightId,
                p_input_hash: inputHash,
                p_run_id: runId,
                p_logical_provider: 'apify',
                p_actor_id: 'apify/instagram-profile-scraper',
                p_credential_slot: 'quinary',
                p_max_charge_usd: 0.0026,
                p_status: 'succeeded',
                p_actual_usage_usd: 0.0025,
                p_provider_finished_at: '2026-07-14T18:04:00.000Z',
            }],
        ]);
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('target.name');
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('api-token');
    });

    it('reconciles all five credential slots and rejects unstable status or over-cap usage', async () => {
        const slots = ['primary', 'secondary', 'tertiary', 'quaternary', 'quinary'] as const;
        const stable = slots.map((credentialSlot, index) => row('succeeded', {
            preflightId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            inputHash: String(index + 1).repeat(64),
            credentialSlot,
            runId: `StableRun000000${index + 1}`,
        })) as StoredPreflightProviderRun[];
        const reconcileUsage = vi.fn(async input => ({
            ...stable.find(item => item.preflightId === input.preflightId)!,
            actualUsageUsd: input.actualUsageUsd,
        }));
        const store = {
            listUnreconciled: vi.fn(async () => stable),
            reconcileUsage,
        };
        const selectedSlots: string[] = [];

        await expect(reconcileSettledPreflightProviderCosts(store, {
            clientForSlot: slot => {
                selectedSlots.push(slot);
                return {
                    run: () => ({
                        get: async () => ({
                            status: 'SUCCEEDED',
                            usageTotalUsd: 0.0025,
                            finishedAt: '2026-07-14T18:04:00.000Z',
                        }),
                    }),
                };
            },
        })).resolves.toEqual({ eligible: 5, finalized: 5, failed: 0, hasMore: false });
        expect(new Set(selectedSlots)).toEqual(new Set(slots));
        expect(reconcileUsage).toHaveBeenCalledTimes(5);

        const unsafeStore = {
            listUnreconciled: vi.fn(async () => [stable[0], stable[1]]),
            reconcileUsage: vi.fn(),
        };
        await expect(reconcileSettledPreflightProviderCosts(unsafeStore, {
            clientForSlot: () => ({
                run: id => ({
                    get: async () => id === stable[0].runId
                        ? {
                            status: 'FAILED',
                            usageTotalUsd: 0.0025,
                            finishedAt: '2026-07-14T18:04:00.000Z',
                        }
                        : {
                            status: 'SUCCEEDED',
                            usageTotalUsd: 0.0027,
                            finishedAt: '2026-07-14T18:04:00.000Z',
                        },
                }),
            }),
        })).resolves.toEqual({ eligible: 2, finalized: 0, failed: 2, hasMore: false });
        expect(unsafeStore.reconcileUsage).not.toHaveBeenCalled();
    });

    it('settles a stale local running row only from a matching remote terminal snapshot', async () => {
        const candidate = row('running') as StoredPreflightProviderRun;
        const reconcileUsage = vi.fn(async input => ({
            ...candidate,
            status: input.status,
            actualUsageUsd: input.actualUsageUsd,
        }));
        const store = {
            listUnreconciled: vi.fn(async () => [candidate]),
            reconcileUsage,
        };

        await expect(reconcileSettledPreflightProviderCosts(store, {
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({
                        status: 'SUCCEEDED',
                        usageTotalUsd: 0.0025,
                        finishedAt: '2026-07-14T18:04:00.000Z',
                    }),
                }),
            }),
        })).resolves.toEqual({ eligible: 1, finalized: 1, failed: 0, hasMore: false });
        expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
            preflightId,
            runId,
            status: 'succeeded',
            actualUsageUsd: 0.0025,
            providerFinishedAt: '2026-07-14T18:04:00.000Z',
        }));

        reconcileUsage.mockClear();
        await expect(reconcileSettledPreflightProviderCosts(store, {
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({
                        status: 'RUNNING',
                        usageTotalUsd: 0.0025,
                        finishedAt: '2026-07-14T18:04:00.000Z',
                    }),
                }),
            }),
        })).resolves.toEqual({ eligible: 1, finalized: 0, failed: 1, hasMore: false });
        expect(reconcileUsage).not.toHaveBeenCalled();
    });

    it('accepts the exact 30-second boundary and rejects unstable provider finish times', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-14T18:04:30.000Z'));
        try {
            const candidate = row('running') as StoredPreflightProviderRun;
            const reconcileUsage = vi.fn(async input => ({
                ...candidate,
                status: input.status,
                actualUsageUsd: input.actualUsageUsd,
            }));
            const store = {
                listUnreconciled: vi.fn(async () => [candidate]),
                reconcileUsage,
            };
            const finishValues: unknown[] = [
                undefined,
                'July 14, 2026 18:04 UTC',
                '2026-02-30T18:04:00.000Z',
                new Date(Date.now() + 60_000),
                '2026-07-14T17:58:59.000Z',
                '2026-07-14T18:04:00.001Z',
            ];
            for (const finishedAt of finishValues) {
                await expect(reconcileSettledPreflightProviderCosts(store, {
                    clientForSlot: () => ({
                        run: () => ({
                            get: async () => ({
                                status: 'SUCCEEDED',
                                usageTotalUsd: 0.0025,
                                finishedAt,
                            }),
                        }),
                    }),
                })).resolves.toEqual({ eligible: 1, finalized: 0, failed: 1, hasMore: false });
            }
            expect(reconcileUsage).not.toHaveBeenCalled();

            await expect(reconcileSettledPreflightProviderCosts(store, {
                clientForSlot: () => ({
                    run: () => ({
                        get: async () => ({
                            status: 'SUCCEEDED',
                            usageTotalUsd: 0.0025,
                            finishedAt: new Date('2026-07-14T18:04:00.000Z'),
                        }),
                    }),
                }),
            })).resolves.toEqual({ eligible: 1, finalized: 1, failed: 0, hasMore: false });
            expect(reconcileUsage).toHaveBeenCalledWith(expect.objectContaining({
                providerFinishedAt: '2026-07-14T18:04:00.000Z',
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('reconciles only the bounded page and reports a remaining backlog', async () => {
        const candidates = Array.from(
            { length: PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT + 1 },
            (_, index) => row('succeeded', {
                preflightId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                inputHash: (index % 10).toString().repeat(64),
                runId: `BoundedRun0000${String(index).padStart(4, '0')}`,
            }) as StoredPreflightProviderRun
        );
        const store = {
            listUnreconciled: vi.fn(async () => candidates),
            reconcileUsage: vi.fn(async input => ({
                ...candidates.find(item => item.preflightId === input.preflightId)!,
                actualUsageUsd: input.actualUsageUsd,
            })),
        };

        await expect(reconcileSettledPreflightProviderCosts(store, {
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({
                        status: 'SUCCEEDED',
                        usageTotalUsd: 0.0025,
                        finishedAt: '2026-07-14T18:04:00.000Z',
                    }),
                }),
            }),
        })).resolves.toEqual({
            eligible: PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT,
            finalized: PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT,
            failed: 0,
            hasMore: true,
        });
        expect(store.reconcileUsage).toHaveBeenCalledTimes(
            PREFLIGHT_PROVIDER_RECONCILIATION_BATCH_LIMIT
        );
    });

    it('bounds a stuck run read and retries the same candidate on the next sweep', async () => {
        vi.useFakeTimers();
        try {
            const candidate = row('running') as StoredPreflightProviderRun;
            const store = {
                listUnreconciled: vi.fn(async () => [candidate]),
                reconcileUsage: vi.fn(),
            };
            const get = vi.fn(() => new Promise<never>(() => undefined));
            const dependencies = {
                clientForSlot: () => ({ run: () => ({ get }) }),
            };

            const firstSweep = reconcileSettledPreflightProviderCosts(store, dependencies);
            await vi.advanceTimersByTimeAsync(PREFLIGHT_PROVIDER_RECONCILIATION_CALL_TIMEOUT_MS);
            await expect(firstSweep).resolves.toEqual({
                eligible: 1,
                finalized: 0,
                failed: 1,
                hasMore: false,
            });

            const secondSweep = reconcileSettledPreflightProviderCosts(store, dependencies);
            await vi.advanceTimersByTimeAsync(PREFLIGHT_PROVIDER_RECONCILIATION_CALL_TIMEOUT_MS);
            await expect(secondSweep).resolves.toEqual({
                eligible: 1,
                finalized: 0,
                failed: 1,
                hasMore: false,
            });

            expect(get).toHaveBeenCalledTimes(2);
            expect(store.reconcileUsage).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
