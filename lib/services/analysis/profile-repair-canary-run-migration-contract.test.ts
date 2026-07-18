import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260718123000_add_profile_repair_canary_journal.sql',
        import.meta.url
    ),
    'utf8'
);

const sourcePolicyFixMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260718124500_fix_profile_repair_canary_source_policy.sql',
        import.meta.url
    ),
    'utf8'
);

function tableDefinition(): string {
    const start = migration.indexOf(
        'CREATE TABLE public.analysis_v2_profile_repair_canary_runs ('
    );
    const end = migration.indexOf('\n);', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end + 3);
}

const publicRpcs = [
    'load_analysis_v2_profile_repair_canary_source',
    'load_analysis_v2_profile_repair_canary_run',
    'reserve_analysis_v2_profile_repair_canary_run',
    'checkpoint_analysis_v2_profile_repair_canary_run_started',
    'mark_analysis_v2_profile_repair_canary_run_ambiguous',
    'terminalize_analysis_v2_profile_repair_canary_run',
    'reconcile_analysis_v2_profile_repair_canary_run_usage',
];

describe('profile repair canary journal migration contract', () => {
    it('uses a deterministic fixed canary identity and a PII-free bounded schema', () => {
        const table = tableDefinition();
        expect(table).toContain(
            'PRIMARY KEY (source_request_id, canary_version, repetition)'
        );
        expect(table).toContain(
            "canary_version TEXT NOT NULL DEFAULT 'profile-repair-canary-v1'"
        );
        expect(table).toContain(
            "actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper'"
        );
        expect(table).toContain('requested_count INTEGER NOT NULL DEFAULT 15');
        expect(table).toContain('max_charge_usd NUMERIC(18, 12) NOT NULL DEFAULT 0.050000000000');
        expect(table).toContain(
            "state IN ('starting', 'running', 'succeeded', 'failed', 'ambiguous')"
        );
        expect(table).toContain(
            "cost_status IN ('actual', 'conservative', 'unknown')"
        );
        expect(table).toContain('critical_recovered_count IS NOT NULL');
        expect(table).toContain('gate_passed IS NOT NULL');
        expect(table).toContain(
            'REFERENCES public.analysis_requests(id) ON DELETE CASCADE'
        );
        expect(table).toContain('UNIQUE (run_id)');
        expect(table).toContain('UNIQUE (reservation_token)');

        expect(table).not.toMatch(
            /username|owner_email|url|payload|provider_message|raw_error|dataset_id|input_hash|fingerprint|api_token/i
        );
        expect(table).not.toContain('JSONB');
    });

    it('forces RLS and exposes neither direct table DML nor permissive policies', () => {
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_profile_repair_canary_runs ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_profile_repair_canary_runs FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_profile_repair_canary_runs\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL).*analysis_v2_profile_repair_canary_runs/i
        );
        expect(migration).not.toMatch(
            /CREATE POLICY[\s\S]{0,300}analysis_v2_profile_repair_canary_runs/i
        );
    });

    it('keeps every source and journal RPC service-role-only', () => {
        for (const rpc of publicRpcs) {
            expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${rpc}(`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([\\s\\S]*?TO service_role`
            ));
        }
        expect(migration.match(/SECURITY DEFINER/g)?.length).toBe(publicRpcs.length);
        expect(migration.match(/SECURITY DEFINER\s+SET search_path = ''/g)?.length)
            .toBe(publicRpcs.length);
    });

    it('loads only the authorized failed V2 source and its ledger-owned profile runs', () => {
        const source = sourcePolicyFixMigration.slice(
            sourcePolicyFixMigration.indexOf(
                'CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_repair_canary_source('
            ),
            sourcePolicyFixMigration.indexOf(
                'CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_repair_canary_run('
            )
        );
        expect(source).toContain('p_credential_slot TEXT');
        expect(source).toContain("analysis_request.pipeline_version = 'v2'");
        expect(source).toContain("analysis_request.status = 'failed'");
        expect(source).toContain(
            'JOIN public.analysis_v2_provider_execution_policies AS execution_policy'
        );
        expect(source).toContain("execution_policy.mode = 'test_operation_split'");
        expect(source).toContain(
            "execution_policy.policy_version = 'authorized-free-e2e-v1'"
        );
        expect(source).toContain("execution_policy.target_instagram_id = '0_min._.00'");
        expect(source).toContain(
            "execution_policy.operation_slot_map->>'profile-fallback' = p_credential_slot"
        );
        expect(source).toContain(
            'provider_run.credential_slot = p_credential_slot'
        );
        expect(source).toMatch(
            /analysis_request\.test_entitlement_jti_hash\s*=\s*execution_policy\.entitlement_jti_hash/
        );
        expect(source).toContain(
            'JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption'
        );
        expect(source).toContain('JOIN public.analysis_preflights AS preflight');
        expect(source).toContain("entitlement_consumption.selected_plan_id = 'standard'");
        expect(source).toMatch(
            /analysis_request\.selected_plan_id_snapshot\s*=\s*entitlement_consumption\.selected_plan_id/
        );
        expect(source).toContain('analysis_request.preflight_id = preflight.id');
        expect(source).toContain("preflight.status = 'consumed'");
        expect(source).toContain('preflight.pii_scrubbed_at IS NOT NULL');
        expect(source).toContain("analysis_request.plan_access_mode_snapshot = 'test_entitlement'");
        expect(source).toContain("'targetInstagramId', v_authorized_target_instagram_id");
        expect(source).not.toContain(
            "analysis_request.target_instagram_id = '0_min._.00'"
        );
        expect(source).toContain('analysis_request.user_id = p_owner_id');
        expect(source).toContain('pg_catalog.lower(owner.email) = pg_catalog.lower(p_owner_email)');
        expect(source).toContain('FROM public.analysis_v2_provider_runs AS provider_run');
        expect(source).toContain("provider_run.job_key ~ '^track:profiles:batch:");
        expect(source).toContain("provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'");
        expect(source).not.toContain('provider_run.input_hash');
        expect(source).not.toContain('provider_run.job_claim_token');
        expect(source).not.toContain('provider_run.reservation_token');
        expect(source).not.toContain('earlybird_');
    });

    it('repeats the scrubbed authorized lineage gate before any paid reservation', () => {
        const reserve = sourcePolicyFixMigration.slice(
            sourcePolicyFixMigration.indexOf(
                'CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_repair_canary_run('
            )
        );
        expect(reserve).toContain(
            'JOIN public.analysis_v2_provider_execution_policies AS execution_policy'
        );
        expect(reserve).toContain(
            'JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption'
        );
        expect(reserve).toContain('JOIN public.analysis_preflights AS preflight');
        expect(reserve).toContain("execution_policy.target_instagram_id = '0_min._.00'");
        expect(reserve).toContain(
            "execution_policy.operation_slot_map->>'profile-fallback' = p_credential_slot"
        );
        expect(reserve).toMatch(
            /analysis_request\.selected_plan_id_snapshot\s*=\s*entitlement_consumption\.selected_plan_id/
        );
        expect(reserve).toContain('analysis_request.preflight_id = preflight.id');
        expect(reserve).toContain("preflight.status = 'consumed'");
        expect(reserve).toContain('preflight.pii_scrubbed_at IS NOT NULL');
        expect(reserve).not.toContain(
            "v_source.target_instagram_id IS DISTINCT FROM '0_min._.00'"
        );
        expect(reserve).not.toContain('earlybird_');
    });

    it('keeps both corrected RPCs service-role-only', () => {
        expect(sourcePolicyFixMigration).toContain(
            'DROP FUNCTION public.load_analysis_v2_profile_repair_canary_source(UUID, UUID, TEXT);'
        );
        expect(sourcePolicyFixMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_profile_repair_canary_source\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(sourcePolicyFixMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_profile_repair_canary_source\([\s\S]*?TO service_role/
        );
        expect(sourcePolicyFixMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.reserve_analysis_v2_profile_repair_canary_run\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(sourcePolicyFixMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.reserve_analysis_v2_profile_repair_canary_run\([\s\S]*?TO service_role/
        );
        expect(sourcePolicyFixMigration).toContain('SECURITY DEFINER');
        expect(sourcePolicyFixMigration).toContain("SET search_path = ''");
    });

    it('makes terminal counts and actual cost idempotent but conflict-detecting', () => {
        expect(migration).toContain('PROFILE_REPAIR_CANARY_RUN_TERMINAL_CONFLICT');
        expect(migration).toContain('PROFILE_REPAIR_CANARY_RUN_RECONCILIATION_CONFLICT');
        expect(migration).toContain('p_success_count + p_unavailable_count');
        expect(migration).toContain('p_actual_usage_usd > 0.050000000000');
        expect(migration).toContain("cost_status = 'actual'");
        expect(migration).toContain("cost_status = 'unknown'");
    });
});
