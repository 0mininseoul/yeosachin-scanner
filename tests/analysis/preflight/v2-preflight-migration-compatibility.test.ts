import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713142811_add_analysis_v2_preflight.sql'
), 'utf8');

describe('Analysis V2 preflight migration compatibility', () => {
    it('uses the Supabase extensions schema for UUID generation', () => {
        expect(migration).not.toContain('public.uuid_generate_v4()');
        expect(migration.match(/extensions\.gen_random_uuid\(\)/g)).toHaveLength(3);
    });
});
