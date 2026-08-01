import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260802010000_add_betatest_apify_credit_pool.sql'
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';

function functionDefinition(name: string): string {
    const start = migration.indexOf(`FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const createStart = migration.lastIndexOf('CREATE', start);
    const end = migration.indexOf('\n$$;', start);
    expect(createStart, `${name} must have a CREATE statement`).toBeGreaterThanOrEqual(0);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(createStart, end + '\n$$;'.length);
}

function tableDefinition(name: string): string {
    const start = migration.indexOf(`CREATE TABLE public.${name} (`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end, `${name} must have a bounded definition`).toBeGreaterThan(start);
    return migration.slice(start, end + '\n);'.length);
}

describe('beta Apify credit pool foundation migration contract', () => {
    it('uses the reserved append-only migration and does not add Task 2B state yet', () => {
        expect(migration).not.toBe('');
        expect(migrationPath).toContain('20260802010000');
        expect(migration).not.toContain('CREATE TABLE public.analysis_beta_pool_allocations');
        expect(migration).not.toContain('CREATE TABLE public.analysis_beta_pool_reservations');
        expect(migration).not.toContain('betatest_free_pool');
        expect(migration).not.toContain('reserve_analysis_v2_provider_run');
    });

    it('extends only the current general helper to the exact seven-slot vocabulary', () => {
        const helper = functionDefinition('analysis_v2_valid_apify_credential_slot');
        expect(helper).toMatch(
            /p_slot IN\s*\(\s*'primary',\s*'secondary',\s*'tertiary',\s*'quaternary',\s*'quinary',\s*'senary',\s*'septenary'\s*\)/
        );
        expect(helper).toContain('IMMUTABLE');
        expect(helper).toContain("SET search_path = ''");
        expect(helper).toContain('COALESCE(');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)'
        );
    });

    it('defines an independent exact six-slot beta helper that rejects null structurally', () => {
        const helper = functionDefinition('analysis_beta_valid_apify_credential_slot');
        expect(helper).toMatch(
            /p_slot IN\s*\(\s*'primary',\s*'tertiary',\s*'quaternary',\s*'quinary',\s*'senary',\s*'septenary'\s*\)/
        );
        expect(helper).not.toContain("'secondary'");
        expect(helper).toContain('COALESCE(');
        expect(helper).toContain('FALSE');
        expect(helper).toContain('IMMUTABLE');
        expect(helper).toContain("SET search_path = ''");
    });

    it('pins the legacy authorized policy to primary through senary', () => {
        const helper = functionDefinition(
            'analysis_v2_valid_test_operation_slot_map'
        );
        for (const operation of [
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'target-likers',
            'target-comments',
            'candidate-likers',
        ]) {
            expect(helper).toContain(`'${operation}'`);
        }
        expect(helper).toMatch(
            /slot_value #>> '\{\}'\s*NOT IN\s*\(\s*'primary',\s*'secondary',\s*'tertiary',\s*'quaternary',\s*'quinary',\s*'senary'\s*\)/
        );
        expect(helper).not.toContain("'septenary'");
        expect(helper).not.toContain(
            'analysis_v2_valid_apify_credential_slot'
        );
        expect(helper).toContain(
            "p_map->>'target-profile' = p_map->>'profile-fallback'"
        );
        expect(helper).toContain(
            "p_map->>'relationship-followers' <> p_map->>'relationship-following'"
        );
        expect(helper).toContain(
            "p_map->>'target-likers' <> p_map->>'candidate-likers'"
        );
        expect(helper).toContain('IMMUTABLE');
        expect(helper).toContain("SET search_path = ''");
    });

    it('validates separate exact eight-key beta slot and positive budget maps', () => {
        const slotMap = functionDefinition('analysis_beta_valid_operation_slot_map');
        const budgetMap = functionDefinition('analysis_beta_valid_operation_budget_map');
        const exactOperations = [
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'profile-repair',
            'target-likers',
            'target-comments',
            'candidate-likers',
        ];

        for (const operation of exactOperations) {
            expect(slotMap).toContain(`'${operation}'`);
            expect(budgetMap).toContain(`'${operation}'`);
        }
        expect(slotMap).toContain('analysis_beta_valid_apify_credential_slot');
        expect(slotMap).toContain('jsonb_each');
        expect(budgetMap).toContain("jsonb_typeof(entry.budget_value) <> 'number'");
        expect(budgetMap).toContain('BETWEEN 0.000000000001 AND 1000');
        expect(budgetMap).toContain('round(');
        expect(slotMap).toContain("SET search_path = ''");
        expect(budgetMap).toContain("SET search_path = ''");
    });

    it('adds a separate entry channel without widening either PlanAccessMode domain', () => {
        expect(migration).toMatch(
            /ALTER TABLE public\.analysis_preflights\s+ADD COLUMN analysis_entry_channel TEXT NOT NULL DEFAULT 'standard';/
        );
        expect(migration).toMatch(
            /ALTER TABLE public\.analysis_requests\s+ADD COLUMN analysis_entry_channel TEXT NOT NULL DEFAULT 'standard';/
        );
        expect(migration.match(/analysis_entry_channel IN \('standard', 'betatest'\)/g))
            .toHaveLength(2);
        expect(migration).toMatch(
            /analysis_entry_channel <> 'betatest'[\s\S]*?access_mode = 'production'/
        );
        expect(migration).toMatch(
            /analysis_entry_channel <> 'betatest'[\s\S]*?plan_access_mode_snapshot IS NOT DISTINCT FROM 'production'/
        );
        expect(migration).toContain(
            "pipeline_version IS NOT DISTINCT FROM 'v2'"
        );
        expect(migration).not.toMatch(
            /access_mode IN \([^)]*'betatest'/
        );
        expect(migration).not.toMatch(
            /plan_access_mode_snapshot IN \([^)]*'betatest'/
        );
    });

    it('adds channel checks unvalidated and validates them in a lighter-lock phase', () => {
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        for (const constraint of [
            'analysis_preflights_entry_channel_check',
            'analysis_preflights_entry_channel_access_check',
            'analysis_requests_entry_channel_check',
            'analysis_requests_entry_channel_access_check',
        ]) {
            const addIndex = migration.indexOf(`ADD CONSTRAINT ${constraint}`);
            const notValidIndex = migration.indexOf('NOT VALID', addIndex);
            const validateIndex = migration.indexOf(
                `VALIDATE CONSTRAINT ${constraint}`
            );
            expect(addIndex, `${constraint} must be added`).toBeGreaterThanOrEqual(0);
            expect(notValidIndex, `${constraint} must be NOT VALID`)
                .toBeGreaterThan(addIndex);
            expect(validateIndex, `${constraint} must be validated separately`)
                .toBeGreaterThan(notValidIndex);
        }

        const preflightColumn = migration.match(
            /ALTER TABLE public\.analysis_preflights\s+ADD COLUMN analysis_entry_channel[\s\S]*?;/
        )?.[0] ?? '';
        const requestColumn = migration.match(
            /ALTER TABLE public\.analysis_requests\s+ADD COLUMN analysis_entry_channel[\s\S]*?;/
        )?.[0] ?? '';
        expect(preflightColumn).not.toContain('ADD CONSTRAINT');
        expect(requestColumn).not.toContain('ADD CONSTRAINT');
    });

    it('creates a non-enumerable audited grant table with no seeded user', () => {
        const table = tableDefinition('analysis_beta_access_grants');
        expect(table).toContain('user_id UUID PRIMARY KEY');
        expect(table).toContain('enabled BOOLEAN NOT NULL');
        expect(table).toContain('expires_at TIMESTAMP WITH TIME ZONE');
        expect(table).toContain('audit_reference_hash VARCHAR(64) NOT NULL');
        expect(table).toContain('granted_at TIMESTAMP WITH TIME ZONE NOT NULL');
        expect(table).toContain('updated_at TIMESTAMP WITH TIME ZONE NOT NULL');
        expect(migration).toContain(
            'ALTER TABLE public.analysis_beta_access_grants ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_beta_access_grants FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_beta_access_grants\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /INSERT INTO public\.analysis_beta_access_grants/
        );
    });

    it('exposes only a zero-argument authenticated self-access check', () => {
        const selfCheck = functionDefinition('analysis_beta_has_access');
        expect(selfCheck).toContain('RETURNS BOOLEAN');
        expect(selfCheck).toContain('SECURITY DEFINER');
        expect(selfCheck).toContain("SET search_path = ''");
        expect(selfCheck).toContain('auth.uid()');
        expect(selfCheck).toContain('grant_row.user_id = v_user_id');
        expect(selfCheck).toContain('grant_row.enabled = TRUE');
        expect(selfCheck).toContain('grant_row.expires_at > v_now');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_beta_has_access\(\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_beta_has_access\(\)\s+TO authenticated/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_beta_has_access\(\)[\s\S]*?TO anon/
        );
    });

    it('stores only sanitized exact-slot snapshot state behind FORCE RLS', () => {
        const table = tableDefinition('analysis_apify_credit_snapshots');
        for (const column of [
            'credential_slot',
            'monthly_limit_usd',
            'monthly_usage_usd',
            'billing_cycle_start_at',
            'billing_cycle_end_at',
            'observed_at',
            'health_state',
            'refreshed_at',
        ]) {
            expect(table).toContain(column);
        }
        expect(table).toContain('analysis_beta_valid_apify_credential_slot');
        expect(table).toContain('BETWEEN 0 AND 100000');
        expect(table).toContain("health_state IN ('healthy', 'unhealthy')");
        expect(table).toContain('monthly_limit_usd IS NOT NULL');
        expect(table).toContain('monthly_usage_usd IS NOT NULL');
        expect(table).toContain('billing_cycle_start_at IS NOT NULL');
        expect(table).toContain('billing_cycle_end_at IS NOT NULL');
        expect(table).toContain('observed_at IS NOT NULL');
        expect(table).toContain('pg_catalog.isfinite(billing_cycle_start_at)');
        expect(table).toContain('pg_catalog.isfinite(billing_cycle_end_at)');
        expect(table).toContain('pg_catalog.isfinite(observed_at)');
        expect(table).not.toMatch(
            /token|account_id|user_id|email|cookie|payload|raw_/i
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_apify_credit_snapshots FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_apify_credit_snapshots\s+FROM PUBLIC, anon, authenticated, service_role/
        );
    });

    it('seeds only the six sanitized slot sentinels in canonical lock order', () => {
        expect(migration).toMatch(
            /INSERT INTO public\.analysis_apify_credit_snapshots\s*\(credential_slot, health_state\)/
        );
        for (const ordinal of [1, 2, 3, 4, 5, 6]) {
            expect(migration).toContain(`WHEN '${[
                'primary',
                'tertiary',
                'quaternary',
                'quinary',
                'senary',
                'septenary',
            ][ordinal - 1]}' THEN ${ordinal}`);
        }
    });

    it('atomically validates and updates one exact healthy six-slot snapshot batch', () => {
        const upsert = functionDefinition(
            'upsert_analysis_beta_apify_credit_snapshots'
        );
        expect(upsert).toContain('SECURITY DEFINER');
        expect(upsert).toContain("SET search_path = ''");
        expect(upsert).toContain("jsonb_typeof(p_snapshots) <> 'array'");
        expect(upsert).toContain('jsonb_array_length(p_snapshots) <> 6');
        expect(upsert).toContain('COUNT(DISTINCT');
        expect(upsert).toContain('analysis_beta_valid_apify_credential_slot');
        expect(upsert).toContain("healthState') IS DISTINCT FROM 'healthy'");
        expect(upsert).toContain("jsonb_typeof(v_entry->'monthlyLimitUsd') <> 'number'");
        expect(upsert).toContain('BETWEEN 0 AND 100000');
        expect(upsert).toContain('billingCycleStartAt');
        expect(upsert).toContain('billingCycleEndAt');
        expect(upsert).toContain('cycle_start_at <= v_observed_at');
        expect(upsert).toContain('v_observed_at < v_cycle_end_at');
        expect(upsert).toContain('pg_catalog.isfinite(v_cycle_start_at)');
        expect(upsert).toContain('pg_catalog.isfinite(v_cycle_end_at)');
        expect(upsert).toContain('pg_catalog.isfinite(v_observed_at)');
        expect(upsert).toContain('v_common_observed_at');
        expect(upsert).not.toContain('v_common_cycle_start_at');
        expect(upsert).not.toContain('v_common_cycle_end_at');
        expect(upsert).toContain("v_now + INTERVAL '1 minute'");
        expect(upsert).toContain("v_now - INTERVAL '5 minutes'");
        expect(upsert).toContain('FOR UPDATE');
        expect(upsert).toContain('ORDER BY CASE snapshot.credential_slot');
        expect(upsert).toContain('UPDATE public.analysis_apify_credit_snapshots');
        expect(upsert).not.toContain('ON CONFLICT');
    });

    it('exposes foundation-only sanitized headroom through service-role RPCs', () => {
        const load = functionDefinition('load_analysis_beta_apify_credit_pool');
        expect(load).toContain('SECURITY DEFINER');
        expect(load).toContain("SET search_path = ''");
        expect(load).toContain('p_max_age_seconds BETWEEN 1 AND 900');
        expect(load).toContain("snapshot.health_state <> 'healthy'");
        expect(load).toContain('snapshot.observed_at < v_now -');
        expect(load).toContain('count(DISTINCT snapshot.observed_at)');
        expect(load).toContain("'effectiveHeadroomUsd'");
        expect(load).toContain('GREATEST(');
        expect(load).toContain('snapshot.monthly_limit_usd - snapshot.monthly_usage_usd');
        expect(load).not.toMatch(
            /count\(DISTINCT \(\s*snapshot\.billing_cycle_start_at/i
        );
        expect(migration).toContain('foundation-only headroom');

        for (const signature of [
            'upsert_analysis_beta_apify_credit_snapshots(JSONB)',
            'load_analysis_beta_apify_credit_pool(INTEGER)',
        ]) {
            const escaped = signature
                .replaceAll('(', '\\(')
                .replaceAll(')', '\\)');
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+`
                + 'FROM PUBLIC, anon, authenticated, service_role'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role`
            ));
        }
    });

    it('contains stable generic errors and no secret/account identity vocabulary', () => {
        for (const errorCode of [
            'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
            'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
            'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY',
            'ANALYSIS_BETA_POOL_SNAPSHOT_CONFLICT',
        ]) {
            expect(migration).toContain(errorCode);
        }
        expect(migration).not.toMatch(
            /APIFY_[A-Z_]*TOKEN|provider_account|account_identifier|raw_payload|cookie_value/i
        );
    });
});
