import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260904120000_expand_apify_free_pool_to_nine.sql',
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';

const ALL_SLOTS = [
    'primary', 'secondary', 'tertiary', 'quaternary', 'quinary',
    'senary', 'septenary', 'octonary', 'nonary', 'tenth',
] as const;
const FREE_SLOTS = ALL_SLOTS.filter(slot => slot !== 'secondary');

describe('Apify ten-account runtime migration contract', () => {
    it('uses the reserved forward-only migration and enumerates the canonical ten aliases', () => {
        expect(migration).not.toBe('');
        expect(migrationPath).toContain('20260904120000');
        for (const slot of ALL_SLOTS) expect(migration).toContain(`'${slot}'`);
        expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|FUNCTION)/i);
        expect(migration).not.toMatch(/TRUNCATE\s+/i);
    });

    it('widens only the current beta helper and keeps secondary outside every free map', () => {
        expect(migration).toContain('CREATE OR REPLACE FUNCTION public.analysis_beta_valid_apify_credential_slot');
        for (const slot of FREE_SLOTS) expect(migration).toContain(`'${slot}'`);
        expect(migration).toContain("p_slot IN (");
        expect(migration).toContain('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE');
        const betaValidator = migration.match(
            /CREATE OR REPLACE FUNCTION public\.analysis_beta_valid_apify_credential_slot[\s\S]*?\$\$;/,
        )?.[0] ?? '';
        expect(betaValidator).not.toContain("'secondary'");
    });

    it('seeds the global budget and every exact-nine preflight budget without secondary', () => {
        expect(migration).toContain('analysis_provider_admission_budgets');
        expect(migration).toContain("'preflight:apify:global'");
        for (const slot of FREE_SLOTS) {
            expect(migration).toContain(`'preflight:apify:${slot}'`);
        }
        expect(migration).not.toContain("'preflight:apify:secondary'");
        expect(migration).toContain('ON CONFLICT (budget_key) DO NOTHING');
        expect(migration).toContain('ANALYSIS_PROVIDER_ADMISSION_BUDGET_DRIFT');
    });

    it('adds and drift-validates the paid octonary/nonary target and relationship budgets', () => {
        for (const [budgetKey, maxActive, rate] of [
            ['paid:apify:octonary', 8, 480],
            ['paid:apify:nonary', 8, 480],
            ['paid:apify:octonary:relationship', 4, 240],
            ['paid:apify:nonary:relationship', 4, 240],
        ] as const) {
            expect(migration).toContain(`'${budgetKey}'`);
            expect(migration).toContain(`'${budgetKey}', 'paid', 'apify'`);
            expect(migration).toContain(`'${budgetKey}', 'paid', 'apify', '${budgetKey.includes('octonary') ? 'octonary' : 'nonary'}', ${maxActive}, ${rate}`);
        }
        expect(migration.indexOf('paid:apify:octonary')).toBeLessThan(
            migration.indexOf('ANALYSIS_PROVIDER_ADMISSION_BUDGET_DRIFT'),
        );
    });

    it('keeps one sanitized all-account inventory with an independent paid refresh path', () => {
        expect(migration).toContain(
            'analysis_apify_credit_snapshots_credential_slot_check',
        );
        expect(migration).toContain(
            'CHECK (public.analysis_v2_valid_apify_credential_slot(credential_slot))',
        );
        for (const slot of ['secondary', 'octonary', 'nonary', 'tenth']) {
            expect(migration).toContain(`('${slot}', 'unhealthy')`);
        }
        expect(migration).toContain('load_analysis_apify_account_credit_inventory');
        expect(migration).toContain('upsert_analysis_apify_paid_credit_snapshot');
        for (const field of [
            'workloadRole',
            'healthState',
            'freshnessState',
            'monthlyLimitUsd',
            'monthlyUsageUsd',
            'effectiveRemainingUsd',
            'billingCycleEndAt',
            'cycleResetAt',
            'manuallyExcluded',
        ]) {
            expect(migration).toContain(`'${field}'`);
        }
        expect(migration).toContain("'freshnessState', inventory.freshness_state");
        expect(migration).toContain("WHEN inventory.freshness_state <> 'fresh' THEN NULL");
        expect(migration).toContain("p_snapshot->>'credentialSlot' IS DISTINCT FROM 'secondary'");
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_apify_account_credit_inventory(INTEGER)');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.upsert_analysis_apify_paid_credit_snapshot(JSONB)');
        expect(migration).not.toMatch(
            /upsert_analysis_apify_paid_credit_snapshot[\s\S]{0,1500}monthly_limit_usd[^\n]*COALESCE/i,
        );
    });

    it('reuses the existing snapshot ledger for locked operator exclusions', () => {
        expect(migration).toContain(
            'ADD COLUMN IF NOT EXISTS manually_excluded BOOLEAN NOT NULL DEFAULT FALSE',
        );
        expect(migration).not.toContain('CREATE TABLE public.analysis_apify_account_control_events');
        expect(migration).not.toContain('append_analysis_apify_account_control_event');
        expect(migration).toContain('set_analysis_apify_account_exclusion');
        expect(migration).toContain('load_analysis_apify_account_control_state');
        expect(migration).toContain("SET manually_excluded = p_excluded");
        expect(migration).toMatch(/set_analysis_apify_account_exclusion[\s\S]*pg_advisory_xact_lock/);
    });

    it('replaces six-row runtime fences with the exact nine-row canonical order', () => {
        for (const functionName of [
            'upsert_analysis_beta_apify_credit_snapshots',
            'load_analysis_beta_apify_credit_pool',
            'analysis_beta_pool_effective_capacity_snapshot',
            'activate_analysis_beta_apify_request_credit_unbound',
            'guard_analysis_beta_pool_reservation_headroom',
        ]) {
            expect(migration).toContain(`FUNCTION public.${functionName}`);
        }
        expect(migration).toContain('jsonb_array_length(p_snapshots) <> 9');
        expect(migration).toContain('v_lock_count <> 9');
        expect(migration).toContain("WHEN 'octonary' THEN 7");
        expect(migration).toContain("WHEN 'nonary' THEN 8");
        expect(migration).toContain("WHEN 'tenth' THEN 9");
        expect(migration).not.toMatch(/jsonb_array_length\(p_snapshots\) <> 6/);
        expect(migration).not.toMatch(/v_lock_count <> 6/);
    });

    it('takes the same advisory lock for allocation and exclusion races', () => {
        expect(migration).toContain("'analysis-apify-free-pool'");
        expect(migration).toContain('pg_advisory_xact_lock');
        expect(migration).toContain('analysis_apify_account_is_excluded');
        expect(migration).toContain('analysis_beta_valid_operation_slot_map');
        expect(migration).toContain('SET search_path = \'\'');
    });
});
