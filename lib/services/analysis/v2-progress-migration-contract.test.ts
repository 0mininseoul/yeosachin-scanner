import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713183230_add_analysis_v2_progress_state.sql'
), 'utf8');
const neutralShortlistMigration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260714023000_add_analysis_v2_neutral_shortlist_progress.sql'
), 'utf8');
const activeProfileHeartbeatMigration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260714024500_add_analysis_v2_active_profile_heartbeats.sql'
), 'utf8');

describe('V2 progress migration contract', () => {
    it('creates owner-readable sanitized state and append-only event tables', () => {
        expect(migration).toContain('CREATE TABLE public.analysis_progress_state');
        expect(migration).toContain('CREATE TABLE public.analysis_progress_events');
        expect(migration).toContain('FORCE ROW LEVEL SECURITY');
        expect(migration).toContain('analysis_progress_state_owner_select');
        expect(migration).toContain('analysis_progress_events_owner_select');
        expect(migration).toContain('GRANT SELECT ON TABLE public.analysis_progress_state TO authenticated');
        expect(migration).toContain('GRANT SELECT ON TABLE public.analysis_progress_events TO authenticated');
        expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*authenticated/i);
    });

    it('binds every mutation to an exact live job lease and input hash', () => {
        expect(migration).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
        expect(migration).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(migration).toContain('v_job.lease_expires_at <= v_now');
        expect(migration).toContain("p_job_key <> 'coordinator:bootstrap'");
        expect(migration).toMatch(
            /WHERE preflight\.consumed_request_id = p_request_id\s+FOR UPDATE;\s+IF NOT FOUND THEN/
        );
        expect(migration.indexOf('v_now := pg_catalog.clock_timestamp();')).toBeGreaterThan(
            migration.indexOf('FROM public.analysis_pipeline_jobs AS job')
        );
        expect(migration).toContain('ANALYSIS_V2_PROGRESS_FENCE_MISMATCH');
    });

    it('makes snapshots monotonic and event retries idempotent', () => {
        expect(migration).toContain('CONSTRAINT analysis_progress_events_key_unique');
        expect(migration).toContain('progress_event.event_key = p_event_key');
        expect(migration).toContain('v_state.last_event_seq + CASE WHEN v_event_new THEN 1 ELSE 0 END');
        expect(migration).toContain('GREATEST(v_state.progress_bp, v_calculated_progress)');
        expect(migration).toContain(
            "(p_next->>'progressBp')::INTEGER >= (p_previous->>'progressBp')::INTEGER"
        );
        expect(migration).toContain(
            "p_previous->>'state' = 'running'"
        );
        expect(migration).not.toMatch(/pg_catalog\.(?:least|greatest)\s*\(/i);
        expect(migration).toContain('ANALYSIS_V2_PROGRESS_REGRESSION');
        expect(migration).toContain('ANALYSIS_V2_PROGRESS_EVENT_CONFLICT');
    });

    it('uses the TypeScript IEEE-754 operation order for weighted progress', () => {
        expect(migration).toContain('7200::DOUBLE PRECISION * CASE');
        expect(migration).toContain('1700::DOUBLE PRECISION * CASE');
        expect(migration).toContain('1100::DOUBLE PRECISION * CASE');
        expect(migration).not.toMatch(/(?:7200|1700|1100)::NUMERIC/);
    });

    it('persists only bounded copy codes, masked handles, proxy images, and aggregates', () => {
        expect(migration).toContain("p_profile->>'maskedUsername' ~");
        expect(migration).toContain("p_profile->>'imageUrl' LIKE '/api/image-proxy?%'");
        expect(migration).toContain("p_event->>'copyCode' ~");
        expect(migration).toContain('aggregate_count IS NULL OR aggregate_count BETWEEN 0 AND 10000');
        expect(migration).not.toMatch(/comment_text|caption_text|liker_username|raw_score/i);
    });

    it('adds a neutral confirmed shortlist event without reclassifying historical events', () => {
        expect(neutralShortlistMigration).toContain("'SHORTLIST_READY'");
        expect(neutralShortlistMigration).toContain(
            "'SHORTLIST_READY', 'FINDING_CONFIRMED', 'ANALYSIS_COMPLETED'"
        );
        expect(neutralShortlistMigration).toContain("'POTENTIAL_HIGH_RISK_FOUND'");
        expect(neutralShortlistMigration).toContain(
            'DROP CONSTRAINT analysis_progress_events_code_check'
        );
    });

    it('selects the latest-started sanitized profile only from a still-live job', () => {
        expect(activeProfileHeartbeatMigration).toContain(
            'CREATE TABLE public.analysis_v2_active_profile_heartbeats'
        );
        expect(activeProfileHeartbeatMigration).toContain(
            "p_job_key !~ '^track:(profiles|profile-ai):batch:[0-9]+$'"
        );
        expect(activeProfileHeartbeatMigration).toContain(
            'v_job.lease_token IS DISTINCT FROM p_claim_token'
        );
        expect(activeProfileHeartbeatMigration).toContain(
            'job.lease_expires_at > pg_catalog.clock_timestamp()'
        );
        expect(activeProfileHeartbeatMigration).toContain(
            'ORDER BY heartbeat.started_at DESC, heartbeat.updated_at DESC, heartbeat.job_key DESC'
        );
        expect(activeProfileHeartbeatMigration).toContain(
            'EXCLUDED.claim_token\n                IS DISTINCT FROM'
        );
        expect(activeProfileHeartbeatMigration).toContain(
            "'maskedUsername', heartbeat.masked_username"
        );
        expect(activeProfileHeartbeatMigration).not.toMatch(
            /raw_username|instagram_username|profile_pic_url/i
        );
        expect(activeProfileHeartbeatMigration).not.toMatch(
            /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*(?:anon|authenticated)/i
        );
    });

    it('keeps heartbeats label-only so percent can advance only from durable DAG state', () => {
        expect(activeProfileHeartbeatMigration).not.toContain(
            'checkpoint_analysis_v2_profile_work_progress'
        );
        expect(activeProfileHeartbeatMigration).not.toMatch(
            /p_completed_count|v_candidate_progress|progress_bp\s*=/
        );
        expect(activeProfileHeartbeatMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat'
        );
    });

    it('clears transient profile data at terminal states and configures Realtime publication', () => {
        expect(migration).toContain("p_status IN ('completed', 'failed', 'upgrade_required')");
        expect(migration).toMatch(
            /p_active_profile IS NOT NULL\s+OR p_eta_range IS NOT NULL/
        );
        expect(migration).toMatch(
            /status NOT IN \('completed', 'failed', 'upgrade_required'\)\s+OR \(active_profile IS NULL AND eta_range IS NULL\)/
        );
        expect(migration).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.analysis_progress_state');
        expect(migration).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.analysis_progress_events');
    });

    it('keeps both Realtime tables owner-scoped without public mutations', () => {
        expect(migration).toMatch(
            /analysis_request\.user_id = \(SELECT auth\.uid\(\)\)/g
        );
        expect(migration.match(/analysis_request\.user_id = \(SELECT auth\.uid\(\)\)/g))
            .toHaveLength(2);
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.analysis_progress_state\n    FROM PUBLIC, anon, authenticated, service_role'
        );
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.analysis_progress_events\n    FROM PUBLIC, anon, authenticated, service_role'
        );
        expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*analysis_progress/i);
    });

    it('exposes only service-role mutation and owner-load RPCs', () => {
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_progress');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_progress');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.load_analysis_v2_progress');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_v2_progress');
        expect(migration).not.toMatch(/GRANT EXECUTE[^;]*(?:anon|authenticated)/i);
    });
});
