import { describe, expect, it, vi } from 'vitest';
import { createAccountDeletionCanonicalAdapter } from './account-deletion-canonical-adapter';

const accountId = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';

describe('account-deletion canonical wave adapter', () => {
    it('routes the transitional mirror RPC through an injected client', async () => {
        const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('mirror_account_deletion_job_v1');
            expect(params).toEqual({ p_account_id: accountId });
            return { data: { status: 'mirrored', duplicate: false }, error: null };
        });
        const adapter = createAccountDeletionCanonicalAdapter({
            rpc,
            environment: { COMMERCE_CANONICAL_MAINTENANCE_WRITE: 'true' },
        });

        await expect(adapter.mirrorMaintenanceJob(accountId)).resolves.toEqual({
            status: 'mirrored',
            duplicate: false,
        });
    });

    it('keeps the transitional mirror disabled by default without calling the RPC', async () => {
        const rpc = vi.fn(async () => ({ data: { status: 'mirrored' }, error: null }));
        const adapter = createAccountDeletionCanonicalAdapter({ rpc, environment: {} });

        await expect(adapter.mirrorMaintenanceJob(accountId)).rejects.toMatchObject({
            code: 'CANONICAL_MAINTENANCE_UNAVAILABLE',
        });
        expect(rpc).not.toHaveBeenCalled();
    });

});
