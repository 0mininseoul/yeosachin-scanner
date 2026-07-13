import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713164030_add_analysis_v2_profile_fetch_checkpoints.sql',
        import.meta.url
    ),
    'utf8'
);

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
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('analysis V2 profile checkpoint migration contract', () => {
    it('keeps both staging tables RPC-only behind forced RLS', () => {
        for (const table of [
            'analysis_v2_profile_fetch_batches',
            'analysis_v2_profile_fetch_outcomes',
        ]) {
            expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(`GRANT .* ON TABLE public\\.${table}`));
        }
    });

    it('persists a complete primary set and freezes unresolved usernames atomically', () => {
        const primary = functionDefinition('checkpoint_analysis_v2_profile_primary');
        expectInOrder(primary, [
            'analysis_v2_valid_profile_outcomes(',
            "'primary'",
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'v_now := pg_catalog.clock_timestamp()',
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_job.lease_expires_at <= v_now',
            'FROM public.analysis_v2_profile_fetch_batches AS batch',
            "MESSAGE = 'ANALYSIS_V2_PROFILE_PRIMARY_CONFLICT'",
            "WHERE outcome.value->>'status' <> 'success'",
            'INSERT INTO public.analysis_v2_profile_fetch_batches',
            'INSERT INTO public.analysis_v2_profile_fetch_outcomes',
        ]);
        expect(primary).toContain("v_job.status <> 'processing'");
        expect(primary).toContain("'requested_usernames'");
        expect(primary).toContain("'outcomes'");
    });

    it('allows fallback outcomes only for the frozen ordered set and exact replay', () => {
        const fallback = functionDefinition('checkpoint_analysis_v2_profile_fallback');
        expect(fallback).not.toContain('p_requested_usernames');
        expectInOrder(fallback, [
            'FROM public.analysis_pipeline_jobs AS job',
            'v_completed_at := pg_catalog.clock_timestamp()',
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'FROM public.analysis_v2_profile_fetch_batches AS batch',
            'v_batch.frozen_unresolved_usernames',
            "'fallback'",
            'v_batch.fallback_payload_hash <> v_payload_hash',
            "MESSAGE = 'ANALYSIS_V2_PROFILE_FALLBACK_CONFLICT'",
            'INSERT INTO public.analysis_v2_profile_fetch_outcomes',
            "'fallback'",
            'SET fallback_payload_hash = v_payload_hash',
        ]);
        const validator = functionDefinition('analysis_v2_valid_profile_outcomes');
        expect(validator).toContain("p_attempt = 'fallback'");
        expect(validator).toContain("outcome.value->>'source' <> 'apify'");
        expect(validator).toContain("'timeout', 'incomplete', 'schema'");
        expect(validator).toContain(
            "outcome.value->>'username' <> p_expected_usernames[outcome.ordinal::INTEGER]"
        );
    });

    it('fences load and exact idempotent replay behind the current claim and input hash', () => {
        for (const name of [
            'checkpoint_analysis_v2_profile_primary',
            'checkpoint_analysis_v2_profile_fallback',
            'load_analysis_v2_profile_fetch_checkpoint',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('p_claim_token UUID');
            expect(definition).toContain('p_job_input_hash TEXT');
            expect(definition).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
            expect(definition).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
            expect(definition).toContain('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH');
        }
        const primary = functionDefinition('checkpoint_analysis_v2_profile_primary');
        expect(primary.indexOf('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH'))
            .toBeLessThan(primary.indexOf('IF FOUND THEN'));
        const fallback = functionDefinition('checkpoint_analysis_v2_profile_fallback');
        expect(fallback.indexOf('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH'))
            .toBeLessThan(fallback.indexOf('v_batch.fallback_completed_at IS NOT NULL'));
    });

    it('stores bounded canonical media rather than arbitrary provider payloads', () => {
        const validator = functionDefinition('analysis_v2_valid_profile_snapshot');
        expect(validator).toContain("pg_catalog.jsonb_array_length(p_profile->'latestPosts') <= 8");
        expect(validator).toContain("pg_catalog.jsonb_array_length(post.value->'mediaItems') > 20");
        expect(validator).toContain("'declaredMediaCount', 'childrenComplete'");
        expect(validator).toContain("post.value->>'type' NOT IN ('image', 'video', 'carousel', 'reel')");
        expect(migration).not.toContain('raw_provider_payload');
        expect(migration).not.toContain('credential_slot');
        expect(migration).not.toContain('provider_run_id');
        expect(migration).not.toContain('run_id');
    });

    it('returns outcomes in request order and exposes a terminal-only purge hook', () => {
        const snapshot = functionDefinition('analysis_v2_profile_checkpoint_snapshot');
        expect(snapshot.match(/ORDER BY outcome\.ordinal/g)).toHaveLength(2);
        expect(snapshot).toContain("'frozenUnresolvedUsernames'");
        expect(snapshot).toContain("'primaryResults'");
        expect(snapshot).toContain("'fallbackResults'");

        const purge = functionDefinition('purge_analysis_v2_profile_fetch_checkpoints');
        expect(purge).toContain("analysis_request.pipeline_version = 'v2'");
        expect(purge).toContain("analysis_request.status IN ('completed', 'failed')");
        expect(purge).toContain('DELETE FROM public.analysis_v2_profile_fetch_batches');
    });

    it('grants only the four bounded public RPCs to service_role', () => {
        for (const rpc of [
            'checkpoint_analysis_v2_profile_primary',
            'checkpoint_analysis_v2_profile_fallback',
            'load_analysis_v2_profile_fetch_checkpoint',
            'purge_analysis_v2_profile_fetch_checkpoints',
        ]) {
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_profile_/g
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_profile_checkpoint_snapshot/g
        );
    });
});
