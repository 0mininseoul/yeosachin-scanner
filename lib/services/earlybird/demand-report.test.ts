import { describe, expect, it, vi } from 'vitest';
import {
    earlybirdDemandSummarySchema,
    loadEarlybirdDemandSummary,
    parseEarlybirdDemandRange,
    type EarlybirdDemandReportDependencies,
} from '@/lib/services/earlybird/demand-report';

function summary() {
    return {
        startDate: '2026-07-24',
        endDateExclusive: '2026-08-01',
        referenceConfirmedPaymentCount: 3,
        referenceConfirmedGrossKrw: 44_700,
        unconfirmedPaidOrderCount: 0,
        refundLiabilityCount: 1,
        overdueFulfillmentCount: 0,
        pendingCheckoutCount: 2,
        plusWaitlistCount: 4,
        plans: [
            {
                planId: 'basic',
                confirmedPaymentCount: 2,
                confirmedGrossKrw: 29_800,
                remainingSlots: 8,
            },
            {
                planId: 'standard',
                confirmedPaymentCount: 1,
                confirmedGrossKrw: 14_900,
                remainingSlots: 9,
            },
        ],
    };
}

describe('earlybird demand report schema', () => {
    it('accepts only the bounded aggregate shape', () => {
        expect(earlybirdDemandSummarySchema.parse(summary())).toEqual(summary());
        expect(earlybirdDemandSummarySchema.safeParse({
            ...summary(),
            plans: [...summary().plans, {
                planId: 'plus',
                confirmedPaymentCount: 1,
                confirmedGrossKrw: 1,
                remainingSlots: 1,
            }],
        }).success).toBe(false);
    });

    it.each([
        'username',
        'buyerEmail',
        'buyerPhone',
        'orderId',
        'paymentId',
        'webhookId',
        'sellerReference',
        'provider',
    ])('rejects the identifier field %s', field => {
        expect(earlybirdDemandSummarySchema.safeParse({
            ...summary(),
            [field]: 'sensitive-value',
        }).success).toBe(false);
        expect(earlybirdDemandSummarySchema.safeParse({
            ...summary(),
            plans: summary().plans.map((plan, index) => (
                index === 0 ? { ...plan, [field]: 'sensitive-value' } : plan
            )),
        }).success).toBe(false);
    });

    it('rejects negative, fractional, unsafe, and unknown metrics', () => {
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(earlybirdDemandSummarySchema.safeParse({
                ...summary(),
                referenceConfirmedPaymentCount: value,
            }).success).toBe(false);
        }
        expect(earlybirdDemandSummarySchema.safeParse({
            ...summary(),
            experimentalMetric: 1,
        }).success).toBe(false);
    });
});

describe('earlybird demand report loader', () => {
    it('validates a one-to-ninety-day half-open range', () => {
        expect(parseEarlybirdDemandRange({
            startDate: '2026-07-24',
            endDateExclusive: '2026-10-22',
        })).toEqual({
            startDate: '2026-07-24',
            endDateExclusive: '2026-10-22',
        });
        for (const range of [
            { startDate: '2026-02-30', endDateExclusive: '2026-03-02' },
            { startDate: '2026-07-24', endDateExclusive: '2026-07-24' },
            { startDate: '2026-07-24', endDateExclusive: '2026-10-23' },
            {
                startDate: '2026-07-24',
                endDateExclusive: '2026-08-01',
                username: 'must-not-pass',
            },
        ]) {
            expect(() => parseEarlybirdDemandRange(range))
                .toThrow('EARLYBIRD_DEMAND_RANGE_INVALID');
        }
    });

    it('calls only the aggregate RPC and validates matching report dates', async () => {
        const rpc = vi.fn(async () => ({ data: summary(), error: null }));
        const result = await loadEarlybirdDemandSummary({
            startDate: '2026-07-24',
            endDateExclusive: '2026-08-01',
        }, { rpc } as EarlybirdDemandReportDependencies);

        expect(rpc).toHaveBeenCalledOnce();
        expect(rpc).toHaveBeenCalledWith('load_earlybird_demand_summary', {
            p_start_date: '2026-07-24',
            p_end_date_exclusive: '2026-08-01',
        });
        expect(result).toEqual(summary());
    });

    it('fails closed without surfacing database details or malformed data', async () => {
        await expect(loadEarlybirdDemandSummary({
            startDate: '2026-07-24',
            endDateExclusive: '2026-08-01',
        }, {
            rpc: async () => ({
                data: null,
                error: { message: 'buyer@example.com ord.secret' },
            }),
        })).rejects.toThrow('EARLYBIRD_DEMAND_REPORT_FAILED');

        await expect(loadEarlybirdDemandSummary({
            startDate: '2026-07-24',
            endDateExclusive: '2026-08-01',
        }, {
            rpc: async () => ({
                data: { ...summary(), username: 'private-target' },
                error: null,
            }),
        })).rejects.toThrow('EARLYBIRD_DEMAND_REPORT_INVALID');
    });
});
