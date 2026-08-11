import { describe, expect, it, vi } from 'vitest';
import {
    RevenueCostAiAttemptCostDeniedError,
    createRevenueCostAiAttemptLifecycle,
} from './revenue-cost-ai-attempt-lifecycle';
import type {
    RevenueCostLiveSource,
    RevenueCostOperationOutcome,
} from './revenue-cost-operation-store';

const source: RevenueCostLiveSource = {
    requestId: '11111111-1111-4111-8111-111111111111',
    jobKey: 'track:relationships:collect',
    jobClaimToken: '33333333-3333-4333-8333-333333333333',
    jobInputHash: 'b'.repeat(64),
    sourceKind: 'ai_attempt',
    sourceOperationKey: `gender-triage:${'c'.repeat(64)}`,
    sourceAttempt: 1,
};

function outcome(disposition: RevenueCostOperationOutcome['disposition']): RevenueCostOperationOutcome {
    return {
        disposition,
        created: disposition !== 'accepted',
        replayed: disposition === 'accepted',
    };
}

function store() {
    return {
        reserveV2: vi.fn().mockResolvedValue(outcome('accepted')),
        markStartedV2: vi.fn().mockResolvedValue(outcome('started')),
        settleV2: vi.fn().mockResolvedValue(outcome('settled')),
        releaseV2: vi.fn().mockResolvedValue(outcome('released')),
    };
}

describe('RevenueCostAiAttemptLifecycle', () => {
    it('reserves and marks durable AI cost before entering the external boundary', async () => {
        const operations = store();
        const calls: string[] = [];
        operations.reserveV2.mockImplementation(async () => {
            calls.push('reserve');
            return outcome('accepted');
        });
        operations.markStartedV2.mockImplementation(async () => {
            calls.push('started');
            return outcome('started');
        });
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);

        const result = await lifecycle.runMarked({
            scope: { accessMode: 'test_entitlement', planId: 'basic' },
            source,
            runExternal: async () => {
                calls.push('external');
                return 'provider-result';
            },
        });

        expect(result).toBe('provider-result');
        expect(operations.reserveV2).toHaveBeenCalledWith(source);
        expect(operations.markStartedV2).toHaveBeenCalledWith(source);
        expect(calls).toEqual(['reserve', 'started', 'external']);
    });

    it('denies dispatch before the external boundary when the authoritative reserve denies', async () => {
        const operations = store();
        operations.reserveV2.mockResolvedValue(outcome('denied'));
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
        const runExternal = vi.fn().mockResolvedValue('should-not-run');

        await expect(lifecycle.runMarked({
            scope: { accessMode: 'test_entitlement', planId: 'standard' },
            source,
            runExternal,
        })).rejects.toBeInstanceOf(RevenueCostAiAttemptCostDeniedError);

        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(runExternal).not.toHaveBeenCalled();
    });

    it('fails closed before every revenue RPC when a non-AI source reaches the AI adapter', async () => {
        const operations = store();
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
        const runExternal = vi.fn().mockResolvedValue('should-not-run');

        await expect(lifecycle.runMarked({
            scope: { accessMode: 'test_entitlement', planId: 'basic' },
            source: {
                ...source,
                sourceKind: 'provider_run',
                sourceOperationKey: `relationship-followers:${'d'.repeat(64)}`,
                sourceAttempt: 0,
            },
            runExternal,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_LIFECYCLE_ERROR');

        expect(operations.reserveV2).not.toHaveBeenCalled();
        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(operations.releaseV2).not.toHaveBeenCalled();
        expect(runExternal).not.toHaveBeenCalled();
    });

    it('runs ordinary production and Plus attempts without new revenue RPCs', async () => {
        const operations = store();
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
        const productionRun = vi.fn().mockResolvedValue('production');
        const plusRun = vi.fn().mockResolvedValue('plus');

        await expect(lifecycle.runMarked({
            scope: { accessMode: 'production', planId: 'basic' },
            source,
            runExternal: productionRun,
        })).resolves.toBe('production');
        await expect(lifecycle.runMarked({
            scope: { accessMode: 'test_entitlement', planId: 'plus' },
            source,
            runExternal: plusRun,
        })).resolves.toBe('plus');

        expect(productionRun).toHaveBeenCalledOnce();
        expect(plusRun).toHaveBeenCalledOnce();
        expect(operations.reserveV2).not.toHaveBeenCalled();
        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(operations.settleV2).not.toHaveBeenCalled();
        expect(operations.releaseV2).not.toHaveBeenCalled();
    });

    it('delegates only covered test-entitlement terminals to authoritative settlement and release', async () => {
        const operations = store();
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
        const scope = { accessMode: 'test_entitlement' as const, planId: 'basic' as const };

        await expect(lifecycle.settleAfterTerminal({ scope, source })).resolves.toMatchObject({
            disposition: 'settled',
        });
        await expect(lifecycle.releaseOrAmbiguousBeforeDispatch({ scope, source })).resolves.toMatchObject({
            disposition: 'released',
        });
        await expect(lifecycle.settleAfterTerminal({
            scope: { accessMode: 'production', planId: 'basic' }, source,
        })).resolves.toBeNull();

        expect(operations.settleV2).toHaveBeenCalledWith({
            requestId: source.requestId,
            jobKey: source.jobKey,
            sourceKind: source.sourceKind,
            sourceOperationKey: source.sourceOperationKey,
            sourceAttempt: source.sourceAttempt,
        });
        expect(operations.releaseV2).toHaveBeenCalledWith(source);
    });

    it('does not cross the external boundary when a start response is lost', async () => {
        const operations = store();
        const calls: string[] = [];
        operations.reserveV2.mockImplementation(async () => {
            calls.push('reserve');
            return outcome('accepted');
        });
        operations.markStartedV2.mockImplementation(async () => {
            calls.push('started');
            throw new Error('REVENUE_COST_OPERATION_RPC_FAILED');
        });
        operations.releaseV2.mockImplementation(async () => {
            calls.push('release');
            return outcome('ambiguous');
        });
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
        const runExternal = vi.fn().mockResolvedValue('should-not-run');

        await expect(lifecycle.runMarked({
            scope: { accessMode: 'test_entitlement', planId: 'standard' },
            source,
            runExternal,
        })).rejects.toThrow('REVENUE_COST_OPERATION_RPC_FAILED');

        expect(calls).toEqual(['reserve', 'started', 'release']);
        expect(runExternal).not.toHaveBeenCalled();
    });
});
