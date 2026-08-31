import { describe, expect, it } from 'vitest';
import {
    assertCapacityExtensionLoadReport,
    runCapacityExtensionLoad,
} from './capacity-extension-load-harness';

describe('automatic-analysis capacity load harness', () => {
    it('drains the approved 400 preflight and 200 paid synthetic burst', async () => {
        const report = await runCapacityExtensionLoad({
            fakeProviderMode: 'load',
            preflightRequests: 400,
            paidRequests: 200,
            preflightConcurrency: 32,
            paidConcurrency: 8,
            geminiConcurrency: 8,
            duplicateDeliveryEvery: 17,
            expireEvery: 19,
        });
        expect(report.accepted).toBe(600);
        expect(report.terminalized).toBe(600);
        expect(report.lost).toBe(0);
        expect(report.duplicateTerminalEffects).toBe(0);
        expect(report.capacityStage).toBe('initial');
        expect(report.workerPreflightConcurrency).toBe(32);
        expect(report.workerPaidConcurrency).toBe(8);
        expect(report.maxPreflightProviderActive).toBe(32);
        expect(report.maxPaidProviderActive).toBe(8);
        expect(report.maxGeminiActive).toBe(8);
        expect(report.capacityPending).toBeGreaterThan(0);
        expect(report.capacityPendingByRole.preflight).toBeGreaterThan(0);
        expect(report.capacityPendingByRole.paid).toBeGreaterThan(0);
        expect(report.capacityPendingByRole.gemini).toBeGreaterThan(0);
        expect(report.recoveredLeases).toBeGreaterThan(0);
        expect(report.fenceRotations).toBeGreaterThan(0);
        expect(report.renewedLeases).toBeGreaterThan(0);
        expect(report.relationshipBudgetMaxActive).toBe(4);
        expect(report.relationshipProviderMaxActive).toBe(4);
        expect(report.relationshipCapacityPendingCount).toBeGreaterThan(0);
        expect(report.relationshipCapacityPending).toBe(true);
        expect(report.relationshipProviderStarts).toBe(4);
        expect(report.taskCreateCalls).toBeGreaterThan(report.accepted);
        expect(report.providerAdmissionWrapperCalls).toBeGreaterThan(0);
        expect(report.fakeProviderCalls).toBe(
            report.providerStarts + report.geminiStarts + report.relationshipProviderStarts,
        );
        expect(report.databaseContentionEvidence).toMatchObject({
            source: 'deterministic-serial-fake',
            transactionCount: expect.any(Number),
            contentionEvents: expect.any(Number),
            maxInFlight: 1,
        });
        expect(report.eventualDrain).toBe(true);
        expect(() => assertCapacityExtensionLoadReport(report)).not.toThrow();
    });

    it('fails closed unless the caller explicitly selects the load mode', async () => {
        await expect(runCapacityExtensionLoad({
            preflightRequests: 1,
            paidRequests: 1,
        })).rejects.toThrow('CAPACITY_LOAD_FAKE_MODE_REQUIRED');
    });

    it('drains the same burst at the staged expanded worker bounds without widening provider ceilings', async () => {
        const report = await runCapacityExtensionLoad({
            fakeProviderMode: 'load',
            preflightRequests: 400,
            paidRequests: 200,
            preflightConcurrency: 64,
            paidConcurrency: 16,
            geminiConcurrency: 8,
            duplicateDeliveryEvery: 17,
            expireEvery: 19,
            capacityStage: 'expanded',
        });
        expect(report.accepted).toBe(600);
        expect(report.terminalized).toBe(600);
        expect(report.lost).toBe(0);
        expect(report.duplicateTerminalEffects).toBe(0);
        expect(report.capacityStage).toBe('expanded');
        expect(report.workerPreflightConcurrency).toBe(64);
        expect(report.workerPaidConcurrency).toBe(16);
        expect(report.maxPreflightProviderActive).toBe(32);
        expect(report.maxPaidProviderActive).toBe(8);
        expect(report.maxGeminiActive).toBe(8);
        expect(report.capacityPending).toBeGreaterThan(0);
        expect(report.capacityPendingByRole.preflight).toBeGreaterThan(0);
        expect(report.capacityPendingByRole.paid).toBeGreaterThan(0);
        expect(report.capacityPendingByRole.gemini).toBeGreaterThan(0);
        expect(report.recoveredLeases).toBeGreaterThan(0);
        expect(report.fenceRotations).toBeGreaterThan(0);
        expect(report.renewedLeases).toBeGreaterThan(0);
        expect(report.relationshipBudgetMaxActive).toBe(4);
        expect(report.relationshipProviderMaxActive).toBe(4);
        expect(report.relationshipCapacityPendingCount).toBeGreaterThan(0);
        expect(report.relationshipCapacityPending).toBe(true);
        expect(report.databaseContentionEvidence.source).toBe('deterministic-serial-fake');
        expect(report.databaseContentionEvidence.maxInFlight).toBe(1);
        expect(report.eventualDrain).toBe(true);
        expect(() => assertCapacityExtensionLoadReport(report)).not.toThrow();
    });

    it('fails the executable release proof when an exact ceiling is not observed', async () => {
        const report = await runCapacityExtensionLoad({
            fakeProviderMode: 'load',
            preflightRequests: 400,
            paidRequests: 200,
            preflightConcurrency: 32,
            paidConcurrency: 8,
            geminiConcurrency: 8,
        });
        expect(() => assertCapacityExtensionLoadReport({
            ...report,
            maxPaidProviderActive: 7,
        })).toThrow('CAPACITY_LOAD_ASSERTION_FAILED:maxPaidProviderActive');
    });

    it('rejects fabricated wrapper/provider evidence even when the totals drain', async () => {
        const report = await runCapacityExtensionLoad({
            fakeProviderMode: 'load',
            preflightRequests: 400,
            paidRequests: 200,
            preflightConcurrency: 32,
            paidConcurrency: 8,
            geminiConcurrency: 8,
        });
        expect(() => assertCapacityExtensionLoadReport({
            ...report,
            fakeProviderCalls: 0,
        })).toThrow('CAPACITY_LOAD_ASSERTION_FAILED:fakeProviderCalls');
        expect(() => assertCapacityExtensionLoadReport({
            ...report,
            relationshipProviderMaxActive: report.relationshipBudgetMaxActive,
            relationshipProviderStarts: 0,
            fakeProviderCalls: report.fakeProviderCalls - report.relationshipProviderStarts,
        })).toThrow('CAPACITY_LOAD_ASSERTION_FAILED:relationshipProviderStarts');
        expect(() => assertCapacityExtensionLoadReport({
            ...report,
            databaseContentionEvidence: {
                ...report.databaseContentionEvidence,
                source: 'deterministic-serial-fake',
                transactionCount: 0,
            },
        })).toThrow('CAPACITY_LOAD_ASSERTION_FAILED:databaseContentionEvidence.transactionCount');
    });
});
