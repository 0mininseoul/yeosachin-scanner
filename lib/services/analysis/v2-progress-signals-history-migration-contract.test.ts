import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260829120000_add_analysis_v2_progress_signals_history.sql'
);

describe('V2 progress signals and history migration contract', () => {
    it('extends the existing heartbeat with bounded ordinal and phase signals', () => {
        expect(existsSync(migrationPath)).toBe(true);
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('ADD COLUMN call_phase TEXT NOT NULL DEFAULT');
        expect(migration).toContain(
            "call_phase IN ('fetching', 'analyzing', 'persisting')"
        );
        expect(migration).toContain('p_current_ordinal INTEGER DEFAULT 0');
        expect(migration).toContain('p_call_phase TEXT DEFAULT');
        expect(migration).toContain('p_current_ordinal NOT BETWEEN 0 AND p_total_count');
        expect(migration).toContain('p_call_phase NOT IN');
        expect(migration).toContain('GREATEST(');
        expect(migration).not.toMatch(/CREATE\s+TABLE/i);
    });

    it('keeps the heartbeat exact-fenced and removes the prior overload', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain(
            'DROP FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat('
        );
        expect(migration).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
        expect(migration).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(migration).toContain('v_job.lease_expires_at <= v_now');
        expect(migration).toContain('ANALYSIS_V2_PROGRESS_TOPOLOGY_MISMATCH');
        expect(migration).toContain('call_phase = EXCLUDED.call_phase');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.load_analysis_v2_progress');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_v2_progress');
    });

    it('derives a bounded owner-scoped history from successful profile outcomes', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('analysis_request.user_id = p_user_id');
        expect(migration).toContain(
            'public.analysis_v2_profile_fetch_outcomes AS outcome'
        );
        expect(migration).toContain("outcome.job_key LIKE 'track:profiles:batch:%'");
        expect(migration).toContain("outcome.status = 'success'");
        expect(migration).toContain("outcome.profile_snapshot->>'isPrivate' = 'false'");
        expect(migration).toContain('candidateMediaRaw');
        expect(migration).toContain('profile_snapshot');
        expect(migration).toContain('LIMIT 60');
        expect(migration).toContain('ORDER BY candidate.captured_at DESC, candidate.ordinal DESC, candidate.username DESC');
        expect(migration).toContain('ORDER BY candidate.captured_at ASC, candidate.ordinal, candidate.username');
        expect(migration).toContain("'currentOrdinal', heartbeat.completed_count");
        expect(migration).toContain("'totalCount', heartbeat.total_count");
        expect(migration).toContain("'callPhase', heartbeat.call_phase");
        expect(migration).not.toMatch(/raw_username|instagram_username/i);
    });
});
