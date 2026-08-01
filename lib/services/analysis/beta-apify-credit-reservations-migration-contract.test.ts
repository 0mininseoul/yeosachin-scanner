import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260802020000_add_betatest_apify_credit_reservations.sql'
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';

const OPERATIONS = [
    'target-profile',
    'relationship-followers',
    'relationship-following',
    'profile-fallback',
    'profile-repair',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const;
const CANONICAL_SLOTS = [
    'primary',
    'tertiary',
    'quaternary',
    'quinary',
    'senary',
    'septenary',
] as const;

function functionDefinition(name: string): string {
    const start = migration.indexOf(`FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const createStart = migration.lastIndexOf('CREATE', start);
    const end = migration.indexOf('\n$$;', start);
    expect(createStart, `${name} must have a CREATE statement`)
        .toBeGreaterThanOrEqual(0);
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

function compactSql(sql: string): string {
    return sql
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
}

function expectServiceOnlyRpc(signature: string): void {
    const match = signature.match(/^([^()]+)\((.*)\)$/);
    expect(match, `${signature} must be a function signature`).not.toBeNull();
    const [, name, rawArguments] = match!;
    const escapedArguments = rawArguments
        .split(',')
        .map(argument => argument.trim().replaceAll(' ', '\\s+'))
        .join('\\s*,\\s*');
    const escaped = `${name}\\(\\s*${escapedArguments}\\s*\\)`;
    expect(migration).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+`
        + 'FROM PUBLIC, anon, authenticated, service_role'
    ));
    expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role`
    ));
}

function expectCanonicalSnapshotLocks(definition: string): void {
    expect(definition).toContain(
        'FROM public.analysis_apify_credit_snapshots AS snapshot'
    );
    expect(definition).toContain('ORDER BY CASE snapshot.credential_slot');
    expect(definition).toContain('FOR UPDATE');
    for (const [index, slot] of CANONICAL_SLOTS.entries()) {
        expect(definition).toContain(`WHEN '${slot}' THEN ${index + 1}`);
    }
}

describe('beta Apify credit reservation migration contract', () => {
    it('uses one append-only Task 2B1 migration and leaves later guards/settlement absent', () => {
        expect(migration).not.toBe('');
        expect(migrationPath).toContain('20260802020000');
        expect(migration).not.toContain('reserve_analysis_v2_provider_run');
        expect(migration).not.toContain('analysis_v2_provider_execution_policies');
        expect(migration).not.toMatch(/settle_analysis_beta|recover_expired_analysis_beta/);
        expect(migration).not.toMatch(/actual_usage_usd|reconciled_actual_usd/);
    });

    it('creates a restrictive preflight/request-owned allocation lifecycle', () => {
        const table = tableDefinition('analysis_beta_pool_allocations');
        const compactTable = compactSql(table);

        for (const column of [
            'id UUID PRIMARY KEY',
            'preflight_id UUID NOT NULL UNIQUE',
            'request_id UUID UNIQUE',
            'user_id UUID NOT NULL',
            'lifecycle_state TEXT NOT NULL',
            'selected_plan_id TEXT',
            'policy_version TEXT NOT NULL',
            'operation_slot_map JSONB',
            'operation_budget_map JSONB',
            'expires_at TIMESTAMP WITH TIME ZONE NOT NULL',
            'created_at TIMESTAMP WITH TIME ZONE NOT NULL',
            'updated_at TIMESTAMP WITH TIME ZONE NOT NULL',
            'activated_at TIMESTAMP WITH TIME ZONE',
        ]) {
            expect(table).toContain(column);
        }
        expect(table).toMatch(
            /REFERENCES public\.analysis_preflights\(id\) ON DELETE RESTRICT/
        );
        expect(table).toMatch(
            /REFERENCES public\.analysis_requests\(id\) ON DELETE RESTRICT/
        );
        expect(table).toMatch(
            /REFERENCES public\.users\(id\) ON DELETE RESTRICT/
        );
        expect(table).toContain(
            "lifecycle_state IN ('preflight_held', 'active')"
        );
        expect(table).toContain("policy_version = 'betatest-free-pool-v1'");
        expect(compactTable).toContain(
            'public.analysis_beta_valid_operation_slot_map(operation_slot_map)'
        );
        expect(compactTable).toContain(
            'public.analysis_beta_valid_operation_budget_map(operation_budget_map)'
        );
        expect(table).toMatch(
            /lifecycle_state = 'preflight_held'[\s\S]*?request_id IS NULL[\s\S]*?selected_plan_id IS NULL[\s\S]*?operation_slot_map IS NULL[\s\S]*?operation_budget_map IS NULL[\s\S]*?activated_at IS NULL/
        );
        expect(table).toMatch(
            /lifecycle_state = 'active'[\s\S]*?request_id IS NOT NULL[\s\S]*?selected_plan_id IN \('basic', 'standard', 'plus'\)[\s\S]*?operation_slot_map IS NOT NULL[\s\S]*?operation_budget_map IS NOT NULL[\s\S]*?activated_at IS NOT NULL/
        );
        expect(table).toContain('pg_catalog.isfinite(expires_at)');
        expect(table).not.toMatch(
            /token|provider_account|account_identifier|raw_payload|email|cookie/i
        );
    });

    it('creates one exact positive operation reservation per allocation and lifecycle', () => {
        const table = tableDefinition('analysis_beta_pool_reservations');

        expect(table).toContain('allocation_id UUID NOT NULL');
        expect(table).toContain('operation_family TEXT NOT NULL');
        expect(table).toContain('credential_slot TEXT NOT NULL');
        expect(table).toContain('reserved_usd NUMERIC(18, 12) NOT NULL');
        expect(table).toContain('lifecycle_state TEXT NOT NULL');
        expect(table).toContain('PRIMARY KEY (allocation_id, operation_family)');
        expect(table).toContain('public.analysis_beta_valid_apify_credential_slot');
        expect(table).toContain('BETWEEN 0.000000000001 AND 1000');
        expect(table).toContain('reserved_usd = pg_catalog.round(reserved_usd, 12)');
        expect(table).toMatch(
            /FOREIGN KEY \(allocation_id, lifecycle_state\)[\s\S]*?REFERENCES public\.analysis_beta_pool_allocations\(id, lifecycle_state\)[\s\S]*?ON UPDATE CASCADE[\s\S]*?ON DELETE RESTRICT/
        );
        for (const operation of OPERATIONS) {
            expect(table).toContain(`'${operation}'`);
        }
        expect(table).not.toContain("'secondary'");
        expect(table).not.toMatch(
            /token|provider_account|account_identifier|raw_payload|email|cookie/i
        );
    });

    it('forces RLS and revokes every direct privilege on both credit-state tables', () => {
        for (const table of [
            'analysis_beta_pool_allocations',
            'analysis_beta_pool_reservations',
        ]) {
            expect(migration).toContain(
                `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
            );
            expect(migration).toContain(
                `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`
            );
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+`
                + 'FROM PUBLIC, anon, authenticated, service_role'
            ));
            expect(migration).not.toMatch(new RegExp(
                `GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*public\\.${table}`
            ));
        }
    });

    it('adds one audited service-only grant upsert/disable boundary', () => {
        const grantMutation = functionDefinition(
            'upsert_analysis_beta_access_grant'
        );

        expect(grantMutation).toContain('RETURNS BOOLEAN');
        expect(grantMutation).toContain('SECURITY DEFINER');
        expect(grantMutation).toContain("SET search_path = ''");
        expect(grantMutation).toContain("p_audit_reference_hash !~ '^[a-f0-9]{64}$'");
        expect(grantMutation).toContain('pg_catalog.isfinite(p_expires_at)');
        expect(grantMutation).toContain('p_expires_at <= v_now');
        expect(grantMutation).toContain(
            'INSERT INTO public.analysis_beta_access_grants'
        );
        expect(grantMutation).toContain('ON CONFLICT (user_id) DO UPDATE');
        expect(grantMutation).toContain('enabled = EXCLUDED.enabled');
        expect(grantMutation).toContain(
            'audit_reference_hash = EXCLUDED.audit_reference_hash'
        );
        expectServiceOnlyRpc(
            'upsert_analysis_beta_access_grant(UUID,BOOLEAN,TIMESTAMP WITH TIME ZONE,TEXT)'
        );

        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.(?!analysis_beta_has_access\(\))[^\n]+\s+TO authenticated/
        );
    });

    it('re-reads database time only after every admission-relevant row lock', () => {
        const grantMutation = functionDefinition(
            'upsert_analysis_beta_access_grant'
        );
        const hold = functionDefinition(
            'hold_analysis_beta_apify_preflight_credit'
        );
        const activate = functionDefinition(
            'activate_analysis_beta_apify_request_credit'
        );

        expect(grantMutation).toContain('pg_catalog.pg_advisory_xact_lock');
        expect(grantMutation).toContain(
            'FROM public.analysis_beta_access_grants AS existing_grant'
        );
        expect(grantMutation.indexOf('FOR UPDATE')).toBeLessThan(
            grantMutation.indexOf('v_now := pg_catalog.clock_timestamp()')
        );
        expect(grantMutation.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(grantMutation.lastIndexOf('p_expires_at <= v_now'));

        expect(compactSql(hold)).toContain(
            'SELECT grant_row.* INTO v_grant'
        );
        expect(hold.indexOf('FOR v_locked_snapshot IN')).toBeLessThan(
            hold.indexOf('v_now := pg_catalog.clock_timestamp()')
        );
        expect(hold.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(hold.lastIndexOf('v_preflight.expires_at <= v_now'));
        expect(hold.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(hold.lastIndexOf('v_grant.expires_at <= v_now'));
        expect(hold.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(hold.lastIndexOf('v_locked_snapshot.observed_at < v_now'));

        expect(compactSql(activate)).toContain(
            'SELECT grant_row.* INTO v_grant'
        );
        expect(activate.indexOf('FOR v_locked_snapshot IN')).toBeLessThan(
            activate.indexOf('v_now := pg_catalog.clock_timestamp()')
        );
        expect(activate.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(activate.lastIndexOf('v_existing.expires_at <= v_now'));
        expect(activate.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(activate.lastIndexOf('v_grant.expires_at <= v_now'));
        expect(activate.indexOf('v_now := pg_catalog.clock_timestamp()'))
            .toBeLessThan(activate.lastIndexOf('v_locked_snapshot.observed_at < v_now'));
    });

    it('holds target-profile credit only after grant, preflight, and six-snapshot validation', () => {
        const hold = functionDefinition(
            'hold_analysis_beta_apify_preflight_credit'
        );
        const compactHold = compactSql(hold);

        expect(hold).toContain('RETURNS JSONB');
        expect(hold).toContain('SECURITY DEFINER');
        expect(hold).toContain("SET search_path = ''");
        expect(hold).toContain('p_target_profile_budget_usd IS DISTINCT FROM 0.005200000000');
        expect(compactHold).toContain(
            'public.analysis_beta_valid_apify_credential_slot(p_credential_slot)'
        );
        expect(hold).toContain('FROM public.analysis_preflights AS preflight');
        expect(hold).toContain('FOR UPDATE');
        expect(hold).toContain(
            "v_preflight.access_mode IS DISTINCT FROM 'production'"
        );
        expect(hold).toContain(
            "v_preflight.status IS DISTINCT FROM 'pending'"
        );
        expect(hold).toContain(
            "v_preflight.dispatch_state IS DISTINCT FROM 'unreserved'"
        );
        expect(hold).toContain('v_preflight.expires_at <= v_now');
        expect(hold).toContain('analysis_preflight_provider_runs');
        expect(hold).toContain('FROM public.analysis_beta_access_grants AS grant_row');
        expect(hold).toContain('v_grant.enabled IS DISTINCT FROM TRUE');
        expect(hold).toContain('v_grant.expires_at <= v_now');
        expectCanonicalSnapshotLocks(hold);
        expect(hold).toContain("v_locked_snapshot.health_state <> 'healthy'");
        expect(hold).toContain('v_locked_snapshot.observed_at < v_now');
        expect(hold).toContain('v_locked_snapshot.billing_cycle_end_at <= v_now');
        expect(hold).toContain(
            'FROM public.analysis_beta_pool_reservations AS reservation'
        );
        expect(hold).toContain("reservation.lifecycle_state IN ('preflight_held', 'active')");
        expect(hold).toContain('snapshot.monthly_limit_usd');
        expect(hold).toContain('snapshot.monthly_usage_usd');
        expect(hold).toContain('p_target_profile_budget_usd');
        expect(hold).toContain(
            'INSERT INTO public.analysis_beta_pool_allocations'
        );
        expect(hold).toContain(
            'INSERT INTO public.analysis_beta_pool_reservations'
        );
        expect(hold).toContain("'target-profile'");
        expect(hold).toContain("analysis_entry_channel = 'betatest'");
        expectServiceOnlyRpc(
            'hold_analysis_beta_apify_preflight_credit(UUID,UUID,TEXT,NUMERIC,INTEGER)'
        );
    });

    it('makes preflight hold replay exact and rejects changed ownership or cost inputs', () => {
        const hold = functionDefinition(
            'hold_analysis_beta_apify_preflight_credit'
        );
        const compactHold = compactSql(hold);

        expect(hold).toContain(
            'FROM public.analysis_beta_pool_allocations AS allocation'
        );
        expect(hold).toContain(
            'FROM public.analysis_beta_pool_reservations AS reservation'
        );
        expect(compactHold).toContain('v_existing.user_id IS DISTINCT FROM p_user_id');
        expect(compactHold).toContain(
            'v_existing_reservation.credential_slot IS DISTINCT FROM p_credential_slot'
        );
        expect(compactHold).toContain(
            'v_existing_reservation.reserved_usd IS DISTINCT FROM p_target_profile_budget_usd'
        );
        expect(hold).toContain('ANALYSIS_BETA_ALLOCATION_CONFLICT');
        expect(hold).toContain('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE');
    });

    it('activates one pending beta request with an exact complete immutable map', () => {
        const activate = functionDefinition(
            'activate_analysis_beta_apify_request_credit'
        );
        const compactActivate = compactSql(activate);

        expect(activate).toContain('RETURNS JSONB');
        expect(activate).toContain('SECURITY DEFINER');
        expect(activate).toContain("SET search_path = ''");
        expect(compactActivate).toContain(
            'public.analysis_beta_valid_operation_slot_map(p_operation_slot_map)'
        );
        expect(compactActivate).toContain(
            'public.analysis_beta_valid_operation_budget_map(p_operation_budget_map)'
        );
        expect(activate).toContain(
            "p_selected_plan_id NOT IN ('basic', 'standard', 'plus')"
        );
        expect(activate).toContain('FROM public.analysis_preflights AS preflight');
        expect(activate).toContain('FROM public.analysis_beta_pool_allocations AS allocation');
        expect(activate).toContain('FROM public.analysis_requests AS analysis_request');
        expect(activate).toContain('FROM public.analysis_pipeline_jobs AS job');
        expect(activate).toContain('ORDER BY job.job_key');
        expect(activate).toContain('FOR UPDATE');
        expect(activate).toContain(
            "v_request.pipeline_version IS DISTINCT FROM 'v2'"
        );
        expect(activate).toContain(
            "v_request.plan_access_mode_snapshot IS DISTINCT FROM 'production'"
        );
        expect(activate).toContain('v_request.test_entitlement_jti_hash IS NOT NULL');
        expect(activate).toContain("v_request.status IS DISTINCT FROM 'pending'");
        expect(activate).toContain(
            'v_request.background_processing IS DISTINCT FROM FALSE'
        );
        expect(activate).toContain(
            "v_job.dispatch_state IS DISTINCT FROM 'pending'"
        );
        expect(activate).toContain('v_job_count = 0');
        expect(activate).toContain('analysis_v2_provider_runs');
        expect(activate).toContain(
            "v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'"
        );
        expect(activate).toContain(
            'FROM public.analysis_beta_access_grants AS grant_row'
        );
        expect(activate).toContain('v_grant.enabled IS DISTINCT FROM TRUE');
        expect(activate).toContain('v_grant.expires_at <= v_now');
        expect(activate).toContain("p_operation_slot_map->>'target-profile'");
        expect(activate).toContain("p_operation_budget_map->>'target-profile'");
        expectCanonicalSnapshotLocks(activate);
        expect(activate).toContain("operation_family <> 'target-profile'");
        expect(activate).toContain(
            'INSERT INTO public.analysis_beta_pool_reservations'
        );
        expect(activate).toContain("lifecycle_state = 'active'");
        expect(activate).toContain('operation_slot_map = p_operation_slot_map');
        expect(activate).toContain('operation_budget_map = p_operation_budget_map');
        expect(activate).toContain("analysis_entry_channel = 'betatest'");
        expectServiceOnlyRpc(
            'activate_analysis_beta_apify_request_credit(UUID,UUID,UUID,TEXT,JSONB,JSONB,INTEGER)'
        );
    });

    it('makes activation replay exact and conflicts on request, plan, or maps', () => {
        const activate = functionDefinition(
            'activate_analysis_beta_apify_request_credit'
        );
        const compactActivate = compactSql(activate);

        expect(activate).toContain('v_existing.lifecycle_state = \'active\'');
        expect(compactActivate).toContain('v_existing.request_id IS DISTINCT FROM p_request_id');
        expect(compactActivate).toContain(
            'v_existing.selected_plan_id IS DISTINCT FROM p_selected_plan_id'
        );
        expect(compactActivate).toContain(
            'v_existing.operation_slot_map IS DISTINCT FROM p_operation_slot_map'
        );
        expect(compactActivate).toContain(
            'v_existing.operation_budget_map IS DISTINCT FROM p_operation_budget_map'
        );
        expect(activate).toContain('ANALYSIS_BETA_ALLOCATION_CONFLICT');
        expect(activate).toContain('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE');
    });

    it('recreates the sanitized pool read with reservation-aware nonnegative headroom', () => {
        const load = functionDefinition('load_analysis_beta_apify_credit_pool');

        expect(load).toContain('SECURITY DEFINER');
        expect(load).toContain("SET search_path = ''");
        expect(load).toContain('p_max_age_seconds BETWEEN 1 AND 900');
        expect(load).toContain(
            'FROM public.analysis_beta_pool_reservations AS reservation'
        );
        expect(load).toContain("reservation.lifecycle_state IN ('preflight_held', 'active')");
        expect(load).toContain('pg_catalog.sum(reservation.reserved_usd)');
        expect(load).toContain('snapshot.monthly_limit_usd');
        expect(load).toContain('snapshot.monthly_usage_usd');
        expect(load).toContain("'effectiveHeadroomUsd'");
        expect(load).toContain('GREATEST(');
        expect(load).not.toMatch(
            /allocationId|preflightId|requestId|userId|token|provider_account|raw_payload/i
        );
        expectServiceOnlyRpc('load_analysis_beta_apify_credit_pool(INTEGER)');
    });

    it('uses bounded database-clock errors and no forbidden provider identities', () => {
        expect(migration).toContain('pg_catalog.clock_timestamp()');
        for (const code of [
            'ANALYSIS_BETA_GRANT_INVALID',
            'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            'ANALYSIS_BETA_ALLOCATION_INVALID',
            'ANALYSIS_BETA_ALLOCATION_CONFLICT',
            'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
            'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
            'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY',
            'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
        ]) {
            expect(migration).toContain(code);
        }
        expect(migration).not.toMatch(
            /APIFY_[A-Z_]*TOKEN|provider_account|account_identifier|raw_payload|cookie_value/i
        );
    });
});
