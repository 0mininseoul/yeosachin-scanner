import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schemaMigrationUrl = new URL(
    '../../../supabase/migrations/20260802100000_harden_betatest_entry_lifecycle.sql',
    import.meta.url
);
const runtimeMigrationUrl = new URL(
    '../../../supabase/migrations/20260802100100_harden_betatest_entry_lifecycle_runtime.sql',
    import.meta.url
);
const validationMigrationUrl = new URL(
    '../../../supabase/migrations/20260802100200_validate_betatest_entry_lifecycle.sql',
    import.meta.url
);
const schemaMigration = existsSync(schemaMigrationUrl)
    ? readFileSync(schemaMigrationUrl, 'utf8') : '';
const migration = existsSync(runtimeMigrationUrl)
    ? readFileSync(runtimeMigrationUrl, 'utf8') : '';
const validationMigration = existsSync(validationMigrationUrl)
    ? readFileSync(validationMigrationUrl, 'utf8') : '';
const combinedMigrations = [schemaMigration, migration, validationMigration].join('\n');
const normalizedMigration = combinedMigrations
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s*/g, ', ')
    .trim();

function body(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
    const start = migration.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + marker.length);
    return migration.slice(start, next < 0 ? undefined : next);
}

describe('betatest entry lifecycle hardening migration', () => {
    it('adds append-only provenance, fenced prepare state, and a disabled operational gate', () => {
        expect(schemaMigration).toContain('ADD COLUMN beta_entry_provenance');
        expect(schemaMigration).toContain('ADD COLUMN beta_prepare_generation');
        expect(schemaMigration).toContain('ADD COLUMN beta_prepare_token');
        expect(schemaMigration).toContain('ADD COLUMN beta_prepare_state');
        expect(schemaMigration).toContain('ADD COLUMN beta_prepare_retry_exhausted_at');
        expect(schemaMigration).toContain('CREATE TABLE public.analysis_beta_runtime_gate');
        expect(schemaMigration).toMatch(/VALUES\s*\(TRUE, FALSE/);
        expect(schemaMigration).toMatch(
            /analysis_preflights_beta_prepare_shape_check[\s\S]*?NOT VALID/
        );
        expect(schemaMigration).toContain("'expired'");
        expect(validationMigration).toContain(
            'VALIDATE CONSTRAINT analysis_preflights_beta_prepare_shape_check'
        );
        expect(migration).toContain('normalize_analysis_beta_prepare_expiry');
    });

    it('creates and replays beta provenance only through one service-only RPC', () => {
        const create = body('create_or_replay_analysis_v2_betatest_preflight(');
        expect(create).toContain("'betatest_service_v1'");
        expect(create).toContain("'standard'");
        expect(create).toContain('p_beta_prepare_token');
        expect(create).toContain('FOR UPDATE');
        expect(create).toMatch(
            /FROM public\.users AS owner_user[\s\S]*?FOR UPDATE/
        );
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_or_replay_analysis_v2_betatest_preflight\([\s\S]*?TO service_role/);
        expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.create_or_replay_analysis_v2_betatest_preflight\([\s\S]*?TO authenticated/);
    });

    it('fences ordinary create and dispatch from beta provenance before prepare succeeds', () => {
        const ordinaryCreate = body('create_or_replay_analysis_v2_preflight(');
        const reserve = body('reserve_analysis_v2_preflight_dispatch(');
        expect(ordinaryCreate).toContain('beta_entry_provenance');
        expect(ordinaryCreate).toContain('ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT');
        expect(reserve).toContain("beta_prepare_state IS DISTINCT FROM 'prepared'");
        expect(reserve).toContain('ANALYSIS_BETA_PREPARE_REQUIRED');
    });

    it('claims generation and token before refresh and terminalizes capacity atomically', () => {
        const claim = body('claim_analysis_beta_preflight_prepare(');
        expect(claim).toContain('v_preflight.expires_at <= v_now');
        expect(claim).toContain("SET status='expired'");
        expect(claim).toContain("'expired'::TEXT, 'terminal'::TEXT");
        expect(claim).toContain("IN ('prepared','capacity_blocked','expired')");
        expect(body('mark_analysis_beta_preflight_prepare_retry_exhausted('))
            .toContain("IN ('prepared','capacity_blocked','expired')");
        expect(body('block_analysis_beta_preflight_capacity('))
            .toContain("beta_prepare_state='expired' THEN RETURN 'expired'");
        const block = body('block_analysis_beta_preflight_capacity(');
        expect(claim).toContain('p_prepare_generation');
        expect(claim).toContain('p_prepare_token');
        expect(claim).toContain('beta_prepare_lease_token');
        expect(claim).toContain("'stale'::TEXT");
        expect(claim).toContain("'busy'::TEXT");
        expect(claim.indexOf('FROM public.analysis_beta_runtime_gate')).toBeLessThan(
            claim.indexOf('FROM public.analysis_preflights')
        );
        expect(block).toMatch(/status\s*=\s*'blocked'/);
        expect(block).toMatch(/error_code\s*=\s*'BETA_CAPACITY_UNAVAILABLE'/);
        expect(block).toMatch(/beta_prepare_state\s*=\s*'capacity_blocked'/);
        expect(block).toContain('analysis_beta_pool_allocations');
    });

    it('gates only new beta preflight/fresh provider authorizations and preserves replay', () => {
        for (const name of [
            'reserve_analysis_preflight_provider_run(',
            'reserve_analysis_v2_fresh_admission_provider_run(',
        ]) {
            const functionBody = body(name);
            expect(functionBody).toContain('analysis_beta_runtime_gate');
            expect(functionBody).toContain('analysis_beta_access_grants');
            expect(functionBody.indexOf('IF FOUND THEN')).toBeLessThan(
                functionBody.indexOf('ANALYSIS_BETA_RUNTIME_DISABLED')
            );
            expect(functionBody).toMatch(
                /v_now\s+TIMESTAMPTZ/
            );
            expect(functionBody.match(
                /v_now\s*:=\s*pg_catalog\.clock_timestamp\(\)/g
            )?.length ?? 0).toBeGreaterThanOrEqual(3);
        }
        expect(migration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_provider_run('
        );
    });

    it('rechecks beta exclusion mutations in the database and hardens privileges', () => {
        const exclusion = body('set_analysis_v2_preflight_exclusion(');
        expect(exclusion).toContain('beta_entry_provenance');
        expect(exclusion).toContain('analysis_beta_runtime_gate');
        expect(exclusion).toContain('analysis_beta_access_grants');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain(
            "PERFORM pg_catalog.set_config('lock_timeout', '5s', true);"
        );
        expect(migration).toContain(
            "PERFORM pg_catalog.set_config('statement_timeout', '2min', true);"
        );
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.set_analysis_v2_preflight_exclusion/);
    });

    it('renames only the exact current overloads and keeps every unfenced implementation private', () => {
        const privateOverloads = [
            {
                original:
                    'create_or_replay_analysis_v2_preflight(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB)',
                renamed:
                    'analysis_v2_create_or_replay_preflight_unfenced_20260802(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB)',
            },
            {
                original:
                    'hold_analysis_beta_apify_preflight_credit(UUID, UUID, TEXT, NUMERIC, INTEGER)',
                renamed:
                    'hold_analysis_beta_apify_preflight_credit_unfenced_20260802(UUID, UUID, TEXT, NUMERIC, INTEGER)',
            },
            {
                original: 'reserve_analysis_v2_preflight_dispatch(UUID, UUID, UUID)',
                renamed:
                    'reserve_analysis_v2_preflight_dispatch_unfenced_20260802(UUID, UUID, UUID)',
            },
        ];

        for (const overload of privateOverloads) {
            expect(normalizedMigration).toContain(
                `ALTER FUNCTION public.${overload.original} RENAME TO ${overload.renamed.slice(0, overload.renamed.indexOf('('))}`
            );
            expect(normalizedMigration).toContain(
                `REVOKE ALL ON FUNCTION public.${overload.renamed} FROM PUBLIC, anon, authenticated, service_role`
            );
            expect(normalizedMigration).not.toContain(
                `GRANT EXECUTE ON FUNCTION public.${overload.renamed}`
            );
        }
    });

    it('sets bounded runtime lock/statement timeouts on every new locking boundary', () => {
        for (const name of [
            'set_analysis_beta_runtime_gate(',
            'create_or_replay_analysis_v2_preflight(',
            'create_or_replay_analysis_v2_betatest_preflight(',
            'mark_analysis_beta_preflight_prepare_dispatched(',
            'mark_analysis_beta_preflight_prepare_retry_exhausted(',
            'claim_analysis_beta_preflight_prepare(',
            'release_analysis_beta_preflight_prepare_claim(',
            'block_analysis_beta_preflight_capacity(',
            'release_analysis_beta_preflight_prepare_claim(',
            'hold_analysis_beta_apify_preflight_credit(',
            'prepare_analysis_beta_apify_preflight_credit(',
            'block_analysis_beta_preflight_capacity(',
            'reserve_analysis_v2_preflight_dispatch(',
            'set_analysis_v2_preflight_exclusion(',
            'reserve_analysis_preflight_provider_run(',
            'reserve_analysis_v2_fresh_admission_provider_run(',
            'admit_analysis_v2_betatest_plan(',
        ]) {
            const functionBody = body(name);
            expect(functionBody).toContain("SET lock_timeout = '5s'");
            expect(functionBody).toContain("SET statement_timeout = '2min'");
        }
    });

    it('serializes gate and grant revocation before every beta authorization mutation', () => {
        for (const name of [
            'create_or_replay_analysis_v2_betatest_preflight(',
            'mark_analysis_beta_preflight_prepare_dispatched(',
            'mark_analysis_beta_preflight_prepare_retry_exhausted(',
            'claim_analysis_beta_preflight_prepare(',
            'set_analysis_v2_preflight_exclusion(',
            'reserve_analysis_preflight_provider_run(',
            'reserve_analysis_v2_fresh_admission_provider_run(',
            'admit_analysis_v2_betatest_plan(',
        ]) {
            const functionBody = body(name);
            expect(functionBody).toMatch(
                /analysis_beta_runtime_gate[\s\S]*?FOR SHARE/
            );
            expect(functionBody).toMatch(
                /analysis_beta_access_grants[\s\S]*?FOR (?:SHARE|UPDATE)/
            );
            const gate = functionBody.indexOf('FROM public.analysis_beta_runtime_gate');
            const preflight = functionBody.indexOf(
                'FROM public.analysis_preflights', gate
            );
            const grant = functionBody.indexOf('FROM public.analysis_beta_access_grants');
            expect(gate).toBeLessThan(preflight);
            expect(preflight).toBeLessThan(grant);
        }
    });

    it('takes the prepare grant update lock only after the fenced preflight and allocation', () => {
        const prepare = body('prepare_analysis_beta_apify_preflight_credit(');
        const preflight = prepare.indexOf('FROM public.analysis_preflights');
        const allocation = prepare.indexOf('FROM public.analysis_beta_pool_allocations');
        const grant = prepare.indexOf('FROM public.analysis_beta_access_grants');
        const inner = prepare.indexOf(
            'hold_analysis_beta_apify_preflight_credit_unfenced_20260802'
        );
        expect(prepare).toMatch(/analysis_beta_access_grants[\s\S]*?FOR UPDATE/);
        expect(preflight).toBeLessThan(allocation);
        expect(allocation).toBeLessThan(grant);
        expect(grant).toBeLessThan(inner);
    });

    it('gates only fresh held plan admission behind the canonical entry fence', () => {
        const admit = body('admit_analysis_v2_betatest_plan(');
        expect(admit).toContain('analysis_v2_betatest_plan_replay_internal');
        expect(admit).toContain('analysis_v2_admit_betatest_plan_ungated_20260802');
        expect(admit).toContain('beta_entry_provenance');
        expect(admit).toContain("beta_prepare_state IS DISTINCT FROM 'prepared'");
        expect(admit).toMatch(/analysis_beta_runtime_gate[\s\S]*?FOR SHARE/);
        expect(admit).toMatch(/analysis_beta_access_grants[\s\S]*?FOR UPDATE/);
        const gate = admit.indexOf('FROM public.analysis_beta_runtime_gate');
        const preflight = admit.indexOf('FROM public.analysis_preflights', gate);
        expect(gate).toBeLessThan(preflight);
        expect(preflight).toBeLessThan(
            admit.indexOf('FROM public.analysis_beta_pool_allocations')
        );
        expect(admit.indexOf('FROM public.analysis_beta_pool_allocations')).toBeLessThan(
            admit.indexOf('FROM public.analysis_beta_access_grants')
        );
        expect(normalizedMigration).toContain(
            'ALTER FUNCTION public.admit_analysis_v2_betatest_plan(UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER) RENAME TO analysis_v2_admit_betatest_plan_ungated_20260802'
        );
        expect(normalizedMigration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_admit_betatest_plan_ungated_20260802(UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER) FROM PUBLIC, anon, authenticated, service_role'
        );
    });

    it('promotes an exact-six hold to prepared in the same fenced database call', () => {
        const historicalHold = body('hold_analysis_beta_apify_preflight_credit(');
        expect(historicalHold).toContain('ANALYSIS_BETA_PREPARE_REQUIRED');
        expect(historicalHold).not.toContain('GRANT EXECUTE');
        const hold = body('prepare_analysis_beta_apify_preflight_credit(');
        expect(hold).toContain('hold_analysis_beta_apify_preflight_credit_unfenced_20260802');
        expect(hold).toContain("beta_prepare_state='prepared'");
        expect(hold).toContain("beta_prepare_dispatch_state='completed'");
        expect(hold.indexOf('hold_analysis_beta_apify_preflight_credit_unfenced_20260802'))
            .toBeLessThan(hold.indexOf("beta_prepare_state='prepared'"));
    });

    it('keeps immediate replay stable and rearms only persisted stale/exhausted work', () => {
        const create = body('create_or_replay_analysis_v2_betatest_preflight(');
        const exhaust = body('mark_analysis_beta_preflight_prepare_retry_exhausted(');
        expect(create).toContain('beta_prepare_retry_exhausted_at IS NOT NULL');
        expect(create).toContain('beta_prepare_lease_expires_at <= v_now');
        expect(create).toContain('beta_prepare_generation + 1');
        expect(create).toContain('beta_prepare_token = p_beta_prepare_token');
        expect(exhaust).toContain("beta_prepare_dispatch_state='completed'");
        expect(exhaust).toContain("beta_prepare_state='reserved'");
        expect(exhaust).toContain("SET lock_timeout = '5s'");
    });

    it('loads consumed beta identity before fresh admission through one service-only integrity replay', () => {
        const replay = body('load_analysis_v2_betatest_consumed_replay(');
        expect(replay).toContain("v_preflight.status IS DISTINCT FROM 'consumed'");
        expect(replay).toContain('beta_entry_provenance');
        expect(replay).toContain('admission_selected_plan_id');
        expect(replay).toContain('ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT');
        expect(replay).toContain('analysis_v2_betatest_plan_replay_internal');
        expect(replay).toContain("SET lock_timeout = '5s'");
        expect(replay).toContain("SET statement_timeout = '2min'");
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_betatest_consumed_replay\([\s\S]*?TO service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_betatest_consumed_replay\([\s\S]*?TO authenticated/
        );
    });
});
