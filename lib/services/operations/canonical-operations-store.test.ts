import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJsonHash } from '@/lib/services/commerce/canonical-commerce-store';
import {
    CANONICAL_MIRROR_TIMEOUT_MS,
    createCanonicalOperationsStore,
    isCanonicalFamilyWriteEnabled,
    rollbackCanonicalFlags,
    shadowCompareCanonicalFamily,
    isCanonicalFamilyReadEnabled,
    rollbackCanonicalReadFlags,
    shadowReadCanonicalNotificationOutbox,
    withCanonicalMirrorTimeout,
} from './canonical-operations-store';

function migrationSql(): string {
    const migration = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_add_commerce_operation_canonical_tables.sql'))
        .sort();
    if (migration.length !== 1) {
        throw new Error(
            `Expected one generated commerce migration, found ${migration.length}`,
        );
    }
    return readFileSync(
        join(process.cwd(), 'supabase/migrations', migration[0]),
        'utf8',
    );
}

function accountDeletionMigrationSql(): string {
    const migration = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_prepare_account_deletion_canonical_wave.sql'))
        .sort();
    if (migration.length !== 1) {
        throw new Error(
            `Expected one account-deletion canonical migration, found ${migration.length}`,
        );
    }
    return readFileSync(
        join(process.cwd(), 'supabase/migrations', migration[0]),
        'utf8',
    );
}

describe('operations canonical migration contract', () => {
    it('adds bounded recovery indexes and lease fence columns', () => {
        const sql = migrationSql();
        expect(sql).toContain('CREATE INDEX fulfillment_jobs_recovery_idx');
        expect(sql).toContain('CREATE INDEX notification_outbox_delivery_idx');
        expect(sql).toContain('CREATE INDEX account_lifecycle_account_recorded_idx');
        expect(sql).toContain('CREATE INDEX system_configuration_effective_idx');
        expect(sql).toContain('CREATE INDEX system_leases_expiry_idx');
        expect(sql).toContain('CREATE INDEX maintenance_jobs_recovery_idx');
        expect(sql).toContain('lease_generation BIGINT NOT NULL DEFAULT 0');
        expect(sql).toContain('fence_token BIGINT NOT NULL DEFAULT 0');
        expect(sql).toContain('claim_notification_outbox_v1');
        expect(sql).toContain('finish_notification_outbox_v1');
        expect(sql).toContain('claim_maintenance_jobs_v1');
        expect(sql).toContain('finish_maintenance_job_v1');
        expect(sql).toContain('NOTIFICATION_DEDUPE_CONTENT_CONFLICT');
        expect(sql).toContain('MAINTENANCE_CONTENT_CONFLICT');
        expect(sql).toContain('FULFILLMENT_JOB_FENCE_CONFLICT');
        expect(sql).toContain('FULFILLMENT_JOB_MONOTONIC_CONFLICT');
    });

    it('uses bounded service-only RPCs for operations writes', () => {
        const sql = migrationSql();
        for (const functionName of [
            'upsert_fulfillment_job_v1',
            'enqueue_notification_v1',
            'append_account_lifecycle_v1',
            'record_system_configuration_v1',
            'acquire_system_lease_v1',
            'enqueue_maintenance_job_v1',
        ]) {
            expect(sql).toContain(`CREATE FUNCTION public.${functionName}`);
            expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${functionName}`);
            expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}`);
        }
    });

    it('keeps claims bounded and fenced at the SQL boundary', () => {
        const sql = migrationSql();
        expect(sql).toContain('FOR UPDATE SKIP LOCKED');
        expect(sql).toContain('lease_generation = notification.lease_generation + 1');
        expect(sql).toContain('p_lease_generation');
        expect(sql).toContain('p_retry_after_seconds');
        expect(sql).toContain("p_outcome NOT IN ('sent', 'retryable', 'dead')");
        expect(sql).toContain("p_outcome NOT IN ('succeeded', 'retryable', 'blocked')");
    });

    it('keeps account-deletion mapping additive and source-authoritative', () => {
        const sql = accountDeletionMigrationSql();
        expect(sql).toContain('CREATE FUNCTION public.mirror_account_deletion_job_v1');
        expect(sql).toContain('public.account_deletion_jobs');
        expect(sql).toContain('public.maintenance_jobs');
        expect(sql).toContain("'source_table'");
        expect(sql).toContain("'source_key_hash'");
        expect(sql).toContain("'legacy_state'");
        expect(sql).toContain('ACCOUNT_DELETION_SOURCE_REGRESSION');
        expect(sql).toContain('SET search_path = \'\'');
        expect(sql).toContain('FOR SHARE');
        expect(sql).toContain('ON CONFLICT (kind, target_key_hash) DO NOTHING');
        expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.mirror_account_deletion_job_v1');
        expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.mirror_account_deletion_job_v1');
        expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|FUNCTION)\b|\bTRUNCATE\b|\bDELETE\s+FROM\s+public\.account_deletion_jobs\b/i);
    });
});

describe('canonical operations store', () => {
    it('dedupes notifications and preserves lease fences through typed RPCs', async () => {
        const rpc = async (name: string, params: Record<string, unknown>) => {
            if (name === 'enqueue_notification_v1') {
                expect(params).toEqual({
                    p_channel: 'discord',
                    p_event_kind: 'payment.completed',
                    p_dedupe_key: 'payment:event-1',
                    p_payload: {},
                    p_content_hash: 'c'.repeat(64),
                });
                return { data: { status: 'queued', duplicate: true }, error: null };
            }
            expect(name).toBe('acquire_system_lease_v1');
            expect(params).toEqual({
                p_lease_key: 'provider:groble',
                p_kind: 'provider',
                p_holder_hash: 'd'.repeat(64),
                p_lease_seconds: 60,
            });
            return {
                data: {
                    acquired: true,
                    generation: 2,
                    fence_token: 3,
                    lease_expires_at: '2026-09-09T00:01:00.000Z',
                },
                error: null,
            };
        };
        const store = createCanonicalOperationsStore({ rpc });

        await expect(store.enqueueNotification({
            channel: 'discord',
            eventKind: 'payment.completed',
            dedupeKey: 'payment:event-1',
            contentHash: 'c'.repeat(64),
        })).resolves.toEqual({ status: 'queued', duplicate: true });
        await expect(store.acquireSystemLease({
            leaseKey: 'provider:groble',
            kind: 'provider',
            holderHash: 'd'.repeat(64),
            leaseSeconds: 60,
        })).resolves.toMatchObject({ acquired: true, generation: 2, fenceToken: 3 });
    });

    it('records immutable configuration versions through a typed service RPC', async () => {
        const config = { maxAttempts: 3 };
        const rpc = async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('record_system_configuration_v1');
            expect(params).toEqual({
                p_config_key: 'analysis.policy',
                p_version: 3,
                p_state: 'draft',
                p_config: config,
                p_content_hash: canonicalJsonHash('system-configuration', config),
                p_effective_at: null,
            });
            return { data: { status: 'recorded', duplicate: false }, error: null };
        };
        const store = createCanonicalOperationsStore({ rpc });

        await expect(store.recordSystemConfiguration({
            configKey: 'analysis.policy',
            version: 3,
            state: 'draft',
            config,
            contentHash: canonicalJsonHash('system-configuration', config),
            effectiveAt: null,
        })).resolves.toEqual({ status: 'recorded', duplicate: false });
    });

    it('mirrors an account deletion source row through a typed service RPC', async () => {
        const accountId = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';
        const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('mirror_account_deletion_job_v1');
            expect(params).toEqual({ p_account_id: accountId });
            return { data: { status: 'mirrored', duplicate: false }, error: null };
        });
        const store = createCanonicalOperationsStore({ rpc });

        await expect(store.mirrorAccountDeletionJob(accountId)).resolves.toEqual({
            status: 'mirrored',
            duplicate: false,
        });
    });

    it('rejects empty or non-derived configuration content hashes before the RPC', async () => {
        const rpc = vi.fn(async () => ({ data: { status: 'recorded' }, error: null }));
        const store = createCanonicalOperationsStore({ rpc });

        await expect(store.recordSystemConfiguration({
            configKey: 'analysis.policy',
            version: 4,
            state: 'draft',
            config: {},
            contentHash: 'a'.repeat(64),
            effectiveAt: null,
        })).rejects.toMatchObject({ code: 'CANONICAL_OPERATIONS_INPUT_INVALID' });
        await expect(store.recordSystemConfiguration({
            configKey: 'analysis.policy',
            version: 5,
            state: 'draft',
            config: { maxAttempts: 3 },
            contentHash: 'a'.repeat(64),
            effectiveAt: null,
        })).rejects.toMatchObject({ code: 'CANONICAL_OPERATIONS_INPUT_INVALID' });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('keeps all canonical family reads disabled until explicitly enabled', () => {
        expect(isCanonicalFamilyReadEnabled('payment', {})).toBe(false);
        expect(isCanonicalFamilyReadEnabled('maintenance', {
            COMMERCE_CANONICAL_MAINTENANCE_READ: 'true',
        })).toBe(true);
        expect(isCanonicalFamilyReadEnabled('maintenance', {
            COMMERCE_CANONICAL_MAINTENANCE_READ: 'TRUE',
        })).toBe(false);
    });

    it('uses independent writer flags instead of one global switch', () => {
        expect(isCanonicalFamilyWriteEnabled('payment', {})).toBe(false);
        expect(isCanonicalFamilyWriteEnabled('payment', {
            COMMERCE_CANONICAL_PAYMENT_WRITE: 'true',
        })).toBe(true);
        expect(isCanonicalFamilyWriteEnabled('notification', {
            COMMERCE_CANONICAL_PAYMENT_WRITE: 'true',
        })).toBe(false);
    });

    it('provides a fail-closed rollback environment for every family read flag', () => {
        const rolledBack = rollbackCanonicalReadFlags({
            COMMERCE_CANONICAL_PAYMENT_READ: 'true',
            COMMERCE_CANONICAL_FULFILLMENT_READ: 'true',
            COMMERCE_CANONICAL_NOTIFICATION_READ: 'true',
            COMMERCE_CANONICAL_ACCOUNT_READ: 'true',
            COMMERCE_CANONICAL_CONFIG_READ: 'true',
            COMMERCE_CANONICAL_LEASE_READ: 'true',
            COMMERCE_CANONICAL_MAINTENANCE_READ: 'true',
        });
        expect(Object.values(rolledBack)).toEqual(expect.arrayContaining([
            'false',
        ]));
        expect(isCanonicalFamilyReadEnabled('payment', rolledBack)).toBe(false);
        expect(isCanonicalFamilyReadEnabled('maintenance', rolledBack)).toBe(false);
    });

    it('rolls back every family read and writer flag independently', () => {
        const rolledBack = rollbackCanonicalFlags({
            COMMERCE_CANONICAL_PAYMENT_READ: 'true',
            COMMERCE_CANONICAL_PAYMENT_WRITE: 'true',
            COMMERCE_CANONICAL_NOTIFICATION_READ: 'true',
            COMMERCE_CANONICAL_NOTIFICATION_WRITE: 'true',
        });
        expect(isCanonicalFamilyReadEnabled('payment', rolledBack)).toBe(false);
        expect(isCanonicalFamilyWriteEnabled('payment', rolledBack)).toBe(false);
        expect(isCanonicalFamilyReadEnabled('notification', rolledBack)).toBe(false);
        expect(isCanonicalFamilyWriteEnabled('notification', rolledBack)).toBe(false);
    });

    it('does not perform a shadow comparison while a family reader is disabled', async () => {
        const legacy = vi.fn(async () => [{ key: 'legacy', fields: { state: 'queued' } }]);
        const canonical = vi.fn(async () => [{ key: 'canonical', fields: { state: 'queued' } }]);

        await expect(shadowCompareCanonicalFamily(
            'notification', legacy, canonical, 100, {},
        )).resolves.toEqual({ status: 'disabled', compared: 0 });
        expect(legacy).not.toHaveBeenCalled();
        expect(canonical).not.toHaveBeenCalled();
    });

    it('reports bounded field-level shadow mismatches without record values', async () => {
        const result = await shadowCompareCanonicalFamily(
            'notification',
            async () => [{ key: 'one', fields: { state: 'queued', attempt_count: 1 } }],
            async () => [{ key: 'one', fields: { state: 'sent', attempt_count: 1 } }],
            100,
            { COMMERCE_CANONICAL_NOTIFICATION_READ: 'true' },
        );
        expect(result).toEqual(expect.objectContaining({
            status: 'mismatch',
            compared: 1,
            mismatchedFields: ['state'],
        }));
        expect(JSON.stringify(result)).not.toContain('queued');
        expect(JSON.stringify(result)).not.toContain('sent');
    });

    it('compares both tails and fails closed when either bounded reader is truncated', async () => {
        await expect(shadowCompareCanonicalFamily(
            'notification',
            async () => [{ key: 'one', fields: { content_hash: 'a' } }],
            async () => [{ key: 'one', fields: { content_hash: 'a' } }, { key: 'two', fields: { content_hash: 'b' } }],
            100,
            { COMMERCE_CANONICAL_NOTIFICATION_READ: 'true' },
        )).resolves.toEqual(expect.objectContaining({
            status: 'mismatch',
            mismatchedFields: expect.arrayContaining(['missing_record', 'record_count']),
        }));

        const rows = Array.from({ length: 101 }, (_, index) => ({
            key: `row-${index}`,
            fields: { content_hash: 'a' },
        }));
        await expect(shadowCompareCanonicalFamily(
            'notification',
            async () => rows,
            async () => rows,
            100,
            { COMMERCE_CANONICAL_NOTIFICATION_READ: 'true' },
        )).resolves.toEqual(expect.objectContaining({
            status: 'mismatch',
            truncated: true,
            mismatchedFields: ['truncated'],
        }));
    });

    it('bounds fail-open canonical mirror awaits', async () => {
        vi.useFakeTimers();
        try {
            const pending = withCanonicalMirrorTimeout(() => new Promise<never>(() => undefined));
            const outcome = expect(pending).rejects.toMatchObject({ code: 'CANONICAL_MIRROR_TIMEOUT' });
            await vi.advanceTimersByTimeAsync(CANONICAL_MIRROR_TIMEOUT_MS);
            await outcome;
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds both enabled notification shadow reads', async () => {
        vi.useFakeTimers();
        try {
            const rpc = vi.fn(() => new Promise<never>(() => undefined));
            const read = shadowReadCanonicalNotificationOutbox(10, rpc);

            await vi.runAllTimersAsync();
            await expect(read).resolves.toEqual({ status: 'blocked', rowCount: 0 });
            expect(rpc).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('validates bounded claim inputs and forwards generation-fenced finish inputs', async () => {
        const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
            if (name === 'claim_notification_outbox_v1') {
                expect(params).toEqual({
                    p_limit: 2,
                    p_holder_hash: 'a'.repeat(64),
                    p_lease_seconds: 60,
                });
                return { data: [{ id: '123e4567-e89b-42d3-a456-426614174000' }], error: null };
            }
            expect(name).toBe('finish_notification_outbox_v1');
            expect(params).toEqual({
                p_outbox_id: '123e4567-e89b-42d3-a456-426614174000',
                p_lease_token: '223e4567-e89b-42d3-a456-426614174000',
                p_lease_generation: 3,
                p_outcome: 'retryable',
                p_error_code: 'DELIVERY_TIMEOUT',
                p_retry_after_seconds: 30,
            });
            return { data: { status: 'retryable' }, error: null };
        });
        const store = createCanonicalOperationsStore({ rpc });

        await expect(store.claimNotificationOutbox({
            limit: 2,
            holderHash: 'a'.repeat(64),
            leaseSeconds: 60,
        })).resolves.toHaveLength(1);
        await expect(store.finishNotificationOutbox({
            outboxId: '123e4567-e89b-42d3-a456-426614174000',
            leaseToken: '223e4567-e89b-42d3-a456-426614174000',
            leaseGeneration: 3,
            outcome: 'retryable',
            errorCode: 'DELIVERY_TIMEOUT',
            retryAfterSeconds: 30,
        })).resolves.toEqual({ status: 'retryable' });
        await expect(store.claimMaintenanceJobs({
            limit: 0,
            holderHash: 'a'.repeat(64),
            leaseSeconds: 60,
        })).rejects.toMatchObject({ code: 'CANONICAL_OPERATIONS_INPUT_INVALID' });
    });
});
