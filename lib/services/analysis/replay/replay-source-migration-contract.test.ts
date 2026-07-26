import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
    '../../../../supabase/migrations/20260727010000_add_analysis_v2_replay_capture_source.sql',
    import.meta.url,
);

describe('analysis V2 replay source migration', () => {
    it('is a bounded stable read-only SECURITY DEFINER function with closed ACLs', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('STABLE');
        expect(sql).toContain('SECURITY DEFINER');
        expect(sql).toContain("SET search_path = ''");
        expect(sql).toContain('LIMIT 128');
        expect(sql).toContain('LIMIT 4');
        expect(sql).toContain("request.plan_access_mode_snapshot = 'production'");
        expect(sql).toContain("request.selected_plan_id_snapshot = 'standard'");
        expect(sql).toMatch(/v_preflight_runs[\s\S]*jsonb_agg\([\s\S]*ORDER BY run\.operation_key/);
        expect(sql).toContain('REVOKE ALL ON FUNCTION public.read_analysis_v2_replay_capture_source');
        expect(sql).toContain('TO service_role');
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
        expect(sql).not.toContain('GRANT SELECT');
    });
});
