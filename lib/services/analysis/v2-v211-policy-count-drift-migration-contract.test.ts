import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260808240000_allow_v211_policy_replay_capacity_safe_count_drift.sql',
), 'utf8');

describe('v2.11 policy replay count-drift migration contract', () => {
    it('patches only the previously authorized incident helper', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808230000');
        expect(migration).toContain(
            'public.earlybird_v211_policy_identity_replay_ready(',
        );
        expect(migration).toContain('a40dd46d8412398967f2ce71a57cf8af');
        expect(migration).not.toMatch(
            /UPDATE\s+public\.(?:earlybird_orders|earlybird_fulfillments|analysis_requests)/i,
        );
    });

    it('accepts drift only when every count observation fits Basic', () => {
        expect(migration).toContain(
            'source_preflight.admission_target_followers_count <= CASE',
        );
        expect(migration).toContain(
            'earlybird_order.target_followers_count <= CASE',
        );
        expect(migration).toContain(
            'current_preflight.target_followers_count <= CASE',
        );
        expect(migration).toContain(
            "-> 'basic' -> 'relationshipCapacity' ->> 'followers'",
        );
        expect(migration).toContain(
            "-> 'basic' -> 'relationshipCapacity' ->> 'following'",
        );
        expect(migration).toContain("IN ('required', 'available_upgrade')");
    });

    it('keeps immutable plan and admission witnesses exact', () => {
        expect(migration).toContain(
            'current_preflight.plan_cards_snapshot =',
        );
        expect(migration).toContain(
            'failed_preflight.plan_cards_snapshot',
        );
        expect(migration).toContain(
            'current_preflight.admission_plan_cards_snapshot =',
        );
        expect(migration).toContain(
            'current_preflight.admission_capacity_required_plan_id',
        );
        expect(migration).toContain(
            'current_preflight.admission_required_plan_id',
        );
        expect(migration).toContain(
            'public.analysis_v2_valid_plan_cards_snapshot(',
        );
    });

    it('keeps the authorization helper private', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.earlybird_v211_policy_identity_replay_ready',
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_helper, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_helper, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE')",
        );
    });
});
