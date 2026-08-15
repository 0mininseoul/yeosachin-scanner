import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
    process.cwd(),
    'supabase/migrations/20260815200000_list_first15_canary_provider_runs.sql',
);

describe('first15 provider-run recovery read migration contract', () => {
    it('keeps the bounded provider ledger read behind a service-role-only RPC', () => {
        const migration = readFileSync(migrationPath, 'utf8');

        expect(migration).toContain(
            'CREATE FUNCTION public.list_earlybird_first15_canary_provider_runs(',
        );
        expect(migration).toContain('p_request_ids UUID[]');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('LIMIT 64');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.list_earlybird_first15_canary_provider_runs\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.list_earlybird_first15_canary_provider_runs\([\s\S]*?TO service_role;/,
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_v2_provider_runs/i,
        );
    });
});
