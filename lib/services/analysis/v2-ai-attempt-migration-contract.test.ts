import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713170859_add_analysis_v2_ai_attempt_ledger.sql',
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

describe('analysis V2 AI attempt ledger migration contract', () => {
    it('keeps the service-only table behind forced RLS with no direct table DML', () => {
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_ai_attempts ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_ai_attempts FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_ai_attempts\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[\s\S]*?ON TABLE public\.analysis_v2_ai_attempts/i
        );
        expect(migration).not.toContain(
            'CREATE POLICY'
        );
    });

    it('uses the exact request, opaque operation, and attempt key without PII payload columns', () => {
        const table = tableDefinition('analysis_v2_ai_attempts');
        expect(table).toContain('PRIMARY KEY (request_id, operation_key, attempt)');
        expect(table).toContain('UNIQUE (reservation_token)');
        expect(table).toContain('FOREIGN KEY (request_id, job_key)');
        expect(table).not.toMatch(/\bJSONB\b/);
        expect(table).not.toMatch(/\b(username|caption|bio|image_url|prompt_text|response_text|evidence)\b/i);
        expect(table).toContain('model_name VARCHAR(100) NOT NULL');
        expect(table).toContain('thinking_level TEXT');
        expect(table).toContain('media_count SMALLINT NOT NULL');
        expect(table).toContain('max_output_tokens INTEGER NOT NULL');
        expect(table).toContain('estimated_cost_usd NUMERIC(15, 12)');
        expect(table).toContain('analysis_v2_ai_attempt_generation_failure_check');
    });

    it('allows only stage-bound SHA-256 operation identities, including partner safety', () => {
        const operationValidator = functionDefinition('analysis_v2_valid_ai_operation_key');
        expect(operationValidator).toContain('partner-safety');
        expect(operationValidator).toContain('[0-9a-f]{64}');
        expect(operationValidator).not.toContain('[A-Za-z0-9._-]');

        const stageMatcher = functionDefinition('analysis_v2_ai_operation_matches_stage');
        expect(stageMatcher).toContain("WHEN 'partnerSafety'");
        expect(stageMatcher).toContain("LIKE 'partner-safety:%'");
        expect(tableDefinition('analysis_v2_ai_attempts')).toContain("'partnerSafety'");
    });

    it('validates exact bounded reservation and terminal telemetry shapes', () => {
        const reservation = functionDefinition('analysis_v2_valid_ai_reservation_metadata');
        expect(reservation).toContain('NOT EXISTS (');
        expect(reservation).toContain("p_attempt BETWEEN 1 AND 4");
        expect(reservation).toContain("'model_name', 'location', 'stage', 'thinking_level'");
        expect(reservation).toContain("'media_resolution', 'prompt_version', 'schema_version'");
        expect(reservation).toContain("'max_output_tokens'");
        expect(reservation).toContain("(p_metadata->>'retry_count')::SMALLINT = p_attempt - 1");

        const terminal = functionDefinition('analysis_v2_valid_ai_terminal_telemetry');
        expect(terminal).toContain("'usage_metadata_status', 'usage_complete', 'prompt_tokens'");
        expect(terminal).toContain("BETWEEN 0 AND 3600000");
        expect(terminal).toContain('BETWEEN 0 AND 999.999999999999');
        expect(terminal).toContain("p_telemetry->>'usage_metadata_status' IN ('missing', 'malformed')");
        expect(terminal).toContain("p_telemetry->'estimated_cost_usd' = 'null'::JSONB");
        expectInOrder(terminal, [
            "(p_telemetry->>'total_tokens')::NUMERIC",
            "(p_telemetry->>'prompt_tokens')::NUMERIC",
            "(p_telemetry->>'completion_tokens')::NUMERIC",
            "(p_telemetry->>'thinking_tokens')::NUMERIC",
        ]);
    });

    it('reserves only under the current live job claim in canonical lock order', () => {
        const reserve = functionDefinition('reserve_analysis_v2_ai_attempt');
        expectInOrder(reserve, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_ai_attempts AS ai_attempt',
        ]);
        expect(reserve).toContain("v_job.status <> 'processing'");
        expect(reserve).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(reserve).toContain('v_job.lease_expires_at <= pg_catalog.clock_timestamp()');
        expect(reserve).toContain("v_previous.status <> 'rate_limited'");
        expect(reserve).not.toContain(
            'v_previous.job_claim_token IS DISTINCT FROM p_claim_token'
        );
        expect(reserve).toContain('v_previous.job_key IS DISTINCT FROM p_job_key');
        expect(reserve).toContain("v_previous.model_name IS DISTINCT FROM p_metadata->>'model_name'");
        expect(reserve).toContain("v_previous.prompt_version IS DISTINCT FROM p_metadata->>'prompt_version'");
        expect(reserve).toContain("'created', FALSE");
        expect(reserve).toContain("MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT'");
    });

    it('terminalizes one immutable reservation fence and permits only identical replay', () => {
        const terminalize = functionDefinition('terminalize_analysis_v2_ai_attempt');
        expectInOrder(terminalize, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_ai_attempts AS ai_attempt',
        ]);
        expect(terminalize).toContain(
            'v_existing.job_claim_token IS DISTINCT FROM p_claim_token'
        );
        expect(terminalize).toContain(
            'v_existing.reservation_token <> p_reservation_token'
        );
        expect(terminalize).toContain("'status', p_status");
        expect(terminalize).toContain("'telemetry', p_telemetry");
        expect(terminalize).toContain("p_status IN ('rate_limited', 'ambiguous')");
        expect(terminalize).toContain("p_telemetry->>'usage_metadata_status' <> 'missing'");
        expect(terminalize).toContain('v_existing.terminal_payload_hash <> v_payload_hash');
        expect(terminalize).toContain("AND ai_attempt.status = 'reserved'");
        expect(terminalize).not.toContain(
            'v_job.lease_expires_at <= pg_catalog.clock_timestamp()'
        );
    });

    it('loads ordered attempts and retains the PII-free ledger without a purge RPC', () => {
        const load = functionDefinition('load_analysis_v2_ai_operation');
        expect(load).toContain('ORDER BY ai_attempt.attempt');
        expect(load).toContain("'[]'::JSONB");

        expect(migration).not.toContain('purge_analysis_v2_ai_attempts');
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_ai_attempts');
    });

    it('exposes only the three bounded SECURITY DEFINER RPCs to service_role', () => {
        for (const rpc of [
            'reserve_analysis_v2_ai_attempt',
            'terminalize_analysis_v2_ai_attempt',
            'load_analysis_v2_ai_operation',
        ]) {
            const definition = functionDefinition(rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?\\)\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }

        for (const helper of [
            'analysis_v2_valid_ai_operation_key',
            'analysis_v2_ai_operation_matches_stage',
            'analysis_v2_valid_ai_reservation_metadata',
            'analysis_v2_valid_ai_terminal_telemetry',
            'analysis_v2_ai_attempt_json',
        ]) {
            expect(migration).not.toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${helper}\\(`
            ));
        }
    });
});
