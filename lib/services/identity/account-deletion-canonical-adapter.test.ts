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

    it('runs only the bounded forward backfill RPC when the maintenance writer is enabled', async () => {
        const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('backfill_account_deletion_jobs_v1');
            expect(params).toEqual({
                p_limit: 100,
                p_cursor_hash: null,
            });
            return {
                data: {
                    schema_version: 'supabase-22-account-deletion-backfill-v1',
                    status: 'completed',
                    processed: 2,
                    mirrored: 1,
                    duplicates: 1,
                    blocked: 0,
                    has_more: false,
                    next_cursor_hash: null,
                },
                error: null,
            };
        });
        const adapter = createAccountDeletionCanonicalAdapter({
            rpc,
            environment: { COMMERCE_CANONICAL_MAINTENANCE_WRITE: 'true' },
        });

        await expect(adapter.backfillMaintenanceJobs()).resolves.toEqual({
            schema_version: 'supabase-22-account-deletion-backfill-v1',
            status: 'completed',
            processed: 2,
            mirrored: 1,
            duplicates: 1,
            blocked: 0,
            has_more: false,
            next_cursor_hash: null,
        });
    });

    it('collects aggregate parity through the read-only RPC without a write flag', async () => {
        const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('collect_account_deletion_parity_v1');
            expect(params).toEqual({});
            return {
                data: {
                    schema_version: 'supabase-22-account-deletion-parity-v1',
                    status: 'match',
                    source_count: 12,
                    canonical_count: 12,
                    source_checksum: 'a'.repeat(64),
                    canonical_checksum: 'a'.repeat(64),
                    mismatch_fields: [],
                },
                error: null,
            };
        });
        const adapter = createAccountDeletionCanonicalAdapter({ rpc, environment: {} });

        await expect(adapter.collectParity()).resolves.toEqual({
            schema_version: 'supabase-22-account-deletion-parity-v1',
            status: 'match',
            source_count: 12,
            canonical_count: 12,
            source_checksum: 'a'.repeat(64),
            canonical_checksum: 'a'.repeat(64),
            mismatch_fields: [],
        });
    });
});
