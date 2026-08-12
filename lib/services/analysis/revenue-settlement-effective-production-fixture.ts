import { readFileSync } from 'node:fs';

const preflightMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713142811_add_analysis_v2_preflight.sql', import.meta.url),
    'utf8',
);
const jobMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713211500_fix_analysis_v2_preflight_claim_return_types.sql', import.meta.url),
    'utf8',
);
const freshAdmissionMigration = readFileSync(
    new URL('../../../supabase/migrations/20260714030000_add_analysis_v2_fresh_admission_gate.sql', import.meta.url),
    'utf8',
);
const policyMigration = readFileSync(
    new URL('../../../supabase/migrations/20260715103605_expose_v2_access_mode_to_collection_context.sql', import.meta.url),
    'utf8',
);
const credentialMigration = readFileSync(
    new URL('../../../supabase/migrations/20260724220000_expand_analysis_v2_apify_senary_slot.sql', import.meta.url),
    'utf8',
);
const runnerMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810074911_add_account_principal_bridge.sql', import.meta.url),
    'utf8',
);
const ledgerMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url),
    'utf8',
);
const freshHardeningMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);
const hotfixMigration = readFileSync(
    new URL('../../../supabase/migrations/20260812032216_add_authorized_revenue_settlement_readiness.sql', import.meta.url),
    'utf8',
);
const anonymousRuntimeMigration = readFileSync(
    new URL('../../../supabase/migrations/20260805092000_add_anonymous_preflight_claim_runtime.sql', import.meta.url),
    'utf8',
);
const anonymousCreateMigration = readFileSync(
    new URL('../../../supabase/migrations/20260807011858_align_anonymous_preflight_claim_ttl.sql', import.meta.url),
    'utf8',
);
const anonymousClaimMigration = readFileSync(
    new URL('../../../supabase/migrations/20260807170000_ignore_expired_oauth_owner_preflight.sql', import.meta.url),
    'utf8',
);
const anonymousExclusionMigration = readFileSync(
    new URL('../../../supabase/migrations/20260806093026_allow_anonymous_preflight_exclusion_before_ready.sql', import.meta.url),
    'utf8',
);
const anonymousDispatchMigration = readFileSync(
    new URL('../../../supabase/migrations/20260806084409_fix_anonymous_preflight_dispatch_generation_qualification.sql', import.meta.url),
    'utf8',
);
const authenticatedExclusionMigration = readFileSync(
    new URL('../../../supabase/migrations/20260805150000_harden_authenticated_preflight_exclusion_security_definer.sql', import.meta.url),
    'utf8',
);
const targetLineageHardeningMigration = readFileSync(
    new URL('../../../supabase/migrations/20260812085625_harden_preflight_target_lineage.sql', import.meta.url),
    'utf8',
);
const costHarness = readFileSync(
    new URL('./revenue-cost-operation-pglite.test.ts', import.meta.url),
    'utf8',
);

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`REVENUE_SETTLEMENT_EFFECTIVE_FUNCTION_MISSING:${name}`);
    const end = source.indexOf('$$;', start);
    if (end < 0) throw new Error(`REVENUE_SETTLEMENT_EFFECTIVE_FUNCTION_UNBOUNDED:${name}`);
    return source.slice(start, end + 3);
}

function harnessBootstrap(): string {
    const match = costHarness.match(/const bootstrap = `([\s\S]*?)`;\n\nasync function createDb/);
    if (!match?.[1]) throw new Error('REVENUE_SETTLEMENT_COST_BOOTSTRAP_MISSING');
    return match[1].replace(
        'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;',
        () => `DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
               DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
               DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
}

function policyDefinitions(): string {
    const start = policyMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_test_operation_slot_map(',
    );
    const end = policyMigration.indexOf(
        '$$;',
        policyMigration.indexOf(
            'CREATE OR REPLACE FUNCTION public.bind_analysis_v2_authorized_test_provider_policy(',
        ),
    );
    if (start < 0 || end < 0) throw new Error('REVENUE_SETTLEMENT_EFFECTIVE_POLICY_MISSING');
    return policyMigration.slice(start, end + 3);
}

function guardDefinitions(): string {
    const start = freshHardeningMigration.indexOf(
        'CREATE TABLE public.analysis_revenue_dispatch_guards',
    );
    const end = freshHardeningMigration.indexOf('-- A row trigger', start);
    if (start < 0 || end < 0) throw new Error('REVENUE_SETTLEMENT_EFFECTIVE_GUARD_MISSING');
    return freshHardeningMigration.slice(start, end);
}

const effectiveBaseConsumeSql = [
    functionDefinition(preflightMigration, 'analysis_v2_valid_plan_cards_snapshot'),
    functionDefinition(preflightMigration, 'analysis_v2_valid_scope_snapshot'),
    functionDefinition(preflightMigration, 'consume_analysis_v2_test_entitlement'),
    `ALTER FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT)
        RENAME TO consume_analysis_v2_test_entitlement_pre_job;`,
    functionDefinition(jobMigration, 'consume_analysis_v2_test_entitlement'),
    `ALTER FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT)
        RENAME TO analysis_v2_consume_entitlement_after_admission_internal;`,
    functionDefinition(freshAdmissionMigration, 'consume_analysis_v2_test_entitlement'),
].join('\n\n');

const effectivePolicySql = [
    functionDefinition(credentialMigration, 'analysis_v2_valid_apify_credential_slot'),
    policyDefinitions(),
].join('\n\n');

const effectiveRunnerSql = functionDefinition(
    runnerMigration,
    'load_e2e_test_runner_v1',
);

const deployedReserveSql = functionDefinition(
    freshAdmissionMigration,
    'reserve_analysis_v2_preflight_admission',
);

function anonymousRlsSql(): string {
    const start = anonymousRuntimeMigration.indexOf(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_preflights TO anon, authenticated;',
    );
    const end = anonymousRuntimeMigration.indexOf(
        '\n\nCREATE INDEX analysis_preflights_anonymous_target_idx',
        start,
    );
    if (start < 0 || end < 0) {
        throw new Error('REVENUE_SETTLEMENT_EFFECTIVE_ANONYMOUS_RLS_MISSING');
    }
    return [
        'ALTER TABLE public.analysis_preflights ENABLE ROW LEVEL SECURITY;',
        anonymousRuntimeMigration.slice(start, end),
    ].join('\n');
}

const effectiveAnonymousCapabilitySql = [
    functionDefinition(preflightMigration, 'analysis_v2_valid_launch_snapshot'),
    functionDefinition(preflightMigration, 'analysis_v2_valid_plan_catalog_snapshot'),
    functionDefinition(preflightMigration, 'analysis_v2_valid_pricing_snapshot'),
    functionDefinition(preflightMigration, 'analysis_v2_valid_policy_versions_snapshot'),
    `GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB),
        public.analysis_v2_valid_plan_catalog_snapshot(JSONB),
        public.analysis_v2_valid_pricing_snapshot(JSONB),
        public.analysis_v2_valid_policy_versions_snapshot(JSONB)
        TO anon, authenticated;`,
    functionDefinition(anonymousCreateMigration, 'create_anonymous_analysis_v2_preflight'),
    functionDefinition(anonymousClaimMigration, 'claim_anonymous_analysis_v2_preflight'),
    functionDefinition(anonymousExclusionMigration, 'set_anonymous_analysis_v2_preflight_exclusion'),
    functionDefinition(anonymousDispatchMigration, 'reserve_anonymous_analysis_v2_preflight_dispatch'),
    functionDefinition(anonymousRuntimeMigration, 'mark_anonymous_analysis_v2_preflight_dispatched'),
    functionDefinition(anonymousRuntimeMigration, 'set_authenticated_analysis_v2_preflight_exclusion'),
    authenticatedExclusionMigration,
    `REVOKE ALL ON FUNCTION public.create_anonymous_analysis_v2_preflight(
        TEXT, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ, JSONB, JSONB, VARCHAR, JSONB, JSONB
    ) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.create_anonymous_analysis_v2_preflight(
        TEXT, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ, JSONB, JSONB, VARCHAR, JSONB, JSONB
    ) TO anon, authenticated;
    REVOKE ALL ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
        FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
        TO authenticated;
    REVOKE ALL ON FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(UUID, VARCHAR, TEXT, TEXT)
        FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(UUID, VARCHAR, TEXT, TEXT)
        TO anon, authenticated;
    REVOKE ALL ON FUNCTION public.reserve_anonymous_analysis_v2_preflight_dispatch(UUID, VARCHAR, UUID)
        FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.reserve_anonymous_analysis_v2_preflight_dispatch(UUID, VARCHAR, UUID)
        TO anon, authenticated;
    REVOKE ALL ON FUNCTION public.mark_anonymous_analysis_v2_preflight_dispatched(UUID, VARCHAR, INTEGER, UUID)
        FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.mark_anonymous_analysis_v2_preflight_dispatched(UUID, VARCHAR, INTEGER, UUID)
        TO anon, authenticated;
    REVOKE ALL ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
        FROM PUBLIC, anon, service_role;
    GRANT EXECUTE ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
        TO authenticated;`,
    anonymousRlsSql(),
].join('\n\n');

export interface RevenueSettlementProductionFixtureOptions {
    includeReadinessMigration?: boolean;
    includeTargetLineageHardeningMigration?: boolean;
}

export function revenueSettlementProductionFixtureSqlForMigrationWindow({
    includeReadinessMigration = true,
    includeTargetLineageHardeningMigration = true,
}: RevenueSettlementProductionFixtureOptions = {}): string {
    return [
    harnessBootstrap(),
    `
DROP FUNCTION public.load_e2e_test_runner_v1(UUID);
DROP TABLE public.account_e2e_test_runners;
DROP TABLE public.analysis_v2_provider_execution_policies;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    raw_app_meta_data JSONB NOT NULL
);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    account_class TEXT NOT NULL,
    traffic_class TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    classification_version TEXT NOT NULL
);
CREATE TABLE public.account_ledger_rollout_state (
    singleton BOOLEAN PRIMARY KEY,
    paid_ever_state TEXT NOT NULL,
    classification_command_version TEXT NOT NULL
);
CREATE TABLE public.account_e2e_test_runners (
    account_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    runner_plan TEXT NOT NULL UNIQUE CHECK (runner_plan IN ('basic', 'standard')),
    command_version TEXT NOT NULL
);

ALTER TABLE public.analysis_requests
    ADD COLUMN target_gender TEXT,
    ADD COLUMN progress INTEGER,
    ADD COLUMN progress_step TEXT,
    ADD COLUMN current_step TEXT,
    ADD COLUMN step_data JSONB,
    ADD COLUMN gender_stats JSONB,
    ADD COLUMN plan_type TEXT,
    ADD COLUMN background_processing BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN idempotency_key TEXT,
    ADD COLUMN excluded_instagram_id TEXT,
    ADD COLUMN exclusion_decision_snapshot TEXT,
    ADD COLUMN capacity_required_plan_id_snapshot TEXT,
    ADD COLUMN required_plan_id_snapshot TEXT,
    ADD COLUMN plan_launch_status_snapshot JSONB,
    ADD COLUMN plan_cards_snapshot JSONB,
    ADD COLUMN pricing_version_snapshot TEXT,
    ADD COLUMN pricing_snapshot JSONB,
    ADD COLUMN analysis_scope_snapshot JSONB,
    ADD COLUMN policy_versions_snapshot JSONB;
ALTER TABLE public.analysis_preflights
    ADD COLUMN expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN target_followers_count INTEGER,
    ADD COLUMN target_following_count INTEGER,
    ADD COLUMN exclusion_decision TEXT NOT NULL DEFAULT 'skip',
    ADD COLUMN excluded_instagram_id TEXT,
    ADD COLUMN capacity_required_plan_id TEXT,
    ADD COLUMN required_plan_id TEXT,
    ADD COLUMN plan_catalog_snapshot JSONB,
    ADD COLUMN plan_cards_snapshot JSONB,
    ADD COLUMN pricing_version TEXT,
    ADD COLUMN pricing_snapshot JSONB,
    ADD COLUMN launch_status_snapshot JSONB,
    ADD COLUMN policy_versions_snapshot JSONB,
    ADD COLUMN idempotency_key VARCHAR(128),
    ADD COLUMN provider_selector TEXT NOT NULL DEFAULT 'selfhosted_auth',
    ADD COLUMN claim_token_hash VARCHAR(64),
    ADD COLUMN claim_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN claimed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN lease_token UUID,
    ADD COLUMN lease_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN exclusion_decided_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN dispatch_generation INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN dispatch_token UUID,
    ADD COLUMN dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN dispatched_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN beta_entry_provenance TEXT,
    ADD COLUMN created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    ADD COLUMN consumed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    ADD COLUMN admission_token UUID,
    ADD COLUMN admission_requested_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_claim_token UUID,
    ADD COLUMN admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_dispatch_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN admission_dispatch_generation INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN admission_dispatch_token UUID,
    ADD COLUMN admission_dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_dispatched_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_error_code TEXT,
    ADD COLUMN admission_capacity_required_plan_id TEXT,
    ADD COLUMN admission_required_plan_id TEXT,
    ADD COLUMN admission_plan_cards_snapshot JSONB,
    ADD COLUMN admission_failure_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN admission_last_error_code TEXT;
ALTER TABLE public.analysis_preflight_provider_runs
    ADD COLUMN input_hash TEXT;
ALTER TABLE public.analysis_v2_test_entitlement_consumptions
    ADD COLUMN consumed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp();
ALTER TABLE public.analysis_pipeline_jobs
    ADD COLUMN track TEXT,
    ADD COLUMN kind TEXT,
    ADD COLUMN batch INTEGER;
`,
    `CREATE OR REPLACE FUNCTION public.analysis_beta_has_access()
     RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT TRUE $$;`,
    effectiveAnonymousCapabilitySql,
    effectiveBaseConsumeSql,
    effectivePolicySql,
    effectiveRunnerSql,
    deployedReserveSql,
    ledgerMigration,
    guardDefinitions(),
        ...(includeReadinessMigration ? [hotfixMigration] : []),
        ...(includeTargetLineageHardeningMigration ? [targetLineageHardeningMigration] : []),
    ].join('\n\n');
}

export const revenueSettlementProductionFixtureSql =
    revenueSettlementProductionFixtureSqlForMigrationWindow();
export const revenueSettlementReadinessMigrationSql = hotfixMigration;

export const revenueSettlementEffectiveDefinitionEvidence = {
    baseConsume: effectiveBaseConsumeSql,
    policy: effectivePolicySql,
    readiness: functionDefinition(
        hotfixMigration,
        'prepare_analysis_v2_authorized_revenue_settlement_admission',
    ),
    hotfixAuthorizedConsume: functionDefinition(
        hotfixMigration,
        'consume_analysis_v2_authorized_test_entitlement',
    ),
    targetLineageHardening: targetLineageHardeningMigration,
    ledger: functionDefinition(ledgerMigration, 'begin_analysis_revenue_cost_ledger_v1'),
    guard: functionDefinition(freshHardeningMigration, 'activate_analysis_revenue_dispatch_guard_v1'),
};
