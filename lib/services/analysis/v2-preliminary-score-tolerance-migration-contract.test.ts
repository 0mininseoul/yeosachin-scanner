import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260722100000_tolerate_preliminary_score_float_serialization.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end + '\n$$;'.length);
}

describe('analysis V2 preliminary score float tolerance migration', () => {
    it('range-checks the serialized upper bound before applying one consistent tolerance', () => {
        const checkpoint = functionDefinition(
            'checkpoint_analysis_v2_preliminary_scores'
        );

        expect(checkpoint).toContain(
            "(item.value->>'possibleUpperBound')::NUMERIC NOT BETWEEN 0 AND 100"
        );
        expect(checkpoint).toContain(
            "LEAST((item.value->>'preScore')::NUMERIC + 3, 100)"
        );
        expect(checkpoint).toContain(') > 0.0001');
        expect(checkpoint).not.toMatch(
            /possibleUpperBound'\)::NUMERIC\s+NOT BETWEEN \(item\.value->>'preScore'\)::NUMERIC\s+AND \(item\.value->>'preScore'\)::NUMERIC \+ 3/
        );
    });

    it('preserves the service-only execution boundary', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores('
        );
        expect(migration).toContain(
            ') FROM PUBLIC, anon, authenticated, service_role;'
        );
        expect(migration).toContain(
            ') TO service_role;'
        );
    });
});
