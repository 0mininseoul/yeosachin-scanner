import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    'supabase/migrations/20260812133925_raise_preflight_global_hourly_limit.sql',
    'utf8',
);
const removalMigration = readFileSync(
    'supabase/migrations/20260812134650_remove_preflight_global_hourly_limit.sql',
    'utf8',
);
const activeRemovalMigration = readFileSync(
    'supabase/migrations/20260812135104_remove_active_preflight_global_hourly_limit.sql',
    'utf8',
);
const activeReplayMigration = readFileSync(
    'supabase/migrations/20260812135536_replay_active_preflight_before_rate_limit.sql',
    'utf8',
);

describe('preflight global hourly limit migration', () => {
    it('raises only the shared ceiling and preserves the private helper permissions', () => {
        expect(migration).toContain("'v_global_preflight_count >= 3000'");
        expect(migration).not.toContain('v_recent_preflight_count >= 30');
        expect(migration).not.toContain("INTERVAL '1 seconds'");
        expect(migration).toContain(
            'FROM PUBLIC, anon, authenticated, service_role',
        );
    });

    it('removes the shared cap while retaining per-user admission guards', () => {
        expect(removalMigration).toContain("'IF v_recent_preflight_count >= 5'");
        expect(removalMigration).toContain("INTERVAL ''10 seconds''");
        expect(removalMigration).toContain(
            'FROM PUBLIC, anon, authenticated, service_role',
        );
    });

    it('updates the active public RPC and restores its exact execute grant', () => {
        expect(activeRemovalMigration).toContain(
            "'IF v_recent_preflight_count >= 5 OR EXISTS'",
        );
        expect(activeRemovalMigration).toContain(
            'FROM PUBLIC, anon, authenticated, service_role',
        );
        expect(activeRemovalMigration).toContain('TO service_role');
    });

    it('replays an active same-target preflight before applying user limits', () => {
        expect(activeReplayMigration).toContain(
            "preflight.status IN (''pending'', ''processing'', ''ready'')",
        );
        expect(activeReplayMigration).toContain(
            'preflight.target_instagram_id = v_target_instagram_id',
        );
        expect(activeReplayMigration).toContain(
            'RETURN QUERY SELECT v_existing.id, FALSE',
        );
    });
});
