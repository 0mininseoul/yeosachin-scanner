import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = '20260714030000_add_analysis_v2_fresh_admission_gate.sql';
const migration = readFileSync(new URL(migrationName, migrationsUrl), 'utf8');

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const current = source.indexOf(fragment, previous + 1);
        expect(current, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = current;
    }
}

describe('analysis V2 fresh admission migration contract', () => {
    it('runs after the current progress and profile-heartbeat schema', () => {
        const names = readdirSync(migrationsUrl).sort();
        expect(names.indexOf('20260714023000_add_analysis_v2_neutral_shortlist_progress.sql'))
            .toBeLessThan(names.indexOf(migrationName));
        expect(names.indexOf('20260714024500_add_analysis_v2_active_profile_heartbeats.sql'))
            .toBeLessThan(names.indexOf(migrationName));
    });

    it('reserves an owner-fenced generation without doing upstream work in Vercel', () => {
        const reserve = functionDefinition('reserve_analysis_v2_preflight_admission');
        expectInOrder(reserve, [
            'FROM public.analysis_preflights AS preflight',
            'preflight.user_id = p_user_id',
            'FOR UPDATE;',
            "v_preflight.status <> 'ready'",
            'public.analysis_v2_valid_plan_catalog_snapshot',
            'v_same_attempt :=',
            'v_effective_token := CASE',
            "v_preflight.admission_status IN ('ready', 'blocked')",
            "v_now - INTERVAL '2 minutes'",
            "v_preflight.admission_status = 'processing'",
            'v_preflight.admission_lease_expires_at <= v_now',
            "SET admission_status = 'pending'",
            "v_preflight.admission_status = 'processing'",
            'v_preflight.admission_lease_expires_at > v_now',
            "v_preflight.admission_status = 'pending'",
            "v_preflight.admission_dispatch_state = 'enqueued'",
            "v_preflight.admission_dispatch_state = 'reserved'",
            "admission_dispatch_state = 'reserved'",
            'admission_dispatch_generation = v_preflight.admission_dispatch_generation + 1',
            'admission_generation = v_preflight.admission_generation + 1',
        ]);
        expect(reserve).toContain(
            'admission_entitlement_jti_hash = p_entitlement_jti_hash'
        );
        expect(reserve).toContain('admission_token = v_effective_token');
        expect(reserve).toContain('admission_dispatch_token = p_dispatch_token');
        expect(reserve).toContain('admission_dispatch_reserved_at = v_now');
        expect(reserve).toContain('v_preflight.pricing_version::TEXT');
        expect(reserve).not.toMatch(/instagram\.com|apify|rapidapi|coderx|flashapi/i);
    });

    it('claims and commits only the exact durable generation before exposing plan results', () => {
        const claim = functionDefinition('claim_analysis_v2_preflight_admission');
        expectInOrder(claim, [
            'FROM public.analysis_preflights AS preflight',
            'FOR UPDATE;',
            'v_preflight.admission_generation <> p_admission_generation',
            'v_preflight.admission_dispatch_generation <> p_dispatch_generation',
            'v_preflight.admission_dispatch_token IS DISTINCT FROM p_dispatch_token',
            "v_preflight.admission_status = 'processing'",
            "SET admission_status = 'processing'",
            'admission_claim_token = p_claim_token',
            "admission_dispatch_state = 'enqueued'",
        ]);
        expect(claim).toContain('v_preflight.target_instagram_id::TEXT');

        const complete = functionDefinition('complete_analysis_v2_preflight_admission');
        expectInOrder(complete, [
            'preflight.admission_generation = p_admission_generation',
            "preflight.admission_status = 'processing'",
            'preflight.admission_claim_token = p_claim_token',
            'FOR UPDATE;',
            'v_capacity_required_plan_id := v_plan_id',
            'v_required_plan_id := v_plan_id',
            'v_cards := v_cards',
            'UPDATE public.analysis_preflights AS preflight',
            'admission_refreshed_at = v_now',
            'admission_target_followers_count = p_target_followers_count',
            'admission_target_following_count = p_target_following_count',
            'admission_plan_cards_snapshot = v_cards',
        ]);
        for (const invariant of [
            "v_error_code := 'ANALYSIS_V2_OVER_PLUS_CAPACITY'",
            "v_error_code := 'ANALYSIS_V2_PLAN_NOT_ALLOWED'",
            'public.analysis_v2_valid_plan_cards_snapshot',
            "v_preflight.target_instagram_id IS DISTINCT FROM p_target_instagram_id",
        ]) {
            expect(complete).toContain(invariant);
        }
    });

    it('exposes admission lifecycle RPCs only to service_role', () => {
        for (const name of [
            'reserve_analysis_v2_preflight_admission',
            'mark_analysis_v2_preflight_admission_dispatched',
            'release_analysis_v2_preflight_admission_dispatch',
            'claim_analysis_v2_preflight_admission',
            'release_analysis_v2_preflight_admission',
            'record_analysis_v2_preflight_admission_failure',
            'block_analysis_v2_preflight_admission',
            'complete_analysis_v2_preflight_admission',
        ]) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'FROM PUBLIC, anon, authenticated, service_role'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role`
            ));
        }
        expect(migration).toContain(
            'RENAME TO analysis_v2_consume_entitlement_after_admission_internal'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_consume_entitlement_after_admission_internal\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_consume_entitlement_after_admission_internal/
        );
    });

    it('settles only the exact owner-bound dispatch reservation', () => {
        const mark = functionDefinition('mark_analysis_v2_preflight_admission_dispatched');
        expectInOrder(mark, [
            'preflight.user_id = p_user_id',
            'FOR UPDATE;',
            'v_preflight.admission_generation <> p_admission_generation',
            'v_preflight.admission_dispatch_generation <> p_dispatch_generation',
            'v_preflight.admission_dispatch_token IS DISTINCT FROM p_dispatch_token',
            "v_preflight.admission_dispatch_state = 'enqueued'",
            "SET admission_dispatch_state = 'enqueued'",
        ]);

        const release = functionDefinition(
            'release_analysis_v2_preflight_admission_dispatch'
        );
        expectInOrder(release, [
            'preflight.user_id = p_user_id',
            'preflight.admission_generation = p_admission_generation',
            'preflight.admission_dispatch_generation = p_dispatch_generation',
            "preflight.admission_dispatch_state = 'reserved'",
            'preflight.admission_dispatch_token = p_dispatch_token',
        ]);
        expect(release).toContain("SET admission_dispatch_state = 'idle'");
        expect(migration).toContain('analysis_preflights_admission_dispatch_check');
    });

    it('bounds sanitized self-hosted failures and releases the exact claim', () => {
        const failure = functionDefinition(
            'record_analysis_v2_preflight_admission_failure'
        );
        expectInOrder(failure, [
            'preflight.admission_generation = p_admission_generation',
            "preflight.admission_status = 'processing'",
            'preflight.admission_claim_token = p_claim_token',
            'FOR UPDATE;',
            'v_preflight.admission_failure_count + 1',
            "WHEN v_failure_count >= 3 THEN 'blocked'",
            'admission_claim_token = NULL',
            'admission_lease_expires_at = NULL',
            "admission_last_error_code = 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'",
        ]);
        expect(migration).toContain(
            'ADD COLUMN admission_failure_count INTEGER NOT NULL DEFAULT 0'
        );
        expect(migration).toContain('analysis_preflights_admission_failure_terminal_check');
    });

    it('requires a recent exact plan refresh for creation while allowing consumed replay', () => {
        const consume = functionDefinition('consume_analysis_v2_test_entitlement');
        expectInOrder(consume, [
            'pg_catalog.pg_advisory_xact_lock',
            'FROM public.users',
            'FROM public.analysis_preflights AS preflight',
            "IF v_preflight.status <> 'consumed' THEN",
            "v_preflight.admission_status <> 'ready'",
            'v_preflight.admission_refreshed_at IS NULL',
            'v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id',
            'v_preflight.admission_entitlement_jti_hash',
            'IS DISTINCT FROM p_entitlement_jti_hash',
            'v_preflight.admission_token IS DISTINCT FROM p_admission_token',
            "v_now - INTERVAL '2 minutes'",
            'public.analysis_v2_valid_plan_cards_snapshot',
            'public.analysis_v2_consume_entitlement_after_admission_internal(',
        ]);
        expect(consume).toContain(
            "RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY'"
        );
        expect(consume).toContain(
            "v_selected_card->>'selectionState'"
        );
    });
});
