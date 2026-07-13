import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713173056_add_analysis_v2_ai_result_checkpoint_cache.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function tableDefinition(name: string): string {
    const start = migration.indexOf(`CREATE TABLE public.${name} (`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end, `${name} must have a bounded definition`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('analysis V2 AI result checkpoint migration contract', () => {
    it('keeps both result tables RPC-only behind forced RLS', () => {
        for (const table of [
            'analysis_v2_ai_result_checkpoints',
            'analysis_v2_ai_global_result_cache',
        ]) {
            expect(migration).toContain(
                `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
            );
            expect(migration).toContain(
                `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`
            );
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(
                `GRANT (?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*public\\.${table}`
            ));
        }
        expect(migration).not.toContain('CREATE POLICY');
    });

    it('binds operation identity to every output-affecting policy and snapshot hash', () => {
        const validator = functionDefinition('analysis_v2_valid_ai_result_identity');
        for (const field of [
            'stage',
            'model_name',
            'thinking_level',
            'media_resolution',
            'prompt_version',
            'schema_version',
            'max_output_tokens',
            'input_hash',
            'media_snapshot_hash',
            'cache_scope',
        ]) {
            expect(validator).toContain(`'${field}'`);
        }
        expect(validator).toContain('NOT EXISTS (');
        expect(validator).toContain("p_identity->>'input_hash' ~ '^[0-9a-f]{64}$'");
        expect(validator).toContain("p_identity->>'media_snapshot_hash' ~ '^[0-9a-f]{64}$'");
        expect(validator).toContain("p_identity->>'stage' IN ('genderTriage', 'featureAnalysis')");

        const cacheKey = functionDefinition('analysis_v2_ai_result_cache_key');
        expectInOrder(cacheKey, [
            'analysis-v2-ai-result-cache:v1',
            "p_identity->>'stage'",
            "p_identity->>'model_name'",
            "p_identity->>'thinking_level'",
            "p_identity->>'media_resolution'",
            "p_identity->>'prompt_version'",
            "p_identity->>'schema_version'",
            "p_identity->>'max_output_tokens'",
            "p_identity->>'input_hash'",
            "p_identity->>'media_snapshot_hash'",
        ]);
        expect(cacheKey).toContain("'sha256'");
        expect(functionDefinition('analysis_v2_ai_result_operation_key'))
            .toContain('public.analysis_v2_ai_result_cache_key(p_identity)');
    });

    it('stores bounded object results and fences generated checkpoints to one attempt', () => {
        const checkpoint = tableDefinition('analysis_v2_ai_result_checkpoints');
        expect(checkpoint).toContain('PRIMARY KEY (request_id, operation_key)');
        expect(checkpoint).toContain('result_json JSONB NOT NULL');
        expect(checkpoint).toContain('result_canonical_json TEXT NOT NULL');
        expect(checkpoint).toContain('result_hash VARCHAR(64) NOT NULL');
        expect(checkpoint).toContain('max_output_tokens INTEGER NOT NULL');
        expect(checkpoint).toContain(
            'FOREIGN KEY (request_id, operation_key, attempt, reservation_token)'
        );
        expect(checkpoint).toContain('MATCH FULL ON DELETE CASCADE');
        expect(checkpoint).toContain("source = 'generated'");
        expect(checkpoint).toContain("source = 'global_cache'");
        expect(checkpoint).not.toMatch(/\b(username|caption|bio|image_url|prompt_text)\b/i);

        const resultValidator = functionDefinition('analysis_v2_valid_ai_result_json');
        expect(resultValidator).toContain("pg_catalog.jsonb_typeof(p_result) = 'object'");
        expect(resultValidator).toContain('BETWEEN 2 AND 262144');
        expect(resultValidator).toContain('<= 256');

        const envelopeValidator = functionDefinition('analysis_v2_valid_ai_result_envelope');
        expect(envelopeValidator).toContain('p_canonical::JSONB = p_result');
        expect(envelopeValidator).toContain('analysis-v2-ai-result-content:v1');
        expect(envelopeValidator).toContain('p_result_hash = pg_catalog.encode');
    });

    it('limits global reuse with per-key locking and bounded nonblocking maintenance', () => {
        const cache = tableDefinition('analysis_v2_ai_global_result_cache');
        expect(cache).toContain("stage IN ('genderTriage', 'featureAnalysis')");
        expect(cache).toContain("expires_at <= created_at + INTERVAL '6 hours'");
        expect(cache).toContain('hit_count BETWEEN 0 AND 1000000000');
        expect(cache).toContain('result_canonical_json TEXT NOT NULL');

        const terminalize = functionDefinition(
            'terminalize_analysis_v2_ai_attempt_with_result'
        );
        expect(terminalize).toContain(
            "p_result_identity->>'cache_scope' = 'global_ttl'"
        );
        expect(terminalize).toContain('pg_catalog.pg_advisory_xact_lock');
        expect(terminalize).toContain("'analysis-v2-ai-result-cache-key:' || v_cache_key");
        expect(terminalize).toContain('v_now := pg_catalog.clock_timestamp()');
        expect(terminalize).not.toContain('LOCK TABLE');

        const cacheHit = functionDefinition('checkpoint_analysis_v2_ai_global_cache_hit');
        expect(cacheHit).toContain("p_result_identity->>'cache_scope' <> 'global_ttl'");
        expect(cacheHit).toContain('cache.expires_at > v_now');
        expect(cacheHit).toContain("'global_cache'");
        expect(cacheHit).toContain('public.analysis_v2_valid_ai_result_envelope(');

        const maintenance = functionDefinition(
            'analysis_v2_maintain_ai_global_result_cache'
        );
        expect(maintenance).toContain('pg_catalog.pg_try_advisory_xact_lock');
        expect(maintenance).toContain('FOR UPDATE SKIP LOCKED');
        expect(maintenance).toContain('LIMIT p_delete_limit');
        expect(maintenance).toContain('OFFSET 10000');
        expect(maintenance).not.toContain('LOCK TABLE');
        expect(migration).not.toContain('LOCK TABLE public.analysis_v2_ai_global_result_cache');
    });

    it('makes success terminalization and result persistence one transaction', () => {
        expect(migration).toContain(
            ') RENAME TO analysis_v2_terminalize_ai_attempt_internal;'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_terminalize_ai_attempt_internal\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );

        const compatibility = functionDefinition('terminalize_analysis_v2_ai_attempt');
        expect(compatibility).toContain("IF p_status = 'success'");
        expect(compatibility).toContain("MESSAGE = 'ANALYSIS_V2_AI_RESULT_REQUIRED'");

        const atomic = functionDefinition('terminalize_analysis_v2_ai_attempt_with_result');
        expectInOrder(atomic, [
            'public.analysis_v2_valid_ai_result_identity(p_result_identity)',
            'public.analysis_v2_valid_ai_result_envelope(',
            "p_telemetry->>'finish_reason' IS DISTINCT FROM 'STOP'",
            'public.analysis_v2_terminalize_ai_attempt_internal(',
            "'success'",
            "v_request.status NOT IN ('pending', 'processing')",
            'INSERT INTO public.analysis_v2_ai_result_checkpoints',
        ]);
        expect(atomic).toContain(
            'p_operation_key IS DISTINCT FROM\n            public.analysis_v2_ai_result_operation_key(p_result_identity)'
        );
        expect(atomic).toContain("MESSAGE = 'ANALYSIS_V2_AI_RESULT_CONFLICT'");
        expect(atomic).toContain("'outcome', 'fenced'");
        expect(atomic).toContain("'outcome', 'checkpointed'");
        expect(atomic).toContain("p_telemetry->>'max_output_tokens' IS DISTINCT FROM");
    });

    it('requires a current live job fence before snapshotting a global hit', () => {
        const cacheHit = functionDefinition('checkpoint_analysis_v2_ai_global_cache_hit');
        expectInOrder(cacheHit, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_ai_result_checkpoints AS checkpoint',
            'pg_catalog.pg_advisory_xact_lock',
            'v_now := pg_catalog.clock_timestamp()',
        ]);
        expect(cacheHit).toContain("v_job.status <> 'processing'");
        expect(cacheHit).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(cacheHit).toContain('v_job.lease_expires_at <= v_now');
        expect(cacheHit).not.toContain('LOCK TABLE');
    });

    it('purges only terminal request checkpoints and never attempts or global cache rows', () => {
        const purge = functionDefinition('purge_analysis_v2_ai_result_checkpoints');
        expect(purge).toContain("analysis_request.pipeline_version = 'v2'");
        expect(purge).toContain("analysis_request.status IN ('completed', 'failed')");
        expect(purge).toContain('DELETE FROM public.analysis_v2_ai_result_checkpoints');
        expect(purge).not.toContain('analysis_v2_ai_attempts');
        expect(purge).not.toContain('analysis_v2_ai_global_result_cache');
    });

    it('exposes only bounded SECURITY DEFINER RPCs to service_role', () => {
        for (const rpc of [
            'terminalize_analysis_v2_ai_attempt',
            'terminalize_analysis_v2_ai_attempt_with_result',
            'checkpoint_analysis_v2_ai_global_cache_hit',
            'load_analysis_v2_ai_result_checkpoint',
            'purge_analysis_v2_ai_result_checkpoints',
            'maintain_analysis_v2_ai_global_result_cache',
        ]) {
            const definition = functionDefinition(rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }

        for (const helper of [
            'analysis_v2_valid_ai_result_identity',
            'analysis_v2_ai_result_cache_key',
            'analysis_v2_ai_result_operation_key',
            'analysis_v2_valid_ai_result_json',
            'analysis_v2_valid_ai_result_envelope',
            'analysis_v2_ai_result_checkpoint_json',
            'analysis_v2_maintain_ai_global_result_cache',
        ]) {
            expect(migration).not.toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${helper}\\(`
            ));
        }
    });
});
