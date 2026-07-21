import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260722102000_allow_partner_safety_target_profile_consumer.sql',
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

describe('analysis V2 partner target-profile consumer migration', () => {
    it('allows the exact partner-safety job without broadening the target producer', () => {
        const load = functionDefinition(
            'load_analysis_v2_profile_fetch_for_consumer'
        );

        expect(load).toContain(
            "ELSIF p_producer_job_key = 'track:target-evidence:collect'"
        );
        for (const consumer of [
            'coordinator:candidate-screening',
            'track:reverse-likes:collect',
            'track:partner-safety:batch:0',
            'track:narratives:batch:0',
            'coordinator:finalize',
        ]) {
            expect(load).toContain(`'${consumer}'`);
        }
        expect(load).not.toMatch(/v_consumer\.job_key\s+(?:LIKE|~)/);
    });

    it('preserves the service-only execution boundary', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_fetch_for_consumer('
        );
        expect(migration).toContain(
            ') FROM PUBLIC, anon, authenticated, service_role;'
        );
        expect(migration).toContain(
            ') TO service_role;'
        );
    });
});
