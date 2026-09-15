import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
    process.cwd(),
    'supabase/migrations/20260813180000_revoke_collection_context_v2_public_execute.sql',
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';
const signature =
    'public.load_analysis_v2_collection_context_with_policy_v2(UUID,TEXT,UUID,TEXT)';
const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('collection-context v2 RPC ACL hotfix migration contract', () => {
    it('allows EXECUTE only to service_role for the exact four-argument RPC', () => {
        expect(existsSync(migrationPath)).toBe(true);
        expect(migration).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`);
        expect(migration).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM anon;`);
        expect(migration).toContain(
            `REVOKE EXECUTE ON FUNCTION ${signature} FROM authenticated;`,
        );
        expect(migration).toContain(
            `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`,
        );

        const grants = Array.from(
            migration.matchAll(/^\s*GRANT\s+[\s\S]*?;/gim),
            ([grant]) => grant.replace(/\s+/g, ' ').trim(),
        );

        expect(grants).toEqual([
            `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`,
        ]);
    });

    it('rejects every alternate function or schema-level execution grant form', () => {
        expect(migration).not.toMatch(new RegExp(
            `GRANT\\s+(?:EXECUTE|ALL(?:\\s+PRIVILEGES)?)\\s+ON\\s+FUNCTION\\s+${escapedSignature}\\s+TO\\s+(?!service_role\\s*;)`,
            'i',
        ));
        expect(migration).not.toMatch(
            /GRANT\s+(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+ALL\s+(?:FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+public\s+TO\b/i,
        );
        expect(migration).not.toMatch(
            /ALTER\s+DEFAULT\s+PRIVILEGES(?:\s+FOR\s+(?:ROLE|USER)\s+\S+)?\s+IN\s+SCHEMA\s+public\s+GRANT\s+(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+(?:FUNCTIONS|ROUTINES)\s+TO\b/i,
        );
    });

    it('changes only ACLs, preserving the existing SECURITY DEFINER and empty search_path', () => {
        expect(migration).not.toMatch(
            /(?:CREATE OR REPLACE|ALTER) FUNCTION public\.load_analysis_v2_collection_context_with_policy_v2/i,
        );
        expect(migration).not.toMatch(
            /SET\s+search_path\s*(?:=|TO)/i,
        );
    });
});
