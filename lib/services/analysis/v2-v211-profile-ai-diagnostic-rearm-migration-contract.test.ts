import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260808210000_rearm_v211_profile_ai_diagnostic_replay.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.11 first-payment profile AI diagnostic replay migration contract', () => {
    it('depends on the concierge replay and records one immutable r7 replay', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808200000');
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_v211_profile_ai_diagnostic_replays'
        );
        expect(migration).toContain('BEFORE UPDATE OR DELETE');
        expect(migration).toContain("v_base_preflight_key || '.r6'");
        expect(migration).toContain("v_base_preflight_key || '.r7'");
        expect(migration).toContain(
            'INSERT INTO public.earlybird_v211_profile_ai_diagnostic_replays'
        );
    });

    it('pins the exact failed r3 topology before creating a new generation', () => {
        expect(migration).toContain("|| '.r3'");
        expect(migration).toContain("'track:profile-ai:batch:2'");
        expect(migration).toContain("'ANALYSIS_V2_JOB_HANDLER_FAILED'");
        expect(migration).toContain('public.analysis_v2_provider_runs');
        expect(migration).toContain(
            'public.analysis_v2_recovery_provider_run_adoptions'
        );
        expect(migration).toContain('public.analysis_v2_scheduler_operations');
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_gemini_leases');
        expect(migration).toContain(
            'public.analysis_v2_provider_cleanup_intents'
        );
    });

    it('extends exact adoption only for the audited r7 diagnostic replay', () => {
        expect(migration).toContain(
            'CREATE FUNCTION public.earlybird_v211_profile_ai_diagnostic_replay_ready'
        );
        expect(migration).toContain(
            'public.earlybird_v211_profile_ai_diagnostic_replay_ready('
        );
        expect(migration).toContain('f26a61eb5e4abe794deabde9cba457f2');
        expect(migration).toContain('787cf9dddcb3a10f69f257f8e7f18219');
        expect(migration).toContain('RETURN NULL;');
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE'
        );
    });

    it('keeps all audit helpers private and exposes only the operator RPC', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.earlybird_v211_profile_ai_diagnostic_replays[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_v211_profile_ai_diagnostic_replay_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.rearm_earlybird_v211_profile_ai_diagnostic_replay\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.rearm_earlybird_v211_profile_ai_diagnostic_replay\([\s\S]*?TO service_role;/
        );
    });
});
