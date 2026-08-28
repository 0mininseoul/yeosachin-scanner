import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260829110000_admit_bounded_direct_fresh_apify_consumer.sql',
        import.meta.url
    ),
    'utf8'
);
const priorConsumerMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260722102000_allow_partner_safety_target_profile_consumer.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string, source = migration): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return source.slice(start, end + '\n$$;'.length);
}

describe('bounded direct fresh_apify consumer migration', () => {
    it('adds a server-derived readiness predicate that never trusts caller input', () => {
        const ready = functionDefinition(
            'analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready'
        );
        expect(ready).toContain('LANGUAGE sql');
        expect(ready).toContain('STABLE');
        expect(ready).toContain('SECURITY DEFINER');
        expect(ready).toContain("SET search_path = ''");
        expect(ready).not.toMatch(/p_batch|p_outcomes|p_frozen/);
    });

    it('requires no fallback or repair state anywhere on the batch', () => {
        const ready = functionDefinition(
            'analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready'
        );
        for (const clause of [
            'batch.fallback_completed_at IS NULL',
            'batch.fallback_payload_hash IS NULL',
            'batch.repair_completed_at IS NULL',
            'batch.repair_payload_hash IS NULL',
            'batch.repair_usernames IS NULL',
        ]) {
            expect(ready).toContain(clause);
        }
    });

    it('proves exact requested cardinality with no bound at all on requested_usernames', () => {
        const ready = functionDefinition(
            'analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready'
        );
        expect(ready).toContain(
            'pg_catalog.cardinality(batch.requested_usernames) = p_expected_item_count'
        );
    });

    it('proves frozen_unresolved_usernames exactly matches every non-success outcome row, unbounded', () => {
        const ready = functionDefinition(
            'analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready'
        );
        expect(ready).toContain('batch.frozen_unresolved_usernames = COALESCE((');
        expect(ready).toContain(
            "pg_catalog.array_agg(outcome.username ORDER BY outcome.ordinal)"
        );
        expect(ready).toContain("outcome.status <> 'success'");
        // frozen_unresolved_usernames covers both 'unavailable' and 'failed'
        // rows, but cardinality(frozen_unresolved_usernames) is never bounded
        // -- only the count of 'failed' rows is (see the next test). This
        // mirrors evaluateProfileBatchCompleteness, which filters on
        // status === 'failed' only, never on the full non-success set.
        expect(ready).not.toMatch(
            /cardinality\(batch\.frozen_unresolved_usernames\)\s*<=/
        );
    });

    it('bounds only the count of failed rows by requested_count - CEIL(0.9x), never unavailable', () => {
        const ready = functionDefinition(
            'analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready'
        );
        expect(ready).toMatch(
            /SELECT pg_catalog\.count\(\*\)\s*\n\s*FROM public\.analysis_v2_profile_fetch_outcomes AS outcome\s*\n\s*WHERE outcome\.request_id = batch\.request_id\s*\n\s*AND outcome\.job_key = batch\.job_key\s*\n\s*AND outcome\.status = 'failed'\s*\n\s*\)\s*<=\s*\(/
        );
        expect(ready).toContain('pg_catalog.ceil(p_expected_item_count * 0.9)::INTEGER');
    });

    it('requires an exact outcome row count and accepts success/unavailable/failed at their aligned ordinal and username', () => {
        const ready = functionDefinition(
            'analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready'
        );
        expect(ready).toContain('SELECT pg_catalog.count(*)');
        expect(ready).toMatch(/\)\s*=\s*p_expected_item_count/);
        expect(ready).toContain("outcome.attempt <> 'fresh_apify'");
        expect(ready).toContain("outcome.source <> 'apify'");
        expect(ready).toContain('outcome.ordinal < 1');
        expect(ready).toContain('outcome.ordinal > p_expected_item_count');
        expect(ready).toContain(
            'outcome.username IS DISTINCT FROM'
        );
        expect(ready).toContain(
            'batch.requested_usernames[outcome.ordinal::INTEGER]'
        );
        // 'unavailable' is schema-valid and accepted unconditionally (never
        // rejected, never given a category check); only 'failed' rows are
        // further constrained to failure_category incomplete/schema.
        expect(ready).toContain(
            "outcome.status NOT IN ('success', 'unavailable', 'failed')"
        );
        expect(ready).toContain("outcome.status = 'failed'");
        expect(ready).toContain(
            "outcome.failure_category NOT IN ('incomplete', 'schema')"
        );
        expect(ready).not.toMatch(/outcome\.status\s*<>\s*'failed'/);
        // Transient/other failure categories (timeout, rate_limit, auth,
        // transport, http, unknown) are deliberately excluded from the
        // accepted 'failed' set.
        expect(ready).not.toContain('timeout');
    });

    it('is never granted execute directly -- only the consumer RPC may call it', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready\(\s*UUID, TEXT, INTEGER\s*\)\s*FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready/
        );
    });

    it('wires the new predicate into the NOT_READY gate as an additive bypass only', () => {
        const load = functionDefinition('load_analysis_v2_profile_fetch_for_consumer');
        expect(load).toMatch(
            /pg_catalog\.cardinality\(v_batch\.frozen_unresolved_usernames\) > 0\s*\n\s*AND v_batch\.fallback_completed_at IS NULL\s*\n\s*AND NOT public\.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready\(\s*\n\s*p_request_id,\s*\n\s*p_producer_job_key,\s*\n\s*p_expected_item_count\s*\n\s*\)/
        );
        expect(load).toContain("MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'");
    });

    it('keeps every other consumer line byte-for-byte identical to the prior migration', () => {
        const load = functionDefinition('load_analysis_v2_profile_fetch_for_consumer');
        const priorLoad = functionDefinition(
            'load_analysis_v2_profile_fetch_for_consumer',
            priorConsumerMigration
        );
        const stripBypass = (source: string): string =>
            source
                .replace(
                    /\s*AND NOT public\.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready\(\s*p_request_id,\s*p_producer_job_key,\s*p_expected_item_count\s*\)/,
                    ''
                )
                .replace(/\s+/g, ' ')
                .trim();
        expect(stripBypass(load)).toBe(stripBypass(priorLoad));
    });

    it('preserves the fence check, scope rules, and returned snapshot call unchanged', () => {
        const load = functionDefinition('load_analysis_v2_profile_fetch_for_consumer');
        expect(load).toContain(
            'public.analysis_v2_assert_result_job_fence('
        );
        expect(load).toContain("MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH'");
        expect(load).toContain("p_producer_job_key LIKE 'track:profiles:batch:%'");
        expect(load).toContain(
            "p_producer_job_key = 'track:target-evidence:collect'"
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
        expect(load).toContain(
            'RETURN public.analysis_v2_profile_checkpoint_snapshot(\n' +
                '        p_request_id,\n' +
                '        p_producer_job_key\n' +
                '    );'
        );
    });

    it('preserves the service-only execution boundary for the consumer RPC', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_profile_fetch_for_consumer\(\s*UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER\s*\)\s*FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_profile_fetch_for_consumer\(\s*UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER\s*\)\s*TO service_role;/
        );
    });
});
