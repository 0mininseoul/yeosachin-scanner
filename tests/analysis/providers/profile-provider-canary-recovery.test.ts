import { describe, expect, it, vi } from 'vitest';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import { recoverExpiredProfileProviderCanaries } from '../../../lib/services/analysis/profile-provider-canary-recovery';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_TOKEN = '22222222-2222-4222-8222-222222222222';

function experiment(terminalReason: 'expired_waiting_for_repetition' | 'strict_failure'
    | 'completed' | 'aborted_by_operator' | 'verified_no_run'
    = 'expired_waiting_for_repetition') {
    return {
        sourceRequestId: SOURCE_REQUEST_ID,
        cleanupClaimToken: CLAIM_TOKEN,
        terminalReason,
    };
}

function storage(events: string[], label: string, failDelete = false) {
    let exists = true;
    return {
        get: vi.fn(async () => exists ? { id: label } : undefined),
        delete: vi.fn(async () => {
            events.push(`delete:${label}`);
            if (failDelete) throw new Error('delete failed');
            exists = false;
        }),
    };
}

function runClient(events: string[], runId: string, failDelete = false) {
    const storages = {
        kvs: storage(events, `${runId}:kvs`, failDelete),
        dataset: storage(events, `${runId}:dataset`),
        request_queue: storage(events, `${runId}:request_queue`),
    };
    return {
        keyValueStore: () => storages.kvs,
        dataset: () => storages.dataset,
        requestQueue: () => storages.request_queue,
    };
}

function sourceRuns() {
    return Array.from({ length: 8 }, (_, index) => ({
        runId: `SourceRun${String(index).padStart(8, '0')}`,
        credentialSlot: 'tertiary' as const,
    }));
}

describe('expired profile provider canary recovery', () => {
    it('claims a bounded page and verifies all three source and canary storages absent', async () => {
        const events: string[] = [];
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment()]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns(),
                canaryRuns: [{
                    repetition: 1 as const,
                    runId: 'CanaryRun12345678',
                    credentialSlot: 'primary' as const,
                    reservationToken: '33333333-3333-4333-8333-333333333333',
                }],
            })),
            markRunStorageClean: vi.fn(async input => {
                events.push(`mark:canary:${input.storage}`);
                return {} as never;
            }),
            markSourceStorageClean: vi.fn(async input => {
                events.push(`mark:source:${input.storage}`);
                return {} as never;
            }),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const clients = new Map<string, ReturnType<typeof runClient>>();
        const clientForSlot = vi.fn((slot: ApifyCredentialSlot) => ({
            run: (runId: string) => {
                const key = `${slot}:${runId}`;
                if (!clients.has(key)) clients.set(key, runClient(events, runId));
                return clients.get(key)!;
            },
        }));

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot,
            limit: 4,
        })).resolves.toEqual({ scanned: 1, finalized: 1, failed: 0 });
        expect(store.markSourceStorageClean).toHaveBeenCalledTimes(3);
        expect(store.markRunStorageClean).toHaveBeenCalledTimes(3);
        expect(store.completeExperimentCleanup).toHaveBeenCalledOnce();
        expect(events.filter(event => event.startsWith('delete:'))).toHaveLength(27);
        expect(JSON.stringify(events)).not.toMatch(/username|url|token/i);
    });

    it('treats already absent storage as clean without deleting it', async () => {
        const absent = { get: vi.fn(async () => undefined), delete: vi.fn() };
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment()]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns(),
                canaryRuns: [{
                    repetition: 1 as const,
                    runId: 'CanaryRun12345678',
                    credentialSlot: 'primary' as const,
                    reservationToken: '33333333-3333-4333-8333-333333333333',
                }],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const client = {
            run: () => ({
                keyValueStore: () => absent,
                dataset: () => absent,
                requestQueue: () => absent,
            }),
        };

        await recoverExpiredProfileProviderCanaries({ store, clientForSlot: () => client });
        expect(absent.delete).not.toHaveBeenCalled();
        expect(store.completeExperimentCleanup).toHaveBeenCalledOnce();
    });

    it('fails closed before marking cleanup when the source inventory is not exactly eight', async () => {
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment()]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns().slice(0, 7),
                canaryRuns: [],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const clientForSlot = vi.fn();

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot,
        })).resolves.toEqual({ scanned: 1, finalized: 0, failed: 1 });
        expect(clientForSlot).not.toHaveBeenCalled();
        expect(store.markSourceStorageClean).not.toHaveBeenCalled();
        expect(store.completeExperimentCleanup).not.toHaveBeenCalled();
    });

    it('fails closed before cleanup when the eight source run identities are not unique', async () => {
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment()]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: Array.from({ length: 8 }, () => ({
                    runId: 'SourceRun12345678', credentialSlot: 'tertiary' as const,
                })),
                canaryRuns: [],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const clientForSlot = vi.fn();

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot,
        })).resolves.toEqual({ scanned: 1, finalized: 0, failed: 1 });
        expect(clientForSlot).not.toHaveBeenCalled();
        expect(store.completeExperimentCleanup).not.toHaveBeenCalled();
    });

    it('leaves the experiment retryable when deletion or absence verification fails', async () => {
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment()]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns(),
                canaryRuns: [],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const client = { run: (runId: string) => runClient([], runId, true) };

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot: () => client,
        })).resolves.toEqual({ scanned: 1, finalized: 0, failed: 1 });
        expect(store.completeExperimentCleanup).not.toHaveBeenCalled();
    });

    it('accepts delete response loss only when a follow-up GET proves storage absent', async () => {
        let exists = true;
        const responseLost = {
            get: vi.fn(async () => exists ? { id: 'source:kvs' } : undefined),
            delete: vi.fn(async () => {
                exists = false;
                throw new Error('delete response lost');
            }),
        };
        const absent = { get: vi.fn(async () => undefined), delete: vi.fn() };
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment()]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns(),
                canaryRuns: [],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const client = {
            run: () => ({
                keyValueStore: () => responseLost,
                dataset: () => absent,
                requestQueue: () => absent,
            }),
        };

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot: () => client,
        })).resolves.toEqual({ scanned: 1, finalized: 1, failed: 0 });
        expect(responseLost.get).toHaveBeenCalledTimes(9);
        expect(store.completeExperimentCleanup).toHaveBeenCalledOnce();
    });

    it.each([
        'strict_failure', 'completed', 'aborted_by_operator',
    ] as const)('resumes partial %s cleanup through the cleanup-only client', async reason => {
        const alreadyAbsent = { get: vi.fn(async () => undefined), delete: vi.fn() };
        const events: string[] = [];
        const dataset = storage(events, 'source:dataset');
        const requestQueue = storage(events, 'source:request_queue');
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment(reason)]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns(),
                canaryRuns: [],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => ({} as never)),
        };
        const client = {
            run: () => ({
                keyValueStore: () => alreadyAbsent,
                dataset: () => dataset,
                requestQueue: () => requestQueue,
            }),
        };

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot: () => client,
        })).resolves.toEqual({ scanned: 1, finalized: 1, failed: 0 });
        expect(alreadyAbsent.delete).not.toHaveBeenCalled();
        expect(events.filter(event => event.startsWith('delete:'))).toHaveLength(2);
        expect(store.completeExperimentCleanup).toHaveBeenCalledOnce();
        expect('actor' in client).toBe(false);
        expect('start' in client).toBe(false);
    });

    it('deletes all source storage for verified-no-run without a canary Actor start', async () => {
        const events: string[] = [];
        const durable = {
            state: 'terminalizing',
            orderedSetHmac: 'a'.repeat(64) as string | null,
        };
        const store = {
            claimExpiredForCleanup: vi.fn(async () => [experiment('verified_no_run')]),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: sourceRuns(),
                canaryRuns: [],
            })),
            markRunStorageClean: vi.fn(async () => ({} as never)),
            markSourceStorageClean: vi.fn(async () => ({} as never)),
            completeExperimentCleanup: vi.fn(async () => {
                durable.state = 'experiment_terminal';
                durable.orderedSetHmac = null;
                return durable as never;
            }),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
        };
        const client = { run: (runId: string) => runClient(events, runId) };

        await expect(recoverExpiredProfileProviderCanaries({
            store,
            clientForSlot: () => client,
        })).resolves.toEqual({ scanned: 1, finalized: 1, failed: 0 });
        expect(events.filter(event => event.startsWith('delete:'))).toHaveLength(24);
        expect(store.markSourceStorageClean).toHaveBeenCalledTimes(3);
        expect(store.markRunStorageClean).not.toHaveBeenCalled();
        expect(store.completeExperimentCleanup).toHaveBeenCalledOnce();
        expect(durable).toEqual({ state: 'experiment_terminal', orderedSetHmac: null });
        expect(store.reserve).not.toHaveBeenCalled();
        expect(store.checkpointStarted).not.toHaveBeenCalled();
        expect('actor' in client).toBe(false);
        expect('start' in client).toBe(false);
    });

    it('starts zero Actors when no expired experiment is claimed', async () => {
        const store = {
            claimExpiredForCleanup: vi.fn(async () => []),
        };
        const clientForSlot = vi.fn();

        await expect(recoverExpiredProfileProviderCanaries({
            store: store as never,
            clientForSlot,
        })).resolves.toEqual({ scanned: 0, finalized: 0, failed: 0 });
        expect(clientForSlot).not.toHaveBeenCalled();
    });
});
