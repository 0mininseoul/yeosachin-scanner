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

    it('records completion lifecycle evidence before returning for an already-completed begin result', async () => {
        const lifecycle: string[] = [];
        const rpc = vi.fn(async (name: string) => ({
            data: name === 'begin_account_deletion_v1'
                ? { state: 'completed', objectKeys: [] }
                : true,
            error: null,
        }));
        const appendLifecycle = vi.fn(async input => {
            lifecycle.push(`${input.eventKind}:${input.state}`);
        });

        await deleteAccountPermanently('6d809496-1cb8-4e4f-a081-8efc14a7a64c', {
            rpc,
            dualWrite: true,
            appendLifecycle,
            deleteObject: vi.fn(),
            deleteAuthUser: vi.fn(),
        });

        expect(lifecycle).toEqual([
            'deletion_requested:started:begin',
            'deletion_requested:completed:begin',
            'retired:completed:completion',
        ]);
        expect(appendLifecycle).toHaveBeenCalledTimes(3);
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('appends lifecycle evidence before each irreversible deletion phase', async () => {
        const lifecycle: string[] = [];
        const rpc = vi.fn(async (name: string) => ({
            data: name === 'begin_account_deletion_v1'
                ? { state: 'requested', objectKeys: ['v1/a.webp'] }
                : name === 'complete_account_deletion_v1'
                    ? true
                    : { state: 'database_purged' },
            error: null,
        }));

        await deleteAccountPermanently('6d809496-1cb8-4e4f-a081-8efc14a7a64c', {
            rpc,
            deleteObject: vi.fn(async () => undefined),
            deleteAuthUser: vi.fn(async () => undefined),
            dualWrite: true,
            appendLifecycle: vi.fn(async input => {
                lifecycle.push(`${input.eventKind}:${input.state}`);
            }),
        });

        expect(lifecycle).toEqual([
            'deletion_requested:started:begin',
            'deletion_requested:completed:begin',
            'deletion_requested:prepared:objects',
            'objects_purged:prepared:object:0',
            'objects_purged:started:object:0',
            'objects_purged:completed:object:0',
            'database_purged:prepared:database',
            'database_purged:started:database',
            'database_purged:completed:database',
            'retired:prepared:auth',
            'retired:started:auth',
            'retired:completed:auth',
            'retired:prepared:completion',
            'retired:started:completion',
            'retired:completed:completion',
        ]);
    });

    it('stops before the first irreversible step when lifecycle evidence is unavailable', async () => {
        const rpc = vi.fn(async () => ({
            data: { state: 'requested', objectKeys: ['v1/a.webp'] },
            error: null,
        }));
        const deleteObject = vi.fn();
        const appendLifecycle = vi.fn(async () => {
            throw new Error('canonical lifecycle unavailable');
        });

        await expect(deleteAccountPermanently('6d809496-1cb8-4e4f-a081-8efc14a7a64c', {
            rpc,
            deleteObject,
            deleteAuthUser: vi.fn(),
            dualWrite: true,
            appendLifecycle,
        })).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_LIFECYCLE_UNAVAILABLE' });

        expect(rpc).not.toHaveBeenCalled();
        expect(deleteObject).not.toHaveBeenCalled();
    });
});
