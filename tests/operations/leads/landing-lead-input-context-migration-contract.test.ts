import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
    join(
        process.cwd(),
        'supabase/migrations/20260725021500_add_landing_lead_input_context.sql',
    ),
    'utf8',
);

describe('landing_leads input context migration', () => {
    it('backfills target context and strictly separates target from excluded rows', () => {
        expect(sql).toContain(
            "ADD COLUMN input_context TEXT NOT NULL DEFAULT 'target'",
        );
        expect(sql).toContain('ADD COLUMN source_preflight_id UUID');
        expect(sql).toContain("input_context IN ('target', 'excluded')");
        expect(sql).toContain(
            "(input_context = 'target' AND source_preflight_id IS NULL)",
        );
        expect(sql).toContain(
            "input_context = 'excluded'",
        );
        expect(sql).toContain('source_preflight_id IS NOT NULL');
        expect(sql).toContain('raw_input IS NULL');
        expect(sql).toContain('utm_source IS NULL');
        expect(sql).toContain('referrer IS NULL');
        expect(sql).toContain('user_agent IS NULL');
    });

    it('deduplicates only exclusion replays and preserves service-role-only access', () => {
        expect(sql).toMatch(
            /CREATE UNIQUE INDEX landing_leads_excluded_preflight_uidx[\s\S]*ON public\.landing_leads\(source_preflight_id\)[\s\S]*WHERE input_context = 'excluded'/,
        );
        expect(sql).not.toMatch(
            /CREATE UNIQUE INDEX[\s\S]*instagram_id[\s\S]*WHERE input_context = 'target'/,
        );
        expect(sql).toContain(
            'REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated',
        );
        expect(sql).toContain(
            'GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role',
        );
        expect(sql).not.toMatch(/CREATE POLICY[\s\S]*landing_leads/i);
    });
});
