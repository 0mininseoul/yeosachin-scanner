import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260719160000_add_landing_leads.sql'),
    'utf8',
);

describe('landing_leads migration', () => {
    it('creates the table with the hardened id and timestamp defaults', () => {
        expect(sql).toContain('CREATE TABLE public.landing_leads');
        expect(sql).toContain('extensions.gen_random_uuid()');
        expect(sql).toContain('pg_catalog.clock_timestamp()');
        expect(sql).toContain('instagram_id TEXT NOT NULL');
    });

    it('locks the table down to service_role only', () => {
        expect(sql).toContain('ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY');
        expect(sql).toContain('REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated');
        expect(sql).toContain('GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role');
        expect(sql).not.toMatch(/CREATE POLICY[\s\S]*landing_leads/i);
    });
});
