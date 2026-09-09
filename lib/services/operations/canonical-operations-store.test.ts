import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
