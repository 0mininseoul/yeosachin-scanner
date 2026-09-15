import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hardening = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);
const liveCost = readFileSync(
    new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url),
    'utf8',
);

function functionBody(sql: string, name: string): string {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    expect(start, `missing ${name}`).toBeGreaterThanOrEqual(0);
    const next = sql.indexOf('\nCREATE OR REPLACE FUNCTION public.', start + 1);
    return sql.slice(start, next === -1 ? sql.length : next);
}

function lockedRows(body: string): string[] {
    return [...body.matchAll(/SELECT \* INTO v_(preflight|request|job|provider|policy|parent|guard)[\s\S]{0,240}?FOR UPDATE/g)]
        .map(match => match[1]!);
}

function expectSubsequence(actual: readonly string[], expected: readonly string[]): void {
    let cursor = 0;
    for (const value of actual) {
        if (value === expected[cursor]) cursor += 1;
    }
    expect(cursor).toBe(expected.length);
}

describe('fresh provenance deterministic SQL lock-order contract', () => {
    it('keeps fresh admission, record, bind, checkpoint, and replay paths in the live-cost order', () => {
        const admission = functionBody(hardening, 'assert_analysis_revenue_fresh_provider_admission_v1');
        const record = functionBody(hardening, 'record_analysis_revenue_fresh_provider_evidence_v1');
        const bind = functionBody(hardening, 'bind_analysis_revenue_fresh_provider_dataset_v1');
        const checkpoint = functionBody(hardening, 'checkpoint_analysis_v2_profile_fresh_apify_v1');

        expectSubsequence(lockedRows(admission), ['preflight', 'request', 'job', 'provider', 'parent']);
        for (const body of [record, bind]) {
            expect(body).toContain('PERFORM public.assert_analysis_revenue_fresh_provider_admission_v1');
        }
        // record re-reads both source and parent; bind inherits the already
        // held parent lock from admission, then re-reads only its source row.
        expectSubsequence(lockedRows(record), ['provider', 'parent']);
        expectSubsequence(lockedRows(bind), ['provider']);
        expectSubsequence(lockedRows(checkpoint), ['preflight', 'request', 'job', 'provider', 'parent']);
    });

    it('keeps strict activation, quarantine, and every extant live provider-cost RPC compatible', () => {
        for (const name of [
            'assert_analysis_revenue_dispatch_guard_v1',
            'activate_analysis_revenue_dispatch_guard_v1',
            'quarantine_analysis_revenue_dispatch_v1',
        ]) {
            expectSubsequence(lockedRows(functionBody(hardening, name)), [
                'preflight', 'request', 'job', 'policy', 'parent', 'guard',
            ]);
        }
        for (const name of [
            'reserve_analysis_revenue_cost_operation_v2',
            'mark_analysis_revenue_cost_operation_started_v2',
            'settle_analysis_revenue_cost_operation_v2',
            'release_analysis_revenue_cost_operation_v2',
        ]) {
            expectSubsequence(lockedRows(functionBody(liveCost, name)), [
                'preflight', 'request', 'job', 'provider', 'parent',
            ]);
        }
        for (const [name, unfenced] of [
            ['reserve_analysis_v2_job_dispatch', 'reserve_analysis_v2_job_dispatch_unfenced_20260811'],
            ['mark_analysis_v2_job_dispatched', 'mark_analysis_v2_job_dispatched_unfenced_20260811'],
            ['rearm_analysis_v2_job_dispatch', 'rearm_analysis_v2_job_dispatch_unfenced_20260811'],
            ['claim_analysis_v2_job', 'claim_analysis_v2_job_unfenced_20260811'],
            ['continue_analysis_v2_scheduler_job', 'continue_analysis_v2_scheduler_job_unfenced_20260811'],
        ]) {
            const wrapper = functionBody(hardening, name);
            expect(wrapper.indexOf('PERFORM public.assert_analysis_revenue_dispatch_guard_v1'))
                .toBeGreaterThanOrEqual(0);
            expect(wrapper.indexOf(`public.${unfenced}`))
                .toBeGreaterThan(wrapper.indexOf('PERFORM public.assert_analysis_revenue_dispatch_guard_v1'));
        }
        const unfencedRevocations = hardening.slice(
            hardening.indexOf('REVOKE ALL ON FUNCTION public.reserve_analysis_v2_job_dispatch_unfenced_20260811'),
            hardening.indexOf('CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_job_dispatch('),
        );
        for (const unfenced of [
            'reserve_analysis_v2_job_dispatch_unfenced_20260811',
            'mark_analysis_v2_job_dispatched_unfenced_20260811',
            'rearm_analysis_v2_job_dispatch_unfenced_20260811',
            'claim_analysis_v2_job_unfenced_20260811',
            'continue_analysis_v2_scheduler_job_unfenced_20260811',
        ]) expect(unfencedRevocations).toContain(`public.${unfenced}(`);
        expect(unfencedRevocations).toContain('FROM PUBLIC, anon, authenticated, service_role');
        expect(hardening).toContain('ALTER FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID)');
        expect(hardening).not.toContain('CREATE TRIGGER analysis_v2_revenue_dispatch_guard');
    });
});
