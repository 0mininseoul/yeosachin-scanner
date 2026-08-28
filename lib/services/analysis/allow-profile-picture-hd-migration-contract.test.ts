import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828065323_allow_profile_picture_hd_in_snapshot_validator.sql',
        import.meta.url
    ),
    'utf8'
);

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('allow profilePicUrlHD in the profile snapshot validator migration', () => {
    it('replaces the existing wrapper in place instead of copying the base validator body', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_snapshot(p_profile JSONB)'
        );
        // Only one function is (re)defined: the wrapper. No CREATE (OR REPLACE) FUNCTION
        // for analysis_v2_valid_profile_snapshot_without_hidden_counts, i.e. no copied body.
        expect(migration.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
        expect(migration).toContain(
            'public.analysis_v2_valid_profile_snapshot_without_hidden_counts('
        );
    });

    it('validates profilePicUrlHD as an optional bounded http(s) URL before delegating', () => {
        expectInOrder(migration, [
            "NOT p_profile ? 'profilePicUrlHD'",
            "pg_catalog.jsonb_typeof(p_profile->'profilePicUrlHD') = 'string'",
            "pg_catalog.char_length(p_profile->>'profilePicUrlHD') BETWEEN 1 AND 8192",
            "p_profile->>'profilePicUrlHD' ~ '^https?://[^[:space:]]+$'",
            'public.analysis_v2_valid_profile_snapshot_without_hidden_counts(',
        ]);
    });

    it('strips the validated profilePicUrlHD before calling the base validator', () => {
        expect(migration).toContain("- 'profilePicUrlHD'");
    });

    it('preserves existing hidden-count sentinel handling', () => {
        expect(migration).toContain("post.value ? 'likesCountHidden'");
        expect(migration).toContain("post.value ? 'commentsCountHidden'");
        expect(migration).toContain(
            "post.value - 'likesCountHidden' - 'commentsCountHidden'"
        );
    });

    it('preserves the restrictive ACL on the wrapper', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)\n'
            + '    FROM PUBLIC, anon, authenticated, service_role;'
        );
    });

    it('does not touch the analysis_v2_profile_fetch_outcomes CHECK constraint', () => {
        expect(migration).not.toContain('ALTER TABLE');
        expect(migration).not.toContain('DROP CONSTRAINT');
    });
});
