import { describe, expect, it, vi } from 'vitest';
import { createPrecheckoutBliteStore } from './blite-store';

const PREFLIGHT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function client(data: unknown, error: null | { code?: string } = null) {
    return { rpc: vi.fn().mockResolvedValue({ data, error }) };
}

describe('precheckoutBliteStore', () => {
    it('parses a claimed lease and sends the exact RPC input', async () => {
        const database = client({ disposition: 'claimed', leaseToken: LEASE });
        const store = createPrecheckoutBliteStore(database);
        await expect(store.claim({ preflightId: PREFLIGHT })).resolves.toEqual({
            disposition: 'claimed', leaseToken: LEASE,
        });
        expect(database.rpc).toHaveBeenCalledWith('claim_precheckout_blite_v1', {
            p_preflight_id: PREFLIGHT,
        });
    });

    it('parses pending and complete dispositions', async () => {
        const pending = createPrecheckoutBliteStore(client({ disposition: 'pending' }));
        await expect(pending.claim({ preflightId: PREFLIGHT })).resolves.toEqual({ disposition: 'pending' });

        const dto = { schemaVersion: 1 };
        const complete = createPrecheckoutBliteStore(client({ disposition: 'complete', dto }));
        await expect(complete.claim({ preflightId: PREFLIGHT })).resolves.toEqual({ disposition: 'complete', dto });
    });

    it('fails closed on malformed persistence responses', async () => {
        const store = createPrecheckoutBliteStore(client({ disposition: 'claimed', leaseToken: 'bad' }));
        await expect(store.claim({ preflightId: PREFLIGHT })).rejects.toThrow('PRECHECKOUT_BLITE_PERSISTENCE_ERROR');
    });

    it('completes and releases with the exact lease fence', async () => {
        const database = client(true);
        const store = createPrecheckoutBliteStore(database);
        const dto = { schemaVersion: 1 };
        await store.complete({ preflightId: PREFLIGHT, leaseToken: LEASE, dto });
        expect(database.rpc).toHaveBeenLastCalledWith('complete_precheckout_blite_v1', {
            p_preflight_id: PREFLIGHT,
            p_lease_token: LEASE,
            p_dto: dto,
        });
        await store.release({ preflightId: PREFLIGHT, leaseToken: LEASE });
        expect(database.rpc).toHaveBeenLastCalledWith('release_precheckout_blite_v1', {
            p_preflight_id: PREFLIGHT,
            p_lease_token: LEASE,
        });
    });
});
