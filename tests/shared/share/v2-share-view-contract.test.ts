import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');
}

/* The shared payload stopped being the owner payload, but nothing failed when
 * the view kept reading it as one: the page casts the response with `as`, so the
 * compiler had no opinion and the suite stayed green while every row would have
 * rendered `@undefined` with colliding React keys.
 *
 * These assertions are on the source because the mapper lives in a client
 * component with no test environment to mount it in.
 */
describe('shared view reads the masked shape', () => {
    const page = source('app/share/[token]/page.tsx');

    it('does not reuse the owner mapper', () => {
        // mapV2Result reads instagramId and fullName off rows that no longer
        // carry either.
        expect(page).not.toMatch(/\bmapV2Result\b/);
        expect(page).toContain('mapV2SharedResult');
    });

    it('maps from the masked fields the server actually sends', () => {
        const mapper = page.match(/function mapV2SharedResult[\s\S]*?\n\}/)?.[0];
        expect(mapper, 'mapV2SharedResult should be findable').toBeTruthy();
        expect(mapper).toContain('account.handleMasked');
        expect(mapper).toContain('account.accountKey');
        // Names and bios are dropped outright rather than masked: a row of
        // bullets is noise, and a bio identifies as readily as a name.
        expect(mapper).not.toContain('fullNameMasked');
        expect(mapper).not.toMatch(/bio: account\.bio/);
        // Reading these would silently produce undefined.
        expect(mapper).not.toMatch(/account\.instagramId\b/);
        expect(mapper).not.toMatch(/account\.fullName\b(?!Masked)/);
    });

    it('keys rows by the opaque account key, not by a handle', () => {
        // Masked handles collide: two accounts starting with the same two
        // characters mask to the same string.
        expect(page).toMatch(/key=\{account\.accountKey \?\? account\.instagramId\}/);
    });

    it('leaves server-masked rows alone instead of blurring them again', () => {
        // v2 arrives as bullets already; blurring bullets only costs legibility.
        expect(page).toContain('maskedByClient');
        expect(page).toMatch(/maskHandle=\{data\.maskedByClient\}/);
        // Legacy v1 shares still carry real identities and still need the blur.
        expect(page).toMatch(/maskedByClient: true/);
    });
});

describe('the shared schema refuses to carry identities', () => {
    const schema = source('lib/services/share/v2-result-share.ts');

    it('builds its rows from an explicit whitelist', () => {
        const female = schema.match(/const sharedFemaleResultRowSchema = [\s\S]*?\}\)\.strict\(\);/)?.[0];
        const priv = schema.match(/const sharedPrivateResultRowSchema = [\s\S]*?\}\)\.strict\(\);/)?.[0];
        expect(female, 'female row schema should be findable').toBeTruthy();
        expect(priv, 'private row schema should be findable').toBeTruthy();

        for (const row of [female!, priv!]) {
            expect(row).toContain('handleMasked');
            expect(row).toContain('accountKey');
            expect(row).not.toMatch(/\binstagramId\b/);
            expect(row).not.toMatch(/\binstagramUrl\b/);
            // strict() is what stops a future owner-side field riding along.
            expect(row).toMatch(/\.strict\(\);$/);
        }
        expect(female).not.toMatch(/\bbio\b/);
    });

    it('no longer derives itself from the owner page schema', () => {
        // The old shape was analysisResultPageV1Schema plus isShared, so every
        // field added upstream reached anonymous readers for free.
        expect(schema).not.toMatch(/analysisResultPageV1Schema\.safeExtend/);
    });
});
