import { describe, expect, it, vi } from 'vitest';
import type { StoredAnalysisV2ProviderRun } from './v2-provider-run-store';
import {
    createRevenueCostProviderRunSettlement,
    type RevenueCostProviderRunSettlementClient,
} from './revenue-cost-provider-run-reconciliation';

const requestId = '11111111-1111-4111-8111-111111111111';
const operationKey = `relationship-followers:${'a'.repeat(64)}`;

function reconciledRun(): StoredAnalysisV2ProviderRun {
    return {
        requestId,
        jobKey: 'track:relationships:collect',
        operationKey,
        inputHash: 'b'.repeat(64),
        reservationToken: '22222222-2222-4222-8222-222222222222',
        logicalProvider: 'apify',
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: 'primary',
        maxChargeUsd: 0.02,
        status: 'succeeded',
        runId: 'RunAbcd1234567890',
        actualUsageUsd: 0.01,
        reservedAt: '2026-08-11T00:00:00.000Z',
        runStartedAt: '2026-08-11T00:00:01.000Z',
        terminalizedAt: '2026-08-11T00:00:02.000Z',
        usageReconciledAt: '2026-08-11T00:00:03.000Z',
    };
}

function rejectedRun(): StoredAnalysisV2ProviderRun {
    return {
        ...reconciledRun(),
        status: 'rejected',
        runId: null,
        actualUsageUsd: 0,
        runStartedAt: null,
    };
}

function clientWithChild(status: string | null) {
    const rpc = vi.fn();
    const maybeSingle = vi.fn(async () => ({
        data: status === null ? null : { status },
        error: null,
    }));
    const eq = vi.fn(() => ({ eq, maybeSingle }));
    const select = vi.fn(() => ({ eq, maybeSingle }));
    const from = vi.fn(() => ({ select }));
    return {
        rpc,
        from,
        client: { rpc, from } as unknown as RevenueCostProviderRunSettlementClient,
    };
}

describe('revenue cost provider-run reconciliation settlement', () => {
    it('settles only an exact opted-in provider child after authoritative usage, without a caller dollar amount', async () => {
        const fixture = clientWithChild('started');
        fixture.rpc.mockResolvedValue({
            data: { disposition: 'settled', created: true, replayed: false },
            error: null,
        });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        }))
            .resolves.toBeUndefined();

        expect(fixture.rpc).toHaveBeenCalledWith(
            'settle_analysis_revenue_cost_operation_v2',
            {
                p_request_id: requestId,
                p_job_key: 'track:relationships:collect',
                p_source_kind: 'provider_run',
                p_source_operation_key: operationKey,
                p_source_attempt: 0,
            }
        );
    });

    it('leaves an ordinary production provider run unchanged when no opted-in child exists', async () => {
        const fixture = clientWithChild(null);
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun()))
            .resolves.toBeUndefined();

        expect(fixture.from).not.toHaveBeenCalled();
        expect(fixture.rpc).not.toHaveBeenCalled();
    });

    it('fails closed when a released child conflicts with an incurred provider run', async () => {
        const fixture = clientWithChild('released');
        fixture.rpc
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'REVENUE_COST_OPERATION_FENCE' },
            })
            .mockResolvedValueOnce({
                data: { disposition: 'manual_review', created: false, replayed: false },
                error: null,
            });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        expect(fixture.rpc.mock.calls.map(([name]) => name)).toEqual([
            'settle_analysis_revenue_cost_operation_v2',
            'mark_analysis_revenue_manual_review_v1',
        ]);
    });

    it('fails closed when a settled child conflicts with a rejected provider run', async () => {
        const fixture = clientWithChild('settled');
        fixture.rpc
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'REVENUE_COST_OPERATION_FENCE' },
            })
            .mockResolvedValueOnce({
                data: { disposition: 'manual_review', created: false, replayed: false },
                error: null,
            });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(rejectedRun(), {
            knownRevenueCostOperation: true,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        expect(fixture.rpc.mock.calls.map(([name]) => name)).toEqual([
            'settle_analysis_revenue_cost_operation_v2',
            'mark_analysis_revenue_manual_review_v1',
        ]);
    });

    it('fails closed when a denied child appears after the trusted queue marker', async () => {
        const fixture = clientWithChild('denied');
        fixture.rpc
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'REVENUE_COST_OPERATION_FENCE' },
            })
            .mockResolvedValueOnce({
                data: { disposition: 'manual_review', created: false, replayed: false },
                error: null,
            });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        expect(fixture.rpc.mock.calls.map(([name]) => name)).toEqual([
            'settle_analysis_revenue_cost_operation_v2',
            'mark_analysis_revenue_manual_review_v1',
        ]);
    });

    it('replays an exact released child through SQL for a rejected provider run', async () => {
        const fixture = clientWithChild('released');
        fixture.rpc.mockResolvedValue({
            data: { disposition: 'released', created: false, replayed: true },
            error: null,
        });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(rejectedRun(), {
            knownRevenueCostOperation: true,
        })).resolves.toBeUndefined();

        expect(fixture.rpc).toHaveBeenCalledWith(
            'settle_analysis_revenue_cost_operation_v2',
            {
                p_request_id: requestId,
                p_job_key: 'track:relationships:collect',
                p_source_kind: 'provider_run',
                p_source_operation_key: operationKey,
                p_source_attempt: 0,
            }
        );
    });

    it('replays an exact settled child through SQL for an incurred provider run', async () => {
        const fixture = clientWithChild('settled');
        fixture.rpc.mockResolvedValue({
            data: { disposition: 'settled', created: false, replayed: true },
            error: null,
        });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        })).resolves.toBeUndefined();

        expect(fixture.rpc).toHaveBeenCalledWith(
            'settle_analysis_revenue_cost_operation_v2',
            {
                p_request_id: requestId,
                p_job_key: 'track:relationships:collect',
                p_source_kind: 'provider_run',
                p_source_operation_key: operationKey,
                p_source_attempt: 0,
            }
        );
    });

    it('fails closed to manual review if an opted-in child cannot settle after reconciliation', async () => {
        const fixture = clientWithChild('started');
        fixture.rpc
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'REVENUE_COST_OPERATION_FENCE' },
            })
            .mockResolvedValueOnce({
                data: { disposition: 'manual_review', created: false, replayed: false },
                error: null,
            });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        }))
            .rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        expect(fixture.rpc.mock.calls.map(([name]) => name)).toEqual([
            'settle_analysis_revenue_cost_operation_v2',
            'mark_analysis_revenue_manual_review_v1',
        ]);
    });

    it('fails closed to manual review when an exact trusted-child lookup fails', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: { disposition: 'manual_review', created: false, replayed: false },
            error: null,
        });
        const maybeSingle = vi.fn(async () => ({
            data: null,
            error: { code: 'PGRST000', message: 'network unavailable' },
        }));
        const eq = vi.fn(() => ({ eq, maybeSingle }));
        const select = vi.fn(() => ({ eq, maybeSingle }));
        const from = vi.fn(() => ({ select }));
        const settlement = createRevenueCostProviderRunSettlement(
            { rpc, from } as unknown as RevenueCostProviderRunSettlementClient
        );

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        expect(rpc).toHaveBeenCalledWith(
            'mark_analysis_revenue_manual_review_v1',
            { p_request_id: requestId, p_reason_code: 'ambiguous_external_call' }
        );
    });

    it('fails closed to manual review when a queue-proven exact child disappears before settlement', async () => {
        const fixture = clientWithChild(null);
        fixture.rpc.mockResolvedValue({
            data: { disposition: 'manual_review', created: false, replayed: false },
            error: null,
        });
        const settlement = createRevenueCostProviderRunSettlement(fixture.client);

        await expect(settlement.settleAfterUsageReconciliation(reconciledRun(), {
            knownRevenueCostOperation: true,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        expect(fixture.rpc).toHaveBeenCalledWith(
            'mark_analysis_revenue_manual_review_v1',
            { p_request_id: requestId, p_reason_code: 'ambiguous_external_call' }
        );
    });
});
