import { describe, expect, it, vi } from 'vitest';
import { deleteAccountPermanently } from './account-deletion';

const accountId = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';

function deletionRpc() {
    return vi.fn(async (name: string) => ({
        data: name === 'begin_account_deletion_v1'
            ? { state: 'requested', objectKeys: ['v1/a.webp'] }
            : name === 'complete_account_deletion_v1'
                ? true
                : { state: 'database_purged' },
        error: null,
    }));
}

describe('account deletion canonical maintenance mirror', () => {
    it('mirrors every source transition only when the maintenance writer is enabled', async () => {
        const rpc = deletionRpc();
        const mirrorMaintenanceJob = vi.fn(async () => ({ status: 'mirrored' }));

        await deleteAccountPermanently(accountId, {
            rpc,
            deleteObject: vi.fn(async () => undefined),
            deleteAuthUser: vi.fn(async () => undefined),
            dualWrite: false,
            dualWriteMaintenance: true,
            mirrorMaintenanceJob,
        });

        expect(mirrorMaintenanceJob).toHaveBeenCalledTimes(3);
        expect(mirrorMaintenanceJob).toHaveBeenNthCalledWith(1, accountId);
        expect(mirrorMaintenanceJob).toHaveBeenNthCalledWith(2, accountId);
        expect(mirrorMaintenanceJob).toHaveBeenNthCalledWith(3, accountId);
    });

    it('keeps the legacy deletion flow authoritative when a mirror fails', async () => {
        const rpc = deletionRpc();
        const mirrorMaintenanceJob = vi.fn(async () => {
            throw new Error('mirror unavailable');
        });
        const queueMaintenanceJob = vi.fn(async () => ({ status: 'queued' }));
        const deleteAuthUser = vi.fn(async () => undefined);

        await deleteAccountPermanently(accountId, {
            rpc,
            deleteObject: vi.fn(async () => undefined),
            deleteAuthUser,
            dualWrite: false,
            dualWriteMaintenance: true,
            mirrorMaintenanceJob,
            queueMaintenanceJob,
        });

        expect(deleteAuthUser).toHaveBeenCalledOnce();
        expect(queueMaintenanceJob).toHaveBeenCalledTimes(3);
    });
});
