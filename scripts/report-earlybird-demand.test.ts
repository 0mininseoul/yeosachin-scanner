import { describe, expect, it, vi } from 'vitest';
import {
    parseEarlybirdDemandCliArgs,
    runEarlybirdDemandReportCli,
    type EarlybirdDemandCliDependencies,
} from './report-earlybird-demand';
import type { EarlybirdDemandSummary } from '../lib/services/earlybird/demand-report';

function summary(
    overrides: Partial<EarlybirdDemandSummary> = {}
): EarlybirdDemandSummary {
    return {
        startDate: '2026-07-24',
        endDateExclusive: '2026-08-01',
        referenceConfirmedPaymentCount: 2,
        referenceConfirmedGrossKrw: 34_800,
        unconfirmedPaidOrderCount: 0,
        refundLiabilityCount: 0,
        overdueFulfillmentCount: 0,
        pendingCheckoutCount: 1,
        plusWaitlistCount: 3,
        plans: [
            {
                planId: 'basic',
                confirmedPaymentCount: 1,
                confirmedGrossKrw: 14_900,
                remainingSlots: 9,
            },
            {
                planId: 'standard',
                confirmedPaymentCount: 1,
                confirmedGrossKrw: 19_900,
                remainingSlots: 9,
            },
        ],
        ...overrides,
    };
}

describe('earlybird demand report CLI', () => {
    it('requires one start and end date and rejects every other option', () => {
        expect(parseEarlybirdDemandCliArgs([
            '--start', '2026-07-24',
            '--end', '2026-08-01',
        ])).toEqual({
            startDate: '2026-07-24',
            endDateExclusive: '2026-08-01',
        });
        expect(() => parseEarlybirdDemandCliArgs([
            '--start', '2026-07-24',
            '--start', '2026-07-25',
            '--end', '2026-08-01',
        ])).toThrow('exactly once');
        expect(() => parseEarlybirdDemandCliArgs([
            '--start=2026-07-24',
            '--end', '2026-08-01',
        ])).toThrow('unknown argument');
        expect(() => parseEarlybirdDemandCliArgs([
            '--start', '2026-07-24',
            '--end', '2026-08-01',
            '--target', 'private-target',
        ])).toThrow('unknown argument');
    });

    it('prints stable aggregate JSON and returns zero for a review-clean report', async () => {
        const writeStdout = vi.fn();
        const loadSummary = vi.fn(async () => summary());
        const result = await runEarlybirdDemandReportCli([
            '--start', '2026-07-24',
            '--end', '2026-08-01',
        ], { loadSummary, writeStdout });

        expect(result.exitCode).toBe(0);
        expect(loadSummary).toHaveBeenCalledWith({
            startDate: '2026-07-24',
            endDateExclusive: '2026-08-01',
        });
        expect(writeStdout).toHaveBeenCalledWith(
            `${JSON.stringify(summary(), null, 2)}\n`
        );
    });

    it.each([
        { unconfirmedPaidOrderCount: 1 },
        { refundLiabilityCount: 1 },
        { overdueFulfillmentCount: 1 },
    ])('returns nonzero when operator review is required', async overrides => {
        const dependencies: EarlybirdDemandCliDependencies = {
            loadSummary: async () => summary(overrides),
            writeStdout: vi.fn(),
        };
        const result = await runEarlybirdDemandReportCli([
            '--start', '2026-07-24',
            '--end', '2026-08-01',
        ], dependencies);
        expect(result.exitCode).toBe(1);
    });

    it('refuses identifier-bearing data before writing stdout', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdDemandReportCli([
            '--start', '2026-07-24',
            '--end', '2026-08-01',
        ], {
            loadSummary: async () => ({
                ...summary(),
                buyerEmail: 'sensitive@example.com',
            } as EarlybirdDemandSummary),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });
});
