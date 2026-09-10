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
    backfillMaintenanceJobs(input?: AccountDeletionBackfillInput): Promise<AccountDeletionBackfillResult>;
    collectParity(): Promise<AccountDeletionParityResult>;
}>;

const accountIdSchema = z.string().uuid().transform(value => value.toLowerCase());
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const operationResultSchema = z.object({
    status: z.string().min(1),
    duplicate: z.boolean().optional(),
}).passthrough();
const backfillInputSchema = z.object({
    limit: z.number().int().min(1).max(100).optional().default(100),
    cursorHash: hashSchema.nullable().optional().default(null),
}).strict();
const aggregateCountSchema = z.preprocess(
    value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().nonnegative(),
);
const boundedAggregateCountSchema = z.preprocess(
    value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().nonnegative().max(100),
);
const backfillResultSchema = z.object({
    schema_version: z.literal('supabase-22-account-deletion-backfill-v1'),
    status: z.enum(['completed', 'blocked']),
    processed: boundedAggregateCountSchema,
    mirrored: boundedAggregateCountSchema,
    duplicates: boundedAggregateCountSchema,
    blocked: boundedAggregateCountSchema,
    has_more: z.boolean(),
    next_cursor_hash: hashSchema.nullable(),
}).strict();
const parityResultSchema = z.object({
    schema_version: z.literal('supabase-22-account-deletion-parity-v1'),
    status: z.enum(['match', 'mismatch']),
    source_count: aggregateCountSchema,
    canonical_count: aggregateCountSchema,
    source_checksum: hashSchema.nullable(),
    canonical_checksum: hashSchema.nullable(),
    mismatch_fields: z.array(z.string().min(1).max(64)).max(16),
}).strict();

export type AccountDeletionBackfillInput = Readonly<{
    limit?: number;
    cursorHash?: string | null;
}>;

export type AccountDeletionBackfillResult = z.infer<typeof backfillResultSchema>;
export type AccountDeletionParityResult = z.infer<typeof parityResultSchema>;

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
        async backfillMaintenanceJobs(input: AccountDeletionBackfillInput = {}) {
            if (!isCanonicalFamilyWriteEnabled('maintenance', environment)) {
                throw new CanonicalOperationsError('CANONICAL_MAINTENANCE_UNAVAILABLE');
            }
            const parsedInput = backfillInputSchema.safeParse(input);
            if (!parsedInput.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
            }
            let result: { data: unknown; error: unknown };
            try {
                result = await rpc(
                    'backfill_account_deletion_jobs_v1',
                    {
                        p_limit: parsedInput.data.limit,
                        p_cursor_hash: parsedInput.data.cursorHash,
                    },
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
            const parsedResult = backfillResultSchema.safeParse(result.data);
            if (!parsedResult.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(parsedResult.data);
        },
        async collectParity() {
            let result: { data: unknown; error: unknown };
            try {
                result = await rpc('collect_account_deletion_parity_v1', {});
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
            const parsedResult = parityResultSchema.safeParse(result.data);
            if (!parsedResult.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(parsedResult.data);
        },
    });
}

export const accountDeletionCanonicalAdapter = createAccountDeletionCanonicalAdapter();
