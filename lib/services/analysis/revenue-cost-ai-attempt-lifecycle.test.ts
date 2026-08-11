import { describe, expect, it, vi } from 'vitest';
import type {
    AnalyzeWithGeminiOptions,
    GeminiAttemptStartTelemetry,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import {
    RevenueCostAiAttemptCostDeniedError,
    RevenueCostAiAttemptLifecycleError,
    createRevenueCostAiAttemptLifecycle,
} from './revenue-cost-ai-attempt-lifecycle';
import type {
    RevenueCostLiveSource,
    RevenueCostOperationOutcome,
} from './revenue-cost-operation-store';

const fence = {
    requestId: '11111111-1111-4111-8111-111111111111',
    jobKey: 'track:private-names:batch:0',
    jobClaimToken: '33333333-3333-4333-8333-333333333333',
    jobInputHash: 'b'.repeat(64),
    operationKey: `private-account-name:${'c'.repeat(64)}`,
};

const startTelemetry: GeminiAttemptStartTelemetry = {
    requestId: fence.requestId,
    modelName: 'gemini-3.1-flash-lite',
    location: 'global',
    stage: 'privateAccountName',
    thinkingLevel: 'MINIMAL',
    mediaCount: 0,
    mediaResolution: 'LOW',
    promptVersion: 'private-account-name-v1',
    schemaVersion: 1,
    maxOutputTokens: 8192,
    attempt: 1,
    retryCount: 0,
};

const terminalTelemetry: GeminiAttemptTelemetry = {
    ...startTelemetry,
    tokenUsage: null,
    usageComplete: false,
    usageMetadataStatus: 'missing',
    latencyMs: 12,
    estimatedCostUsd: null,
    disposition: 'rate_limited',
    finishReason: null,
};

function sourceForAttempt(attempt: number): RevenueCostLiveSource {
    return {
        requestId: fence.requestId,
        jobKey: fence.jobKey,
        jobClaimToken: fence.jobClaimToken,
        jobInputHash: fence.jobInputHash,
        sourceKind: 'ai_attempt',
        sourceOperationKey: fence.operationKey,
        sourceAttempt: attempt,
    };
}

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
        manualReview: vi.fn().mockResolvedValue(outcome('manual_review')),
    };
}

function callbackHooks() {
    const operations = store();
    const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
    const callbacks = lifecycle.bind({
        scope: { accessMode: 'test_entitlement', planId: 'basic' },
        fence,
    });
    return { callbacks, lifecycle, operations };
}

describe('RevenueCostAiAttemptLifecycle', () => {
    it('binds directly to the existing Gemini callbacks and derives the exact per-attempt source', async () => {
        const { callbacks, lifecycle, operations } = callbackHooks();
        const onBeforeAttempt: NonNullable<AnalyzeWithGeminiOptions<unknown>['onBeforeAttempt']>
            = callbacks.onBeforeAttempt;
        const onAttemptTelemetry: NonNullable<AnalyzeWithGeminiOptions<unknown>['onAttemptTelemetry']>
            = callbacks.onAttemptTelemetry;

        await onBeforeAttempt({ ...startTelemetry, attempt: 2, retryCount: 1 });
        await onAttemptTelemetry({ ...terminalTelemetry, attempt: 2, retryCount: 1 });

        expect('runMarked' in lifecycle).toBe(false);
        expect(operations.reserveV2).toHaveBeenCalledWith(sourceForAttempt(2));
        expect(operations.markStartedV2).toHaveBeenCalledWith(sourceForAttempt(2));
        expect(operations.settleV2).toHaveBeenCalledWith({
            requestId: fence.requestId,
            jobKey: fence.jobKey,
            sourceKind: 'ai_attempt',
            sourceOperationKey: fence.operationKey,
            sourceAttempt: 2,
        });
    });

    it('denies Gemini dispatch before its callback returns when the authoritative reserve denies', async () => {
        const { callbacks, operations } = callbackHooks();
        operations.reserveV2.mockResolvedValue(outcome('denied'));

        await expect(callbacks.onBeforeAttempt(startTelemetry))
            .rejects.toBeInstanceOf(RevenueCostAiAttemptCostDeniedError);

        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(operations.manualReview).not.toHaveBeenCalled();
        expect(operations.releaseV2).not.toHaveBeenCalled();
    });

    it('retries an ambiguous reserve transport response with the same exact identity before Gemini dispatch', async () => {
        const { callbacks, operations } = callbackHooks();
        operations.reserveV2
            .mockRejectedValueOnce(new Error('transport disconnected after commit'))
            .mockResolvedValueOnce(outcome('accepted'));

        await expect(callbacks.onBeforeAttempt(startTelemetry)).resolves.toBeUndefined();

        expect(operations.reserveV2).toHaveBeenCalledTimes(2);
        expect(operations.reserveV2).toHaveBeenNthCalledWith(1, sourceForAttempt(1));
        expect(operations.reserveV2).toHaveBeenNthCalledWith(2, sourceForAttempt(1));
        expect(operations.markStartedV2).toHaveBeenCalledWith(sourceForAttempt(1));
        expect(operations.manualReview).not.toHaveBeenCalled();
        expect(operations.releaseV2).not.toHaveBeenCalled();
    });

    it('fails closed into manual review without release or Gemini dispatch when exact reserve retry stays unresolved', async () => {
        const { callbacks, operations } = callbackHooks();
        operations.reserveV2.mockRejectedValue(new Error('transport disconnected after commit'));

        await expect(callbacks.onBeforeAttempt(startTelemetry))
            .rejects.toBeInstanceOf(RevenueCostAiAttemptLifecycleError);

        expect(operations.reserveV2).toHaveBeenCalledTimes(2);
        expect(operations.reserveV2).toHaveBeenNthCalledWith(1, sourceForAttempt(1));
        expect(operations.reserveV2).toHaveBeenNthCalledWith(2, sourceForAttempt(1));
        expect(operations.manualReview).toHaveBeenCalledWith({
            requestId: fence.requestId,
            reasonCode: 'ambiguous_external_call',
        });
        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(operations.releaseV2).not.toHaveBeenCalled();
    });

    it('does not cross the Gemini callback boundary when a start response is lost', async () => {
        const { callbacks, operations } = callbackHooks();
        operations.markStartedV2.mockRejectedValue(new Error('REVENUE_COST_OPERATION_RPC_FAILED'));

        await expect(callbacks.onBeforeAttempt(startTelemetry))
            .rejects.toThrow('REVENUE_COST_OPERATION_RPC_FAILED');

        expect(operations.reserveV2).toHaveBeenCalledWith(sourceForAttempt(1));
        expect(operations.markStartedV2).toHaveBeenCalledWith(sourceForAttempt(1));
        expect(operations.releaseV2).toHaveBeenCalledWith(sourceForAttempt(1));
    });

    it('keeps proven-no-call release explicit and source-bound', async () => {
        const { callbacks, operations } = callbackHooks();

        await expect(callbacks.releaseBeforeDispatch(startTelemetry)).resolves.toMatchObject({
            disposition: 'released',
        });

        expect(operations.releaseV2).toHaveBeenCalledWith(sourceForAttempt(1));
    });

    it('fails closed before every revenue RPC when callback identity drifts', async () => {
        const { callbacks, operations } = callbackHooks();

        await expect(callbacks.onBeforeAttempt({
            ...startTelemetry,
            requestId: '22222222-2222-4222-8222-222222222222',
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_LIFECYCLE_ERROR');
        await expect(callbacks.onAttemptTelemetry({
            ...terminalTelemetry,
            attempt: 2,
            retryCount: 0,
        })).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_LIFECYCLE_ERROR');

        expect(operations.reserveV2).not.toHaveBeenCalled();
        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(operations.settleV2).not.toHaveBeenCalled();
    });

    it('runs ordinary production and Plus callbacks without any new revenue RPC', async () => {
        const operations = store();
        const lifecycle = createRevenueCostAiAttemptLifecycle(operations);
        const production = lifecycle.bind({
            scope: { accessMode: 'production', planId: 'basic' },
            fence,
        });
        const plus = lifecycle.bind({
            scope: { accessMode: 'test_entitlement', planId: 'plus' },
            fence,
        });

        await production.onBeforeAttempt(startTelemetry);
        await production.onAttemptTelemetry(terminalTelemetry);
        await production.releaseBeforeDispatch(startTelemetry);
        await plus.onBeforeAttempt(startTelemetry);
        await plus.onAttemptTelemetry(terminalTelemetry);
        await plus.releaseBeforeDispatch(startTelemetry);

        expect(operations.reserveV2).not.toHaveBeenCalled();
        expect(operations.markStartedV2).not.toHaveBeenCalled();
        expect(operations.settleV2).not.toHaveBeenCalled();
        expect(operations.releaseV2).not.toHaveBeenCalled();
        expect(operations.manualReview).not.toHaveBeenCalled();
    });
});
