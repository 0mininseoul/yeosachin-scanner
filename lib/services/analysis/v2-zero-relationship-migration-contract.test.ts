import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713175434_add_analysis_v2_evidence_staging.sql',
        import.meta.url
    ),
    'utf8'
);
const zeroMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713202716_support_zero_relationship_evidence.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return source.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    fragments.forEach((fragment) => {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    });
}

describe('analysis V2 zero relationship evidence migration contract', () => {
    it('adds explicit source semantics without rewriting the applied evidence migration', () => {
        expect(zeroMigration).toContain(
            "ADD COLUMN source_status VARCHAR(24) NOT NULL DEFAULT 'collected'"
        );
        for (const column of [
            'provider',
            'provider_run_id',
            'provider_operation_key',
            'provider_credential_slot',
        ]) {
            expect(zeroMigration).toContain(`ALTER COLUMN ${column} DROP NOT NULL`);
        }
        expect(zeroMigration).toContain("source_status = 'not_applicable'");
        expect(zeroMigration).toContain('declared_count = 0');
        expect(zeroMigration).toContain('collected_count = 0');
        expect(zeroMigration).toContain('coverage_bps = 10000');
        expect(zeroMigration).toContain('provider_run_id IS NULL');
        expect(zeroMigration).toContain('provider_operation_key IS NULL');
        expect(zeroMigration).toContain("source_status = 'collected'");
        expect(zeroMigration).toContain('declared_count > 0');
        expect(zeroMigration).toContain("provider = 'apify'");
    });

    it('derives the zero input hash from only the fixed domain, side, and zero count', () => {
        const helper = functionDefinition(
            zeroMigration,
            'analysis_v2_relationship_not_applicable_input_hash'
        );
        expect(helper).toContain("'analysis-v2-relationship-not-applicable-v1'");
        expect(helper).toContain("p_side IN ('followers', 'following')");
        expect(helper).toContain("|| '0'");
        expect(helper).toContain("'sha256'");
        expect(helper).not.toMatch(/request_id|username|provider|operation|run_id/i);
        expect(zeroMigration).toContain(
            'input_hash = public.analysis_v2_relationship_not_applicable_input_hash(side)'
        );
    });

    it('exposes a zero-only RPC that cannot receive rows or provider identity', () => {
        const checkpoint = functionDefinition(
            zeroMigration,
            'checkpoint_analysis_v2_relationship_side_not_applicable'
        );
        const signature = checkpoint.slice(0, checkpoint.indexOf('RETURNS JSONB'));
        expect(signature).not.toMatch(/p_provider|p_rows|p_input_hash|p_result_hash/i);
        expect(checkpoint).not.toContain('analysis_v2_provider_runs');
        expect(checkpoint).toContain(
            "v_result_hash := public.analysis_v2_relationship_rows_hash(p_side, '[]'::JSONB)"
        );
        expect(checkpoint).toContain(
            'v_input_hash := public.analysis_v2_relationship_not_applicable_input_hash(p_side)'
        );
        expect(checkpoint).toContain("END) IS DISTINCT FROM 0");
        expect(checkpoint).toContain("'not_applicable'");
        expect(checkpoint).toContain('10000');
        expect(checkpoint).toContain("MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_SIDE_CONFLICT'");
        expect(checkpoint).not.toContain('INSERT INTO public.analysis_v2_relationship_rows');
    });

    it('retains canonical locks and a live job fence for the zero checkpoint', () => {
        const checkpoint = functionDefinition(
            zeroMigration,
            'checkpoint_analysis_v2_relationship_side_not_applicable'
        );
        expectInOrder(checkpoint, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_relationship_sides AS relationship_side',
        ]);
        expect(checkpoint).toContain("v_preflight.status <> 'consumed'");
        expect(checkpoint).toContain("v_job.status <> 'processing'");
        expect(checkpoint).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
        expect(checkpoint).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(checkpoint).toContain('v_job.lease_expires_at <= v_now');
        expect(checkpoint).toContain("MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH'");
    });

    it('keeps nonzero sides bound to succeeded Apify proof', () => {
        const checkpoint = functionDefinition(
            baseMigration,
            'checkpoint_analysis_v2_relationship_side'
        );
        expect(checkpoint).toContain('FROM public.analysis_v2_provider_runs AS provider_run');
        expect(checkpoint).toContain(
            'v_provider_run.input_hash IS DISTINCT FROM p_input_hash'
        );
        expect(checkpoint).toContain(
            'v_provider_run.run_id IS DISTINCT FROM p_provider_run_id'
        );
        expect(checkpoint).toContain("v_provider_run.status <> 'succeeded'");
        expect(zeroMigration).toContain("source_status = 'collected'");
        expect(zeroMigration).toContain("provider = 'apify'");
    });

    it('treats an exact zero side as complete coverage when freezing', () => {
        const sideTable = baseMigration.slice(
            baseMigration.indexOf('CREATE TABLE public.analysis_v2_relationship_sides ('),
            baseMigration.indexOf('CREATE TABLE public.analysis_v2_relationship_rows (')
        );
        expect(sideTable).toContain(
            '(declared_count = 0 AND collected_count = 0 AND coverage_bps = 10000)'
        );
        const freeze = functionDefinition(baseMigration, 'freeze_analysis_v2_relationships');
        const sideLoads = freeze.slice(
            freeze.indexOf('FROM public.analysis_v2_relationship_sides AS relationship_side'),
            freeze.indexOf('v_excluded_username :=')
        );
        expect(sideLoads).not.toMatch(/declared_count\s*>\s*0|collected_count\s*>\s*0/);
        expect(freeze).toContain("COALESCE(pg_catalog.jsonb_agg(");
        expect(freeze).toContain("), '[]'::JSONB)");
    });

    it('preserves forced RLS and grants only the zero RPC to service_role', () => {
        expect(baseMigration).toContain(
            'ALTER TABLE public.analysis_v2_relationship_sides FORCE ROW LEVEL SECURITY'
        );
        expect(baseMigration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_relationship_sides\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(zeroMigration).not.toMatch(
            /GRANT [^;]+ ON TABLE public\.analysis_v2_relationship_sides/
        );
        const checkpoint = functionDefinition(
            zeroMigration,
            'checkpoint_analysis_v2_relationship_side_not_applicable'
        );
        expect(checkpoint).toContain('SECURITY DEFINER');
        expect(checkpoint).toContain("SET search_path = ''");
        expect(zeroMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.checkpoint_analysis_v2_relationship_side_not_applicable\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(zeroMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.checkpoint_analysis_v2_relationship_side_not_applicable\([\s\S]*?\) TO service_role;/
        );
        expect(zeroMigration).not.toMatch(/\) TO (?:PUBLIC|anon|authenticated);/);
    });
});
