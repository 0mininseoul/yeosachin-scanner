import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260808200000_rearm_v211_concierge_replay.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.11 first-payment concierge replay migration contract', () => {
    it('depends on the relationship rearm and records one immutable r6 replay', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808190000');
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_v211_concierge_replays'
        );
        expect(migration).toContain('BEFORE UPDATE OR DELETE');
        expect(migration).toContain("v_base_preflight_key || '.r5'");
        expect(migration).toContain("v_base_preflight_key || '.r6'");
        expect(migration).toContain(
            'INSERT INTO public.earlybird_v211_concierge_replays'
        );
    });

    it('proves the r2 failure adopted only two relationship runs and spent nothing new', () => {
        expect(migration).toContain("v_request.idempotency_key IS DISTINCT FROM");
        expect(migration).toContain("|| '.r2'");
        expect(migration).toContain("job.job_key = 'track:relationships:collect'");
        expect(migration).toContain('public.analysis_v2_recovery_provider_run_adoptions');
        expect(migration).toContain('OR 2 <> (');
        expect(migration).toContain('public.analysis_v2_provider_runs');
        expect(migration).toContain('public.analysis_provider_cost_ledger');
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(migration).toContain('public.analysis_v2_gemini_leases');
    });

    it('pins the concierge snapshot to the original admitted counts and budgets fresh missing work', () => {
        expect(migration).toContain(
            'v_source_preflight.admission_target_followers_count'
        );
        expect(migration).toContain(
            'v_source_preflight.admission_target_following_count'
        );
        expect(migration).toContain(
            'v_source_preflight.admission_plan_cards_snapshot'
        );
        expect(migration).toContain(
            'CREATE FUNCTION public.earlybird_v211_concierge_replay_ready'
        );
        expect(migration).toContain(
            'public.earlybird_v211_concierge_replay_ready('
        );
        expect(migration).toContain('RETURN NULL;');
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE'
        );
    });

    it('keeps the audit and internal helpers private and exposes only the operator RPC', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.earlybird_v211_concierge_replays[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_v211_concierge_replay_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.rearm_earlybird_v211_concierge_replay\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.rearm_earlybird_v211_concierge_replay\([\s\S]*?TO service_role;/
        );
    });
});
