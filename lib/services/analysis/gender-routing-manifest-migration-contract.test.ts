import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql',
        import.meta.url,
    ),
    'utf8',
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end + '\n$$;'.length);
}

describe('analysis V2 gender-routing manifest migration contract', () => {
    it('creates a PII-free manifest keyed by request, relationship checkpoint, and policy version', () => {
        expect(migration).toContain('CREATE TABLE public.analysis_v2_gender_routing_manifests');
        expect(migration).toContain('CREATE TABLE public.analysis_v2_gender_routing_candidates');
        expect(migration).toContain('PRIMARY KEY (request_id, relationship_checkpoint_id, policy_version)');
        expect(migration).toContain('FOREIGN KEY (request_id, relationship_job_key, mutual_ordinal)');
        const candidates = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_v2_gender_routing_candidates'),
            migration.indexOf('ALTER TABLE public.analysis_v2_gender_routing_manifests')
        );
        expect(candidates).not.toMatch(/\b(username|full_name|profile_pic_url|bio)\b/i);
        expect(migration).toContain('canonical_input_hmac');
        expect(migration).toContain("status IN ('building', 'complete', 'invalidated')");
    });

    it('exposes only fenced service-role RPCs with forced RLS and an explicit empty search path', () => {
        for (const table of [
            'analysis_v2_gender_routing_manifests',
            'analysis_v2_gender_routing_candidates',
        ]) {
            expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toContain(`REVOKE ALL ON TABLE public.${table}`);
        }
        for (const name of [
            'begin_analysis_v2_gender_routing_manifest',
            'publish_analysis_v2_gender_routing_manifest',
            'load_analysis_v2_gender_routing_selected',
            'load_analysis_v2_gender_routing_selected_usernames',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(definition).toContain('FOR UPDATE');
            expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${name}`);
            expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}`);
        }
        expect(functionDefinition('load_analysis_v2_gender_routing_selected'))
            .toContain("v_manifest.status IS DISTINCT FROM 'complete'");
    });

    it('requires the complete relationship population in both manifest mutations', () => {
        for (const name of [
            'begin_analysis_v2_gender_routing_manifest',
            'publish_analysis_v2_gender_routing_manifest',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain(
                'v_relationship.public_count IS DISTINCT FROM p_population_count',
            );
            expect(definition).not.toContain('LEAST(\n            v_relationship.public_count');
        }
    });
});
