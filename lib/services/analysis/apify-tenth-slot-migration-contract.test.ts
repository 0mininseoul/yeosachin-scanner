import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260820134329_expand_analysis_v2_apify_tenth_slot.sql',
), 'utf8');

describe('analysis V2 tenth Apify credential migration', () => {
    it('widens only the general helper and preserves its exact execution grants', () => {
        expect(migration).toMatch(
            /p_slot IN\s*\(\s*'primary',\s*'secondary',\s*'tertiary',\s*'quaternary',\s*'quinary',\s*'senary',\s*'septenary',\s*'tenth'\s*\)/,
        );
        expect(migration).toContain('IMMUTABLE');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)',
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_apify_credential_slot\(TEXT\)\s+TO anon, authenticated;/,
        );
        expect(migration).not.toContain('analysis_beta_valid_apify_credential_slot');
        expect(migration).not.toContain('analysis_v2_valid_test_operation_slot_map');
    });
});
