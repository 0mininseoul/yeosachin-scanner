import { expect, it } from 'vitest';
import { StandardSharedBudgetEvidence, safeStandardBudgetRpcFields } from './standard-shared-budget-evidence';

const totals = { scope: 'order', limitUsd: '5.0000', settledUsd: 2, staleReservedUsd: 0, freshReservedUsd: 3, requestedUsd: .02 };

it('retains first denial and first downstream failures after the event cap without exporting identities', () => {
    const evidence = new StandardSharedBudgetEvidence();
    const id = 'fixture-sensitive-value';
    const before = { owner: id, delivery: {} };
    const rpc = 'reserve_vertex_ai_budget';
    const pg = { code: 'P0001', message: 'VERTEX_AI_BUDGET_EXCEEDED:order:' + id, hint: 'VERTEX_AI_BUDGET_CAPACITY_PENDING',
        detail: JSON.stringify({ ...totals, arbitraryKey: id }) };
    for (let i = 0; i < 36; i++) evidence.rpc('claim_analysis_v2_scheduler_operation', {},
        { code: 'P0001', message: 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH' }, before);
    evidence.rpc(rpc, {}, { ...pg, ...safeStandardBudgetRpcFields(rpc, pg) }, before);
    evidence.rpc('continue_analysis_v2_scheduler_job', { p_error_code: 'ANALYSIS_V2_AI_CAPACITY_PENDING' }, null, before);
    evidence.rpc('continue_analysis_v2_scheduler_job', {}, { message: 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH' }, { owner: id, delivery: {} });
    evidence.terminalWorkerResponse({ owner: 'unrelated', delivery: {} });
    const report = evidence.receipt();
    expect(report.events).toHaveLength(32);
    expect(report.omittedEvents).toBe(8);
    expect(report.firstByKind.find(x => x.kind === 'budget_denied')).toMatchObject({ sequence: 37,
        sameOwnerAsFirstDenial: true, sameDeliveryAsFirstDenial: true, budget: { scope: 'order',
            capacityPending: true, transactionTotals: { ...totals, limitUsd: 5 } } });
    expect(report.firstAfterDenialByKind).toMatchObject([
        { kind: 'job_capacity_continuation', sequence: 38, sameDeliveryAsFirstDenial: true },
        { kind: 'job_fence_mismatch', sequence: 39, sameOwnerAsFirstDenial: true, sameDeliveryAsFirstDenial: false },
        { kind: 'terminal_worker_response', sequence: 40, sameOwnerAsFirstDenial: false },
    ]);
    expect(JSON.stringify(report)).not.toContain(id);
    expect(safeStandardBudgetRpcFields('unrelated_rpc', pg)).toEqual({});
    expect(safeStandardBudgetRpcFields(rpc, { ...pg, hint: id, detail: JSON.stringify({ ...totals, requestedUsd: id }) })).toEqual({});
});
