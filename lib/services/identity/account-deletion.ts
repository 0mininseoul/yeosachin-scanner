import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { canonicalJsonHash } from '@/lib/services/commerce/canonical-commerce-store';
import {
    canonicalOperationsStore,
    isCanonicalFamilyWriteEnabled,
    maintenanceMarker,
    queueCanonicalMaintenanceJob,
    withCanonicalMirrorTimeout,
    type AccountLifecycleInput,
} from '@/lib/services/operations/canonical-operations-store';
import { accountDeletionCanonicalAdapter } from './account-deletion-canonical-adapter';
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
    dualWrite?: boolean;
    dualWriteMaintenance?: boolean;
    appendLifecycle?: (input: AccountLifecycleInput) => Promise<unknown>;
    queueMaintenanceJob?: (input: Parameters<typeof queueCanonicalMaintenanceJob>[0]) => Promise<unknown>;
    mirrorMaintenanceJob?: (accountId: string) => Promise<unknown>;
};

export class AccountDeletionError extends Error {
    constructor(readonly code:
        | 'ACCOUNT_DELETION_BEGIN_FAILED'
        | 'ACCOUNT_DELETION_RESULT_INVALID'
        | 'ACCOUNT_DELETION_OBJECT_PURGE_FAILED'
        | 'ACCOUNT_DELETION_DATABASE_PURGE_FAILED'
        | 'ACCOUNT_DELETION_AUTH_DELETE_FAILED'
        | 'ACCOUNT_DELETION_COMPLETION_FAILED'
        | 'ACCOUNT_DELETION_LIFECYCLE_UNAVAILABLE') {
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
    const dualWrite = dependencies.dualWrite ?? isCanonicalFamilyWriteEnabled('account');
    const dualWriteMaintenance = dependencies.dualWriteMaintenance
        ?? isCanonicalFamilyWriteEnabled('maintenance');
    const appendLifecycle = dependencies.appendLifecycle
        ?? canonicalOperationsStore.appendAccountLifecycle;
    const queueMaintenanceJob = dependencies.queueMaintenanceJob ?? queueCanonicalMaintenanceJob;
    const mirrorMaintenanceJob = dependencies.mirrorMaintenanceJob
        ?? accountDeletionCanonicalAdapter.mirrorMaintenanceJob;
    const recordLifecycle = async (
        eventKind: AccountLifecycleInput['eventKind'],
        state: string,
        payload: Record<string, unknown> = {},
    ): Promise<void> => {
        if (!dualWrite) return;
        const input: AccountLifecycleInput = {
            accountId: id,
            eventKind,
            state,
            payload,
            contentHash: canonicalJsonHash(`account-lifecycle:${eventKind}`, {
                account_id: id,
                state,
                ...payload,
            }),
        };
        try {
            await withCanonicalMirrorTimeout(() => appendLifecycle(input));
        } catch {
            try {
                await withCanonicalMirrorTimeout(() => queueMaintenanceJob(
                    maintenanceMarker('recovery', id, `account:${eventKind}`),
                ));
            } catch {
                // The recovery marker is best effort; no irreversible action may
                // proceed until the lifecycle evidence write itself succeeds.
            }
            throw new AccountDeletionError('ACCOUNT_DELETION_LIFECYCLE_UNAVAILABLE');
        }
    };
    const mirrorSourceJob = async (): Promise<void> => {
        if (!dualWriteMaintenance) return;
        try {
            await withCanonicalMirrorTimeout(() => mirrorMaintenanceJob(id));
        } catch {
            try {
                await withCanonicalMirrorTimeout(() => queueMaintenanceJob(
                    maintenanceMarker('recovery', id, 'account-deletion-maintenance-mirror'),
                ));
            } catch {
                // The legacy deletion job remains authoritative while the
                // canonical mirror is unavailable. No fallback is destructive.
            }
        }
    };
    await recordLifecycle('deletion_requested', 'started:begin', { phase: 'begin' });
    const begin = await rpc('begin_account_deletion_v1', { p_account_id: id });
    if (begin.error) throw new AccountDeletionError('ACCOUNT_DELETION_BEGIN_FAILED');
    const parsed = beginResultSchema.safeParse(begin.data);
    if (!parsed.success) throw new AccountDeletionError('ACCOUNT_DELETION_RESULT_INVALID');
    await mirrorSourceJob();
    await recordLifecycle('deletion_requested', 'completed:begin', {
        phase: 'begin',
        state: parsed.data.state,
    });

    if (parsed.data.state === 'completed') {
        // begin_account_deletion_v1 may have completed all irreversible work
        // during an earlier attempt. The canonical lifecycle still needs an
        // explicit terminal marker before this replay returns.
        await recordLifecycle('retired', 'completed:completion', {
            phase: 'completion',
            resumed: true,
            completed_at_begin: true,
        });
        return;
    }

    if (parsed.data.state !== 'database_purged') {
        await recordLifecycle('deletion_requested', 'prepared:objects', {
            phase: 'objects',
            object_count: parsed.data.objectKeys.length,
        });
        let deleteObject = dependencies.deleteObject;
        if (!deleteObject && parsed.data.objectKeys.length > 0) {
            const writer = createResultImageR2Writer(loadResultImageR2Config(process.env));
            deleteObject = (key) => writer.delete(key);
        }
        try {
            for (const [index, objectKey] of parsed.data.objectKeys.entries()) {
                const objectKeyHash = canonicalJsonHash('account-delete-object', objectKey);
                await recordLifecycle('objects_purged', `prepared:object:${index}`, {
                    phase: 'object',
                    index,
                    object_key_hash: objectKeyHash,
                });
                await recordLifecycle('objects_purged', `started:object:${index}`, {
                    phase: 'object',
                    index,
                    object_key_hash: objectKeyHash,
                });
                if (!deleteObject) throw new Error('missing object writer');
                await deleteObject(objectKey);
                await recordLifecycle('objects_purged', `completed:object:${index}`, {
                    phase: 'object',
                    index,
                    object_key_hash: objectKeyHash,
                });
            }
        } catch (error) {
            if (
                error instanceof AccountDeletionError
                && error.code === 'ACCOUNT_DELETION_LIFECYCLE_UNAVAILABLE'
            ) {
                throw error;
            }
            throw new AccountDeletionError('ACCOUNT_DELETION_OBJECT_PURGE_FAILED');
        }

        await recordLifecycle('database_purged', 'prepared:database', {
            phase: 'database',
            object_count: parsed.data.objectKeys.length,
        });
        await recordLifecycle('database_purged', 'started:database', {
            phase: 'database',
            object_count: parsed.data.objectKeys.length,
        });
        const finalized = await rpc('finalize_account_deletion_database_v1', {
            p_account_id: id,
            p_deleted_object_keys: parsed.data.objectKeys,
        });
        if (finalized.error) {
            throw new AccountDeletionError('ACCOUNT_DELETION_DATABASE_PURGE_FAILED');
        }
        await mirrorSourceJob();
        await recordLifecycle('database_purged', 'completed:database', {
            phase: 'database',
            object_count: parsed.data.objectKeys.length,
        });
    } else {
        await recordLifecycle('database_purged', 'prepared:database', {
            phase: 'database',
            resumed: true,
        });
        await recordLifecycle('database_purged', 'completed:database', {
            phase: 'database',
            resumed: true,
        });
    }

    await recordLifecycle('retired', 'prepared:auth', { phase: 'auth' });
    await recordLifecycle('retired', 'started:auth', { phase: 'auth' });
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

    await recordLifecycle('retired', 'completed:auth', { phase: 'auth' });
    await recordLifecycle('retired', 'prepared:completion', { phase: 'completion' });
    await recordLifecycle('retired', 'started:completion', { phase: 'completion' });
    const completed = await rpc('complete_account_deletion_v1', { p_account_id: id });
    if (completed.error || completed.data !== true) {
        throw new AccountDeletionError('ACCOUNT_DELETION_COMPLETION_FAILED');
    }
    await mirrorSourceJob();
    await recordLifecycle('retired', 'completed:completion', { phase: 'completion' });
}
