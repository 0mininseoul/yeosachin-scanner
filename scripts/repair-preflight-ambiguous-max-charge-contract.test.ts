import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const generator = readFileSync(
    new URL('./repair-preflight-ambiguous-max-charge.ts', import.meta.url),
    'utf8'
);

describe('identity-drift max-charge repair generator', () => {
    it('uses a direct owner connection and never writes candidate SQL to stdout', () => {
        expect(generator).toContain("new Client({ connectionString })");
        expect(generator).toContain('DATABASE_URL');
        expect(generator).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(generator).not.toContain('fetch(');
        expect(generator).not.toContain('process.stdout');
        expect(generator).toContain('writeExclusivePrivateOutput');
        expect(generator).toContain('safeOutputPath');
        expect(generator).toContain('readPrivateEvidenceReference');
    });
});
