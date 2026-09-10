import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    CanonicalOperationsError,
    isCanonicalFamilyWriteEnabled,
} from '@/lib/services/operations/canonical-operations-store';

type Rpc = (
    name: string,
    params: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export type AccountDeletionCanonicalAdapter = Readonly<{
    mirrorMaintenanceJob(accountId: string): Promise<Readonly<Record<string, unknown>>>;
}>;

const accountIdSchema = z.string().uuid().transform(value => value.toLowerCase());
const operationResultSchema = z.object({
    status: z.string().min(1),
    duplicate: z.boolean().optional(),
}).passthrough();

export function createAccountDeletionCanonicalAdapter(
    dependencies: {
        rpc?: Rpc;
        environment?: Record<string, string | undefined>;
    } = {},
): AccountDeletionCanonicalAdapter {
    const rpc = dependencies.rpc ?? ((name, params) => supabaseAdmin.rpc(name, params));
    const environment = dependencies.environment ?? process.env;

    return Object.freeze({
        async mirrorMaintenanceJob(accountId: string) {
            if (!isCanonicalFamilyWriteEnabled('maintenance', environment)) {
                throw new CanonicalOperationsError('CANONICAL_MAINTENANCE_UNAVAILABLE');
            }
            const parsed = accountIdSchema.safeParse(accountId);
            if (!parsed.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
            }
            let result: { data: unknown; error: unknown };
            try {
                result = await rpc(
                    'mirror_account_deletion_job_v1',
                    { p_account_id: parsed.data },
                );
            } catch (error) {
                throw new CanonicalOperationsError(
                    'CANONICAL_OPERATIONS_RPC_FAILED',
                    error,
                );
            }
            if (result.error) {
                throw new CanonicalOperationsError(
                    'CANONICAL_OPERATIONS_RPC_FAILED',
                    result.error,
                );
            }
            const parsedResult = operationResultSchema.safeParse(result.data);
            if (!parsedResult.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(parsedResult.data);
        },
    });
}

export const accountDeletionCanonicalAdapter = createAccountDeletionCanonicalAdapter();
