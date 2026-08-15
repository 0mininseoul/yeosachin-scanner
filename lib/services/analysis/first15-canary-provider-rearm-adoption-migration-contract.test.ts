import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
    process.cwd(),
    'supabase/migrations/'
        + '20260815210000_authorize_first15_canary_provider_rearm_adoption.sql',
);

describe('first15 canary provider rearm adoption migration contract', () => {
    it('permits only the immutable, fully reconciled first15 lineage to create its successor', () => {
        const migration = readFileSync(migrationPath, 'utf8');

        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260815200000');
        expect(migration).toContain(
            'earlybird_first15_canary_provider_rearms',
        );
        expect(migration).toContain('source_request_id = p_failed_request_id');
        expect(migration).toContain('rearmed_preflight_id = p_recovery_preflight_id');
        expect(migration).toContain('source_run.status IN (\'starting\', \'running\')');
        expect(migration).toContain('source_run.actual_usage_usd IS NULL');
        expect(migration).toContain('source_run.usage_reconciled_at IS NULL');
        expect(migration).toContain('analysis_v2_failure_receipts');
        expect(migration).toContain('fulfillment.lease_token IS NOT NULL');
        expect(migration).toContain('fulfillment.lease_fence >= 1');
        expect(migration).toContain(
            'fulfillment.lease_expires_at > pg_catalog.clock_timestamp()',
        );
        expect(migration).toContain(
            'earlybird_first15_canary_provider_rearm_request_ready',
        );
    });

    it('preserves every prior adoption path and keeps the new service-role boundary private', () => {
        const migration = readFileSync(migrationPath, 'utf8');

        expect(migration).toContain(
            'RENAME TO earlybird_provider_run_adoption_ready_pre_first15',
        );
        expect(migration).toContain(
            'earlybird_provider_run_adoption_ready_pre_first15(',
        );
        expect(migration).toContain('pg_get_functiondef');
        expect(migration).toContain('v_first15_rearm_ready BOOLEAN := FALSE');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_first15_canary_provider_rearm_request_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_provider_run_adoption_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
    });
});
