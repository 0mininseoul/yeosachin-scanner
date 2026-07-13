import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20260713183106_add_analysis_v2_dag_state_checkpoints.sql'
);
const migration = fs.readFileSync(migrationPath, 'utf8');

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
    return migration.slice(start, next < 0 ? migration.length : next);
}

function tableDefinition(name: string): string {
    const start = migration.indexOf(`CREATE TABLE public.${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end + 3);
}

describe('analysis V2 DAG state migration contract', () => {
    it('uses typed append-only rows instead of a mutable JSON state blob', () => {
        for (const table of [
            'analysis_v2_dag_scopes',
            'analysis_v2_dag_stage_manifests',
            'analysis_v2_dag_batch_topology',
            'analysis_v2_dag_batch_results',
        ]) {
            expect(migration).toContain(`CREATE TABLE public.${table}`);
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toContain(`REVOKE ALL ON TABLE public.${table}`);
            expect(migration).not.toMatch(new RegExp(
                `GRANT (?:SELECT|INSERT|UPDATE|DELETE).*${table}`,
                'i'
            ));
        }
        expect(tableDefinition('analysis_v2_dag_scopes')).not.toContain('JSONB');
        expect(tableDefinition('analysis_v2_dag_stage_manifests')).not.toContain('JSONB');
        expect(tableDefinition('analysis_v2_dag_batch_results')).not.toContain('JSONB');
    });

    it('derives immutable scope hashes from the request under the exact bootstrap lease', () => {
        const definition = functionDefinition('initialize_analysis_v2_dag_scope');
        expect(definition).toContain("p_job_key <> 'coordinator:bootstrap'");
        expect(definition).toContain("v_job.status <> 'processing'");
        expect(definition).toContain('v_job.input_hash <> p_input_hash');
        expect(definition).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(definition).toContain('v_job.lease_expires_at <= v_now');
        expect(definition).toContain("'targetInstagramId'");
        expect(definition).toContain("'planCard'");
        expect(definition).toContain("'excludedInstagramId'");
        expect(definition).toContain("'domain', 'analysis-v2-exclusion-decision-v1'");
        expect(definition).toContain("'requestId', p_request_id");
        expect(definition).toContain('v_scope.request_snapshot_hash <> v_request_hash');
        expect(definition).toContain("MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT'");
        expect(definition).not.toContain('UPDATE public.analysis_v2_dag_scopes');
    });

    it('fences every manifest by producer key, exact input hash, and live claim', () => {
        const definition = functionDefinition('checkpoint_analysis_v2_dag_manifest');
        expect(definition).toContain('v_job.input_hash <> p_input_hash');
        expect(definition).toContain("v_job.status <> 'processing'");
        expect(definition).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(definition).toContain('v_job.lease_expires_at <= v_now');
        expect(definition).toContain('v_stage.producer_job_key <> p_job_key');
        expect(definition).toContain('v_stage.producer_input_hash <> p_input_hash');
        expect(definition).toContain('v_stage.result_hash <> v_result_hash');
        expect(definition).not.toContain('UPDATE public.analysis_v2_dag_stage_manifests');
        expect(definition).not.toContain('UPDATE public.analysis_v2_dag_batch_results');
    });

    it('makes typed stage shape checks total under SQL three-valued logic', () => {
        const table = tableDefinition('analysis_v2_dag_stage_manifests');
        expect(table).toContain('not_screened_public_count\n            ) = 5');
        expect(table).toContain('interactor_count IS NOT NULL');
        expect(table).toContain('verified_female_count IS NOT NULL');
        expect(table).toContain('shortlist_count IS NOT NULL');
        expect(table).toContain('featured_high_risk_count IS NOT NULL');
        expect(table).toContain('narrative_count IS NOT NULL');
    });

    it('stores canonical relationship topology atomically and rejects conflicting replay', () => {
        const definition = functionDefinition('checkpoint_analysis_v2_dag_manifest');
        expect(definition).toContain("p_manifest_kind = 'relationships'");
        expect(definition).toContain("topology_kind = 'profile'");
        expect(definition).toContain("topology_kind = 'private_name'");
        expect(definition).toContain('WITH ORDINALITY AS item(value, ordinal)');
        expect(definition).toContain('v_existing_batches <> v_profile_batches');
        expect(definition).toContain('v_existing_batches <> v_private_batches');
        expect(definition).toContain('topology.producer_input_hash <> p_input_hash');
        expect(definition).not.toContain('ON CONFLICT');
    });

    it('preserves exact profile and private batch producerInputHash lineage', () => {
        const table = tableDefinition('analysis_v2_dag_batch_results');
        expect(table).toContain('producer_input_hash VARCHAR(64) NOT NULL');
        expect(table).toContain("WHEN 'profile_fetch' THEN 'track:profiles:batch:'");
        expect(table).toContain("WHEN 'profile_ai' THEN 'track:profile-ai:batch:'");
        expect(table).toContain("WHEN 'private_name' THEN 'track:private-names:batch:'");
        const checkpoint = functionDefinition('checkpoint_analysis_v2_dag_manifest');
        expect(checkpoint).toContain("p_manifest->>'producerInputHash' <> p_input_hash");
        expect(checkpoint).toContain('v_batch_result.producer_input_hash <> p_input_hash');
        const load = functionDefinition('analysis_v2_dag_state_json');
        expect(load).toContain("'producerInputHash', result.producer_input_hash");
    });

    it('enforces stage dependencies and planner bounds before appending', () => {
        const definition = functionDefinition('checkpoint_analysis_v2_dag_manifest');
        expect(definition).toContain('v_detailed <> LEAST(v_public, v_profile_limit)');
        expect(definition).toContain("stage.stage_kind = 'target_evidence'");
        expect(definition).toContain("result.result_kind = 'profile_ai'");
        expect(definition).toContain("stage.stage_kind = 'primary_join'");
        expect(definition).toContain("stage.stage_kind = 'screening'");
        expect(definition).toContain("stage.stage_kind = 'reverse_likes'");
        expect(definition).toContain("stage.stage_kind = 'partner_safety'");
        expect(definition).toContain("stage.stage_kind = 'final_score'");
    });

    it('exposes only service-role RPCs and retains state past terminal PII purge', () => {
        for (const rpc of [
            'initialize_analysis_v2_dag_scope',
            'checkpoint_analysis_v2_dag_manifest',
            'load_analysis_v2_dag_state',
        ]) {
            const definition = functionDefinition(rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
        expect(migration).not.toMatch(/purge_analysis_v2_dag/i);
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_dag_');
        for (const table of [
            'analysis_v2_dag_scopes',
            'analysis_v2_dag_stage_manifests',
            'analysis_v2_dag_batch_topology',
            'analysis_v2_dag_batch_results',
        ]) {
            expect(tableDefinition(table)).not.toMatch(
                /(?:username|comment_text|caption|liker)\s+(?:TEXT|VARCHAR|JSONB)/i
            );
        }
    });
});
