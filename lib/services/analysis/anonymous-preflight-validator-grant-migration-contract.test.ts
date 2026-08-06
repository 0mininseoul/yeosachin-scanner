import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260806075502_allow_anonymous_preflight_snapshot_validator_exec.sql',
), 'utf8');
const ttlMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260806075731_anchor_anonymous_preflight_created_at.sql',
), 'utf8');
const dispatchMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260806084409_fix_anonymous_preflight_dispatch_generation_qualification.sql',
), 'utf8');

describe('anonymous preflight validator grant migration contract', () => {
    it('lets caller-owned anonymous inserts evaluate the bounded plan-card check', () => {
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_plan_cards_snapshot\(JSONB\)\s+TO anon, authenticated;/,
        );
    });

    it('anchors the anonymous preflight TTL to the inserted created_at', () => {
        expect(ttlMigration).toContain(
            'policy_versions_snapshot, created_at, expires_at, claim_token_hash,',
        );
        expect(ttlMigration).toContain(
            'p_policy_versions_snapshot, v_now, v_expires, p_claim_token_hash,',
        );
    });

    it('qualifies the dispatch generation column in the reservation update', () => {
        expect(dispatchMigration).toContain(
            'UPDATE public.analysis_preflights AS target',
        );
        expect(dispatchMigration).toContain(
            'SET dispatch_generation = target.dispatch_generation + 1,',
        );
    });
});
