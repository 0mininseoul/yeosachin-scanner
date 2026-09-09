import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createCanonicalOperationsStore,
    isCanonicalFamilyReadEnabled,
    rollbackCanonicalReadFlags,
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
    });

    it('uses bounded service-only RPCs for operations writes', () => {
        const sql = migrationSql();
        for (const functionName of [
            'upsert_fulfillment_job_v1',
            'enqueue_notification_v1',
            'append_account_lifecycle_v1',
            'acquire_system_lease_v1',
            'enqueue_maintenance_job_v1',
        ]) {
            expect(sql).toContain(`CREATE FUNCTION public.${functionName}`);
            expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${functionName}`);
            expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}`);
        }
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

    it('keeps all canonical family reads disabled until explicitly enabled', () => {
        expect(isCanonicalFamilyReadEnabled('payment', {})).toBe(false);
        expect(isCanonicalFamilyReadEnabled('maintenance', {
            COMMERCE_CANONICAL_MAINTENANCE_READ: 'true',
        })).toBe(true);
        expect(isCanonicalFamilyReadEnabled('maintenance', {
            COMMERCE_CANONICAL_MAINTENANCE_READ: 'TRUE',
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
});
