import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real base validator (renamed to *_without_hidden_counts by
// 20260721164500_preserve_hidden_engagement_sentinels.sql) and the wrapper this hotfix
// replaces in place. Loading both function bodies verbatim from the migrations keeps this
// test bound to production behavior instead of a hand-rolled reimplementation.
const baseValidatorSource = readFileSync(
    new URL(
        '../../../supabase/migrations/20260716130000_allow_carousel_child_captions.sql',
        import.meta.url
    ),
    'utf8'
);
const wrapperSource = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828065323_allow_profile_picture_hd_in_snapshot_validator.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(source: string, name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return source.slice(start, end + 4);
}

// Mirrors the ALTER FUNCTION ... RENAME TO applied in
// 20260721164500_preserve_hidden_engagement_sentinels.sql: the base validator body is
// unchanged since 20260716130000, only its name moved.
const baseValidatorRenamed = functionDefinition(
    baseValidatorSource,
    'analysis_v2_valid_profile_snapshot'
).replace(
    'public.analysis_v2_valid_profile_snapshot(',
    'public.analysis_v2_valid_profile_snapshot_without_hidden_counts('
);
const wrapperDefinition = functionDefinition(
    wrapperSource,
    'analysis_v2_valid_profile_snapshot'
);

let db: PGlite;

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        username: 'target.account',
        followersCount: 100,
        followingCount: 50,
        postsCount: 10,
        isPrivate: false,
        isVerified: false,
        ...overrides,
    };
}

async function isValid(profile: unknown): Promise<boolean | null> {
    const result = await db.query<{ valid: boolean | null }>(
        'SELECT public.analysis_v2_valid_profile_snapshot($1::jsonb) AS valid',
        [JSON.stringify(profile)]
    );
    return result.rows[0]?.valid ?? null;
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;

        ${baseValidatorRenamed}

        ${wrapperDefinition}

        REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot_without_hidden_counts(JSONB)
            FROM PUBLIC, anon, authenticated, service_role;
        REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
            FROM PUBLIC, anon, authenticated, service_role;
    `);
});

afterAll(async () => {
    await db.close();
});

describe('analysis_v2_valid_profile_snapshot profilePicUrlHD acceptance', () => {
    it('accepts a bounded valid profile without profilePicUrlHD', async () => {
        expect(await isValid(baseProfile())).toBe(true);
    });

    it('accepts a bounded https profilePicUrlHD', async () => {
        expect(await isValid(baseProfile({
            profilePicUrlHD: 'https://cdn.example.com/hd.jpg',
        }))).toBe(true);
    });

    it('accepts a bounded http profilePicUrlHD', async () => {
        expect(await isValid(baseProfile({
            profilePicUrlHD: 'http://cdn.example.com/hd.jpg',
        }))).toBe(true);
    });

    it('rejects a non-string profilePicUrlHD', async () => {
        expect(await isValid(baseProfile({ profilePicUrlHD: 12345 }))).toBe(false);
    });

    it('rejects an oversized profilePicUrlHD', async () => {
        const oversized = `https://cdn.example.com/${'a'.repeat(8_200)}`;
        expect(oversized.length).toBeGreaterThan(8_192);
        expect(await isValid(baseProfile({ profilePicUrlHD: oversized }))).toBe(false);
    });

    it('rejects a non-http(s) scheme profilePicUrlHD', async () => {
        expect(await isValid(baseProfile({
            profilePicUrlHD: 'javascript:alert(1)',
        }))).toBe(false);
    });

    it('rejects a profilePicUrlHD containing whitespace', async () => {
        expect(await isValid(baseProfile({
            profilePicUrlHD: 'https://cdn.example.com/hd image.jpg',
        }))).toBe(false);
    });

    it('rejects an empty profilePicUrlHD', async () => {
        expect(await isValid(baseProfile({ profilePicUrlHD: '' }))).toBe(false);
    });

    it('still rejects an unrelated unknown key even when profilePicUrlHD is valid', async () => {
        expect(await isValid(baseProfile({
            profilePicUrlHD: 'https://cdn.example.com/hd.jpg',
            bogusField: 'x',
        }))).toBe(false);
    });

    it('keeps hidden-engagement sentinel handling intact alongside a valid profilePicUrlHD', async () => {
        const post = {
            id: 'post-1',
            shortCode: 'abc123',
            type: 'image',
            likesCount: 0,
            commentsCount: 0,
            likesCountHidden: true,
            commentsCountHidden: true,
            timestamp: '2026-08-27T00:00:00.000Z',
            taggedUsers: [] as string[],
            mentionedUsers: [] as string[],
        };
        const withHiddenCounts = baseProfile({
            profilePicUrlHD: 'https://cdn.example.com/hd.jpg',
            latestPosts: [post],
        });
        expect(await isValid(withHiddenCounts)).toBe(true);

        const withInvalidSentinel = baseProfile({
            profilePicUrlHD: 'https://cdn.example.com/hd.jpg',
            latestPosts: [{ ...post, likesCountHidden: false }],
        });
        expect(await isValid(withInvalidSentinel)).toBe(false);
    });

    it('allows only the function owner to execute either validator, not anon/authenticated/service_role', async () => {
        const privileges = await db.query<{
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_execute: boolean;
        }>(`SELECT
            has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon_execute,
            has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated_execute,
            has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_execute`,
        ['public.analysis_v2_valid_profile_snapshot(jsonb)']);
        expect(privileges.rows).toEqual([{
            anon_execute: false,
            authenticated_execute: false,
            service_execute: false,
        }]);
    });
});
