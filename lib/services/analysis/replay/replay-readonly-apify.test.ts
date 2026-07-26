import { describe, expect, it, vi } from 'vitest';
import {
    AnalysisV2ReplayReadError,
    readCompletedApifyDatasetOnce,
    type ReplayReadonlyApifyClient,
} from './replay-readonly-apify';

function client(pages: readonly { offset: number; count: number; total: number; items: unknown[] }[]): ReplayReadonlyApifyClient {
    return {
        resolveActorId: async () => 'canonicalActorId',
        run: runId => ({
            get: async () => ({
                id: runId,
                actId: 'canonicalActorId',
                status: 'SUCCEEDED',
                defaultDatasetId: 'dataset',
            }),
        }),
        dataset: () => ({ listItems: async ({ offset }) => {
            const page = pages.find(candidate => candidate.offset === offset);
            if (!page) throw new Error('missing page');
            return page;
        } }),
    };
}

describe('read-only Apify replay adapter', () => {
    it('only exposes GET/listItems and reads a stable bounded dataset once', async () => {
        const adapter = client([
            { offset: 0, count: 2, total: 3, items: [{ a: 1 }, { a: 2 }] },
            { offset: 2, count: 1, total: 3, items: [{ a: 3 }] },
        ]);
        await expect(readCompletedApifyDatasetOnce({
            client: adapter, runId: 'run00001', expected: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' },
            ledger: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' }, pageSize: 2,
        })).resolves.toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    });

    it('fails closed for non-terminal, identity drift, page drift, or duplicate dataset read', async () => {
        await expect(readCompletedApifyDatasetOnce({
            client: {
                ...client([{ offset: 0, count: 0, total: 0, items: [] }]),
                run: runId => ({
                    get: async () => ({
                        id: runId,
                        actId: 'canonicalActorId',
                        status: 'RUNNING',
                        defaultDatasetId: 'dataset',
                    }),
                }),
            },
            runId: 'run00001', expected: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' }, ledger: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' },
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_APIFY_RUN_NOT_SUCCEEDED');
        await expect(readCompletedApifyDatasetOnce({
            client: client([{ offset: 0, count: 1, total: 2, items: [{}] }]), runId: 'run00001',
            expected: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' }, ledger: { actorId: 'other/actor', credentialSlot: 'secondary', runId: 'run00001' },
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_PROVIDER_IDENTITY_MISMATCH');
        const state = new Set<string>();
        const input = { client: client([{ offset: 0, count: 0, total: 0, items: [] }]), runId: 'run00001', expected: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' }, ledger: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' }, readState: state };
        await readCompletedApifyDatasetOnce(input);
        await expect(readCompletedApifyDatasetOnce(input)).rejects.toThrow('ANALYSIS_V2_REPLAY_DUPLICATE_DATASET_READ');
    });

    it('does not surface provider messages in stable errors', () => {
        expect(new AnalysisV2ReplayReadError('ANALYSIS_V2_REPLAY_APIFY_DATASET_DRIFT').message)
            .toBe('ANALYSIS_V2_REPLAY_APIFY_DATASET_DRIFT');
    });

    it('fails closed before dataset access when the run Actor identity drifts', async () => {
        const listItems = vi.fn(async () => ({
            offset: 0,
            count: 0,
            total: 0,
            items: [],
        }));
        const adapter: ReplayReadonlyApifyClient = {
            resolveActorId: async actorSlug => {
                expect(actorSlug).toBe('actor/name');
                return 'canonicalActorId';
            },
            run: runId => ({
                get: async () => ({
                    id: runId,
                    actId: 'differentCanonicalActorId',
                    status: 'SUCCEEDED',
                    defaultDatasetId: 'dataset',
                }),
            }),
            dataset: () => ({ listItems }),
        };

        await expect(readCompletedApifyDatasetOnce({
            client: adapter,
            runId: 'run00001',
            expected: {
                actorId: 'actor/name',
                credentialSlot: 'secondary',
                runId: 'run00001',
            },
            ledger: {
                actorId: 'actor/name',
                credentialSlot: 'secondary',
                runId: 'run00001',
            },
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_PROVIDER_IDENTITY_MISMATCH');
        expect(listItems).not.toHaveBeenCalled();
    });

    it('rejects two different run identities that resolve to the same dataset', async () => {
        const state = new Set<string>();
        const sharedDatasetClient = client([{ offset: 0, count: 0, total: 0, items: [] }]);
        await readCompletedApifyDatasetOnce({
            client: sharedDatasetClient,
            runId: 'run00001',
            expected: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' },
            ledger: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00001' },
            readState: state,
        });
        await expect(readCompletedApifyDatasetOnce({
            client: sharedDatasetClient,
            runId: 'run00002',
            expected: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00002' },
            ledger: { actorId: 'actor/name', credentialSlot: 'secondary', runId: 'run00002' },
            readState: state,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_DUPLICATE_DATASET_READ');
    });
});
