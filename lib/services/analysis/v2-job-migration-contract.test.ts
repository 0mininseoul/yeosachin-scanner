import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713155145_add_analysis_v2_job_foundation.sql',
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

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('analysis V2 job migration concurrency contract', () => {
    it('keeps terminal-capable paths on the preflight -> request -> job lock order', () => {
        for (const name of [
            'claim_analysis_v2_job',
            'release_analysis_v2_job_claim',
            'finalize_analysis_v2_request',
        ]) {
            expectInOrder(functionDefinition(name), [
                'FROM public.analysis_preflights AS preflight',
                'FROM public.analysis_requests AS analysis_request',
                'FROM public.analysis_pipeline_jobs AS job',
            ]);
        }
    });

    it('retries an early same-fence delivery while acknowledging only a real stale fence', () => {
        const claim = functionDefinition('claim_analysis_v2_job');
        expectInOrder(claim, [
            'v_job.dispatch_generation <> p_dispatch_generation',
            "MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH'",
            "v_job.dispatch_state = 'reserved'",
            "MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY'",
            "v_job.dispatch_state NOT IN ('enqueued', 'delivered')",
        ]);
    });

    it('reserves successful completion for a dependency-complete finalizer', () => {
        const finalize = functionDefinition('finalize_analysis_v2_request');
        expect(finalize).toContain("p_job_key <> 'coordinator:finalize'");
        expect(finalize).toContain("v_job.track <> 'coordinator'");
        expect(finalize).toContain("v_job.kind <> 'finalizer'");
        expect(finalize).toContain('pg_catalog.cardinality(v_job.required_job_keys) < 1');
        expect(finalize).toContain("required_job.status <> 'completed'");
        expect(finalize).toContain("sibling.status IN ('pending', 'processing')");
        expect(finalize).toContain("MESSAGE = 'ANALYSIS_V2_FINALIZE_NOT_READY'");
        expect(finalize).not.toContain("last_error_code = COALESCE(job.last_error_code, 'REQUEST_TERMINATED')");
    });

    it('returns current request state on entitlement replays', () => {
        const consume = functionDefinition('consume_analysis_v2_test_entitlement');
        expect(consume).toContain('request_status TEXT');
        expect(consume).toContain('background_processing BOOLEAN');
        expect(consume).toContain('v_request.status::TEXT');
        expect(consume).toContain('v_request.background_processing');
    });
});
