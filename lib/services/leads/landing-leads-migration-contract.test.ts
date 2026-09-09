import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260719160000_add_landing_leads.sql'),
    'utf8',
);

const migrationDirectory = join(process.cwd(), 'supabase/migrations');
const journeyMigrationName = readdirSync(migrationDirectory)
    .filter(name => name.endsWith('_add_landing_lead_journey_contract.sql'))[0];
const journeySql = journeyMigrationName
    ? readFileSync(join(migrationDirectory, journeyMigrationName), 'utf8')
    : '';

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

describe('landing lead journey migration', () => {
    it('adds the journey, mapping, and one-time capture columns', () => {
        expect(journeyMigrationName).toBeTruthy();
        expect(journeySql).toContain('journey_id UUID NOT NULL');
        expect(journeySql).toContain('anonymous_principal_hash VARCHAR(64)');
        expect(journeySql).toContain('auth_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL');
        expect(journeySql).toContain('source_preflight_id UUID');
        expect(journeySql).toContain('capture_token_hash VARCHAR(64)');
        expect(journeySql).toContain('mapping_status TEXT NOT NULL');
        expect(journeySql).toContain('linked_at TIMESTAMPTZ');
        expect(journeySql).toContain('landing_leads_capture_token_hash_uidx');
        expect(journeySql).toContain('landing_leads_journey_created_idx');
        expect(journeySql).toContain('landing_leads_mapping_filter_idx');
    });

    it('keeps RLS and the complete table ACL boundary', () => {
        expect(journeySql).toContain('ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY');
        expect(journeySql).toContain('ALTER TABLE public.landing_leads FORCE ROW LEVEL SECURITY');
        expect(journeySql).toMatch(/REVOKE ALL ON TABLE public\.landing_leads FROM PUBLIC, anon, authenticated, service_role/);
    });

    it('defines constrained mappings and service-only security-definer RPCs', () => {
        expect(journeySql).toMatch(/mapping_status IN \([\s\S]*'legacy_unlinked',[\s\S]*'anonymous_device',[\s\S]*'authenticated_user',[\s\S]*'unlinked_after_deletion'/);
        expect(journeySql).toMatch(/'legacy_import_v1',[\s\S]*'capture_v1',[\s\S]*'preflight_v1',[\s\S]*'account_deletion_v1'/);
        expect(journeySql).toContain("capture_token_hash ~ '^[a-f0-9]{64}$'");
        for (const name of [
            'create_or_replay_landing_lead_capture',
            'claim_landing_lead_journey',
            'unlink_landing_lead_journey_after_deletion',
        ]) {
            expect(journeySql).toContain(`CREATE OR REPLACE FUNCTION public.${name}`);
            expect(journeySql).toMatch(new RegExp(`public\\.${name}[\\s\\S]*?SECURITY DEFINER SET search_path = ''`));
            expect(journeySql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${name}\\(`));
            expect(journeySql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?\\) TO service_role`));
        }
    });
});
