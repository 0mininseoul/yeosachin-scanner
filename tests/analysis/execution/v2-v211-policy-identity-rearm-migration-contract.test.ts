import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260808220000_rearm_v211_policy_identity_replay.sql',
), 'utf8');

describe('v2.11 policy-identity replay migration contract', () => {
    it('fences the exact paid r7 terminal topology before admitting r8', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808210000');
        expect(migration).toContain("v_request.idempotency_key IS DISTINCT FROM");
        expect(migration).toContain("|| '.r4'");
        expect(migration).toContain("v_base_preflight_key || '.r7'");
        expect(migration).toContain("v_base_preflight_key || '.r8'");
        expect(migration).toContain("track:profile-ai:batch:3");
        expect(migration).toContain("receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'");
        expect(migration).toContain('OR 12 <> (');
        expect(migration).toContain('OR 6 <> (');
        expect(migration).toContain('OR 5 <> (');
        expect(migration).toContain('OR 4 <> (');
    });

    it('records immutable incident lineage and never edits old failed requests', () => {
        expect(migration).toContain('earlybird_v211_policy_identity_replays');
        expect(migration).toContain(
            'prevent_earlybird_v211_policy_identity_replay_mutation',
        );
        expect(migration).toContain('policy_identity_failed_request_id');
        expect(migration).not.toMatch(
            /UPDATE\s+public\.analysis_requests|DELETE\s+FROM\s+public\.analysis_requests/i,
        );
        expect(migration).not.toMatch(
            /UPDATE\s+public\.analysis_v2_(?:failure_receipts|scheduler_operations|ai_attempts)/i,
        );
    });

    it('creates a fresh ready preflight without adding provider-run adoption', () => {
        expect(migration).toContain("v_order.target_instagram_id, 'ready'");
        expect(migration).toContain("'admission_pending'");
        expect(migration).not.toContain(
            'INSERT INTO public.analysis_v2_recovery_provider_run_adoptions',
        );
    });

    it('keeps the operator RPC private except for service_role', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.rearm_earlybird_v211_policy_identity_replay',
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_policy_identity_replay',
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_rearm, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_rearm, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_rearm, 'EXECUTE')",
        );
    });
});
