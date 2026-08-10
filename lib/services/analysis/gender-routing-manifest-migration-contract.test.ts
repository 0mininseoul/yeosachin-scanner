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
        expect(migration).toContain('relationship_job_input_hash');
        expect(migration).toContain("'relationshipJobInputHash', p_manifest.relationship_job_input_hash");
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

    it('re-fences both selected loaders to the current paid-request scope and persisted job binding', () => {
        for (const name of [
            'load_analysis_v2_gender_routing_selected',
            'load_analysis_v2_gender_routing_selected_usernames',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain("v_request.pipeline_version IS DISTINCT FROM 'v2'");
            expect(definition).toContain("v_request.status IS DISTINCT FROM 'processing'");
            expect(definition).toContain("v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'");
            expect(definition).toContain('v_request.selected_plan_id_snapshot IS DISTINCT FROM p_plan_id');
            expect(definition).toContain("v_policy.mode IS DISTINCT FROM 'test_operation_split'");
            expect(definition).toContain("v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'");
            expect(definition).toContain(
                'v_job.input_hash IS DISTINCT FROM v_manifest.relationship_job_input_hash',
            );
            expect(definition).toContain(
                'v_relationship.public_count IS DISTINCT FROM v_manifest.population_count',
            );
            expect(definition).toContain('v_row_count IS DISTINCT FROM v_manifest.population_count');
        }
        expect(functionDefinition('publish_analysis_v2_gender_routing_manifest'))
            .toContain('p_model_failed_count::NUMERIC / p_model_attempted_count > 0.1');
    });
});
