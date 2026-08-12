import { describe, expect, it, vi } from 'vitest';
import { deleteAccountPermanently } from './account-deletion';

describe('deleteAccountPermanently', () => {
    it('purges every result object before database and Auth deletion', async () => {
        const calls: string[] = [];
        const rpc = vi.fn(async (name: string) => {
            calls.push(`rpc:${name}`);
            if (name === 'begin_account_deletion_v1') {
                return { data: { state: 'requested', objectKeys: ['v1/a.webp', 'v1/b.webp'] }, error: null };
            }
            return { data: name === 'complete_account_deletion_v1' ? true : { state: 'database_purged' }, error: null };
        });

        await deleteAccountPermanently('6d809496-1cb8-4e4f-a081-8efc14a7a64c', {
            rpc,
            deleteObject: vi.fn(async (key: string) => { calls.push(`object:${key}`); }),
            deleteAuthUser: vi.fn(async () => { calls.push('auth'); }),
        });

        expect(calls).toEqual([
            'rpc:begin_account_deletion_v1',
            'object:v1/a.webp',
            'object:v1/b.webp',
            'rpc:finalize_account_deletion_database_v1',
            'auth',
            'rpc:complete_account_deletion_v1',
        ]);
        expect(rpc).toHaveBeenNthCalledWith(2, 'finalize_account_deletion_database_v1', {
            p_account_id: '6d809496-1cb8-4e4f-a081-8efc14a7a64c',
            p_deleted_object_keys: ['v1/a.webp', 'v1/b.webp'],
        });
    });

    it('does not finalize or delete Auth when an object purge fails', async () => {
        const rpc = vi.fn(async () => ({
            data: { state: 'requested', objectKeys: ['v1/a.webp'] },
            error: null,
        }));
        const deleteAuthUser = vi.fn();

        await expect(deleteAccountPermanently('6d809496-1cb8-4e4f-a081-8efc14a7a64c', {
            rpc,
            deleteObject: vi.fn(async () => { throw new Error('secret provider body'); }),
            deleteAuthUser,
        })).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_OBJECT_PURGE_FAILED' });

        expect(rpc).toHaveBeenCalledTimes(1);
        expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it('resumes database-purged work without touching objects again', async () => {
        const rpc = vi.fn(async (name: string) => ({
            data: name === 'begin_account_deletion_v1'
                ? { state: 'database_purged', objectKeys: [] }
                : true,
            error: null,
        }));
        const deleteObject = vi.fn();
        const deleteAuthUser = vi.fn();

        await deleteAccountPermanently('6d809496-1cb8-4e4f-a081-8efc14a7a64c', {
            rpc,
            deleteObject,
            deleteAuthUser,
        });

        expect(deleteObject).not.toHaveBeenCalled();
        expect(deleteAuthUser).toHaveBeenCalledOnce();
    });
});
