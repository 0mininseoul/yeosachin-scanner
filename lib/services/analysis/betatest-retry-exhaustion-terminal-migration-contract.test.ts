import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schemaMigrationUrl = new URL(
    '../../../supabase/migrations/20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql',
    import.meta.url
);
const runtimeMigrationUrl = new URL(
    '../../../supabase/migrations/20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql',
    import.meta.url
);
const validationMigrationUrl = new URL(
    '../../../supabase/migrations/20260802100500_validate_betatest_prepare_retry_exhaustion.sql',
    import.meta.url
);
const schemaMigration = existsSync(schemaMigrationUrl)
    ? readFileSync(schemaMigrationUrl, 'utf8') : '';
const runtimeMigration = existsSync(runtimeMigrationUrl)
    ? readFileSync(runtimeMigrationUrl, 'utf8') : '';
const validationMigration = existsSync(validationMigrationUrl)
    ? readFileSync(validationMigrationUrl, 'utf8') : '';

function body(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
    const start = runtimeMigration.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = runtimeMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.',
        start + marker.length
    );
    return runtimeMigration.slice(start, next < 0 ? undefined : next);
}

describe('betatest prepare retry exhaustion terminal migration', () => {
    it('replaces the shape check briefly and validates it separately', () => {
        expect(schemaMigration).toContain(
            "PERFORM pg_catalog.set_config('lock_timeout', '5s', true);"
        );
        expect(schemaMigration).toContain(
            "PERFORM pg_catalog.set_config('statement_timeout', '2min', true);"
        );
        expect(schemaMigration).toMatch(
            /DROP CONSTRAINT analysis_preflights_beta_prepare_shape_check/
        );
        expect(schemaMigration).toMatch(
            /ADD CONSTRAINT analysis_preflights_beta_prepare_shape_check CHECK[\s\S]*?NOT VALID/
        );
        expect(schemaMigration).toContain("'retry_exhausted'");
        expect(schemaMigration).toContain("error_code = 'QUEUE_UNAVAILABLE'");
        expect(schemaMigration).not.toContain('CREATE OR REPLACE FUNCTION');
        expect(schemaMigration).not.toContain('UPDATE public.analysis_preflights');
        expect(runtimeMigration).not.toContain(
            'DROP CONSTRAINT analysis_preflights_beta_prepare_shape_check'
        );
        expect(validationMigration).not.toContain('UPDATE public.analysis_preflights');
        expect(validationMigration).toContain(
            'VALIDATE CONSTRAINT analysis_preflights_beta_prepare_shape_check'
        );
        expect(validationMigration).not.toContain('CREATE OR REPLACE FUNCTION');
    });

    it('backfills the historical pending tombstone into the public terminal shape', () => {
        expect(runtimeMigration).toMatch(
            /UPDATE public\.analysis_preflights AS preflight[\s\S]*?SET status = 'expired'[\s\S]*?preflight\.expires_at <= pg_catalog\.clock_timestamp\(\)/
        );
        expect(runtimeMigration).toMatch(
            /UPDATE public\.analysis_preflights AS preflight[\s\S]*?beta_prepare_state\s*=\s*'retry_exhausted'/
        );
        expect(runtimeMigration).toContain("analysis_entry_channel = 'betatest'");
        expect(runtimeMigration).toContain("status = 'blocked'");
        expect(runtimeMigration).toContain("error_code = 'QUEUE_UNAVAILABLE'");
        expect(runtimeMigration).toContain('beta_prepare_lease_token = NULL');
        expect(runtimeMigration).toContain('beta_prepare_lease_expires_at = NULL');
    });

    it('terminalizes retry exhaustion atomically with the exact service-only RPC ACL', () => {
        const exhaust = body(
            'mark_analysis_beta_preflight_prepare_retry_exhausted('
        );
        expect(exhaust).toContain('SECURITY DEFINER');
        expect(exhaust).toContain("SET search_path = ''");
        expect(exhaust).toContain("SET lock_timeout = '5s'");
        expect(exhaust).toContain("SET statement_timeout = '2min'");
        expect(exhaust).toContain("analysis_entry_channel='betatest'");
        expect(exhaust).toContain("status='blocked'");
        expect(exhaust).toContain("error_code='QUEUE_UNAVAILABLE'");
        expect(exhaust).toContain("beta_prepare_state='retry_exhausted'");
        expect(exhaust).toContain("beta_prepare_dispatch_state='completed'");
        expect(exhaust).toContain('beta_prepare_lease_token=NULL');
        expect(exhaust).toContain('beta_prepare_lease_expires_at=NULL');
        expect(exhaust).toContain('beta_prepare_retry_exhausted_at=v_now');
        expect(exhaust).toContain('beta_prepare_completed_at=v_now');
        expect(exhaust.indexOf('FOR UPDATE')).toBeLessThan(
            exhaust.indexOf('v_now := pg_catalog.clock_timestamp()')
        );
        expect(exhaust.indexOf('v_preflight.expires_at<=v_now')).toBeLessThan(
            exhaust.indexOf('SELECT allocation.* INTO v_allocation')
        );
        expect(exhaust).toContain("SET status='expired', updated_at=v_now");
        expect(runtimeMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.mark_analysis_beta_preflight_prepare_retry_exhausted\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(runtimeMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.mark_analysis_beta_preflight_prepare_retry_exhausted\([\s\S]*?TO service_role;/
        );
        expect(runtimeMigration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.mark_analysis_beta_preflight_prepare_retry_exhausted\([\s\S]*?TO authenticated;/
        );
    });

    it('makes claim and capacity block treat retry exhaustion as terminal', () => {
        const claim = body('claim_analysis_beta_preflight_prepare(');
        const block = body('block_analysis_beta_preflight_capacity(');
        expect(claim).toMatch(
            /IN\s*\(\s*'prepared','capacity_blocked','retry_exhausted','expired'\s*\)/
        );
        expect(claim).toContain("'terminal'::TEXT");
        expect(block).toContain(
            "beta_prepare_state='retry_exhausted' THEN RETURN 'retry_exhausted'"
        );
    });
});
