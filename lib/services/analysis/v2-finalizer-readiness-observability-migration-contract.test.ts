import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724095000_add_analysis_v2_finalizer_readiness_observability.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 finalizer readiness observability migration', () => {
    it('exposes only bounded PII-free readiness checks to service role', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.load_analysis_v2_finalizer_readiness'
        );
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain("'relationshipEnvelopeReady'");
        expect(migration).toContain("'profileBatchesReady'");
        expect(migration).toContain("'featureRowsReady'");
        expect(migration).toContain("'privateRowsReady'");
        expect(migration).toContain("'primaryScreeningReady'");
        expect(migration).toContain("'finalNarrativeReady'");
        expect(migration).toContain("'genderCountsReady'");
        expect(migration).toContain("'ready'");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_finalizer_readiness\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_finalizer_readiness\(UUID\)[\s\S]*?TO service_role/
        );
    });

    it('never serializes identifiers, hashes, profile fields, or generated text', () => {
        const outputKeys = [...migration.matchAll(/'([A-Za-z][A-Za-z0-9]+)'\s*,/g)]
            .map(match => match[1]);
        expect(outputKeys).not.toEqual(expect.arrayContaining([
            'requestId',
            'username',
            'instagramId',
            'profileImageUrl',
            'bio',
            'narrative',
            'resultHash',
            'inputHash',
            'claimToken',
        ]));
    });
});
