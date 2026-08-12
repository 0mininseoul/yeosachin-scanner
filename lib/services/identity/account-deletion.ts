import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    createResultImageR2Writer,
    loadResultImageR2Config,
} from '@/lib/services/media/r2-result-image-store';

const beginResultSchema = z.object({
    state: z.enum(['requested', 'objects_purged', 'database_purged', 'completed']),
    objectKeys: z.array(z.string().min(1).max(512)).max(50001),
}).strict();

type RpcResult = Promise<{ data: unknown; error: unknown }>;
type Dependencies = {
    rpc?: (name: string, params: Record<string, unknown>) => RpcResult;
    deleteObject?: (objectKey: string) => Promise<void>;
    deleteAuthUser?: (accountId: string) => Promise<void>;
};

export class AccountDeletionError extends Error {
    constructor(readonly code:
        | 'ACCOUNT_DELETION_BEGIN_FAILED'
        | 'ACCOUNT_DELETION_RESULT_INVALID'
        | 'ACCOUNT_DELETION_OBJECT_PURGE_FAILED'
        | 'ACCOUNT_DELETION_DATABASE_PURGE_FAILED'
        | 'ACCOUNT_DELETION_AUTH_DELETE_FAILED'
        | 'ACCOUNT_DELETION_COMPLETION_FAILED') {
        super(code);
        this.name = 'AccountDeletionError';
    }
}

export async function deleteAccountPermanently(
    accountId: string,
    dependencies: Dependencies = {},
): Promise<void> {
    const id = z.string().uuid().parse(accountId);
    const rpc = dependencies.rpc ?? ((name, params) => supabaseAdmin.rpc(name, params));
    const begin = await rpc('begin_account_deletion_v1', { p_account_id: id });
    if (begin.error) throw new AccountDeletionError('ACCOUNT_DELETION_BEGIN_FAILED');
    const parsed = beginResultSchema.safeParse(begin.data);
    if (!parsed.success) throw new AccountDeletionError('ACCOUNT_DELETION_RESULT_INVALID');

    if (parsed.data.state === 'completed') return;

    if (parsed.data.state !== 'database_purged') {
        let deleteObject = dependencies.deleteObject;
        if (!deleteObject && parsed.data.objectKeys.length > 0) {
            const writer = createResultImageR2Writer(loadResultImageR2Config(process.env));
            deleteObject = (key) => writer.delete(key);
        }
        try {
            for (const objectKey of parsed.data.objectKeys) {
                if (!deleteObject) throw new Error('missing object writer');
                await deleteObject(objectKey);
            }
        } catch {
            throw new AccountDeletionError('ACCOUNT_DELETION_OBJECT_PURGE_FAILED');
        }

        const finalized = await rpc('finalize_account_deletion_database_v1', {
            p_account_id: id,
            p_deleted_object_keys: parsed.data.objectKeys,
        });
        if (finalized.error) {
            throw new AccountDeletionError('ACCOUNT_DELETION_DATABASE_PURGE_FAILED');
        }
    }

    try {
        if (dependencies.deleteAuthUser) {
            await dependencies.deleteAuthUser(id);
        } else {
            const { error } = await supabaseAdmin.auth.admin.deleteUser(id, false);
            if (error) throw error;
        }
    } catch {
        throw new AccountDeletionError('ACCOUNT_DELETION_AUTH_DELETE_FAILED');
    }

    const completed = await rpc('complete_account_deletion_v1', { p_account_id: id });
    if (completed.error || completed.data !== true) {
        throw new AccountDeletionError('ACCOUNT_DELETION_COMPLETION_FAILED');
    }
}
