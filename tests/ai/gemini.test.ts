import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { vertexDispatchFetch } from '@/lib/services/ai/vertex-dispatch-window';
import devRegistry from '@/config/dev-ui-deployment.json';
import { ApiError } from '@google/genai';
import { z, type ZodType } from 'zod';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import {
    createAnalysisV2AiAttemptStore,
    createAnalysisV2AiOperationKey,
} from '@/lib/services/analysis/v2-ai-attempt-store';

const mocks = vi.hoisted(() => ({
    generateContent: vi.fn(),
    prepareGoogleApplicationCredentials: vi.fn(),
    tokenUsageInsert: vi.fn(),
    requireDevApproval: vi.fn(),
    reserveDevAttempt: vi.fn(),
    rpc: vi.fn(),
    settleDevAttempt: vi.fn(),
}));

vi.mock('@google/genai/node', async (importOriginal) => ({
    ...await importOriginal<typeof import('@google/genai')>(),
    GoogleGenAI: class {
        constructor(options: { fetch: typeof fetch }) {
            if (!options.fetch) throw new Error('missing test transport');
        }
        models = { generateContent: mocks.generateContent };
    },
    ThinkingLevel: {
        MINIMAL: 'minimal',
        LOW: 'low',
        MEDIUM: 'medium',
        HIGH: 'high',
    },
}));

vi.mock('@/lib/services/google/credentials', () => ({
    prepareGoogleApplicationCredentials: mocks.prepareGoogleApplicationCredentials,
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: {
        rpc: mocks.rpc,
        from: vi.fn(() => ({ insert: mocks.tokenUsageInsert })),
    },
}));

vi.mock('@/lib/services/dev-ui/live-budget', () => ({
    DEV_LIVE_BUDGET_UNAVAILABLE: 'DEV_LIVE_BUDGET_UNAVAILABLE',
    DEV_LIVE_BUDGET_EXCEEDED: 'DEV_LIVE_BUDGET_EXCEEDED',
    requireDevLiveProviderApproval: mocks.requireDevApproval,
    reserveDevLiveVertexAttempt: mocks.reserveDevAttempt,
    settleDevLiveVertexAttempt: mocks.settleDevAttempt,
}));

import {
    analyzeWithGemini,
    GeminiPreDispatchAdmissionError,
    zodToGeminiResponseJsonSchema,
} from '../../lib/services/ai/gemini';
import {
    appearanceAnalysisResponseSchema,
    combinedAnalysisResponseSchema,
    exposureAnalysisResponseSchema,
    genderAnalysisResponseSchema,
    intimacyAnalysisResponseSchema,
    photogenicAnalysisResponseSchema,
} from '../../lib/services/ai/analysis-response-schemas';
import { deepRiskNarrativeResponseSchema } from '../../lib/services/ai/deep-risk-analysis';
import { createPrivateNameBatchResponseSchema } from '../../lib/services/ai/private-name-analysis';
import { AI_STAGE_POLICY_V212_VERSION } from '../../lib/services/ai/stage-policy';
import type { VertexAiBudgetGuard } from '../../lib/services/ai/vertex-ai-cost-policy';

const responseSchema = z.object({ value: z.string() }).strict();
const stageRequestId = '11111111-1111-4111-8111-111111111111';

function stageAuditOptions() {
    return {
        requestId: stageRequestId,
        onBeforeAttempt: vi.fn().mockResolvedValue(undefined),
        onAttemptTelemetry: vi.fn().mockResolvedValue(undefined),
    };
}

function responseWithText(
    text: string,
    usageMetadata: Record<string, unknown> | null = {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        thoughtsTokenCount: 0,
    }
) {
    return {
        text,
        candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text }] },
        }],
        ...(usageMetadata === null ? {} : { usageMetadata }),
    };
}

function successfulResponse() {
    return responseWithText(JSON.stringify({ value: 'ok' }));
}

function analyze(
    onTelemetry?: ReturnType<typeof vi.fn>,
    onAttemptTelemetry?: ReturnType<typeof vi.fn>
) {
    return analyzeWithGemini('prompt', undefined, {
        schema: responseSchema,
        analysisType: 'cost_guard_test',
        skipTokenLog: true,
        onTelemetry,
        onAttemptTelemetry,
    });
}

describe('analyzeWithGemini generation retry policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settleDevAttempt.mockReset().mockResolvedValue(undefined);
        mocks.tokenUsageInsert.mockResolvedValue({ error: null });
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'false');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('refuses a staged Dev attempt before acquiring audit or provider leases when the budget is exhausted', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const audit = stageAuditOptions();
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockRejectedValueOnce(new Error('DEV_LIVE_BUDGET_EXCEEDED'));

        await expect(analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema,
            model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
        })).rejects.toThrow('DEV_LIVE_BUDGET_EXCEEDED');
        expect(mocks.reserveDevAttempt).toHaveBeenCalledExactlyOnceWith(grant, expect.objectContaining({
            model: 'gemini-3.1-flash-lite',
            config: expect.objectContaining({ maxOutputTokens: 128 }),
        }), 'global');
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
        expect(audit.onAttemptTelemetry).not.toHaveBeenCalled();
        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(mocks.settleDevAttempt).not.toHaveBeenCalled();

        const reservation = { grantId: grant.id, reservationId: 'another-reservation' };
        mocks.reserveDevAttempt.mockResolvedValueOnce(reservation);
        mocks.generateContent.mockResolvedValueOnce(successfulResponse());
        await expect(analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema,
            model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
        })).resolves.toEqual({ value: 'ok' });
        expect(audit.onBeforeAttempt).toHaveBeenCalledOnce();
        expect(mocks.generateContent).toHaveBeenCalledOnce();
    });

    const rollback = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const canceled = { data: null, error: { code: '57014', message: 'canceling statement due to user request' } };
    const deadlock = { data: null, error: { code: '40P01', message: 'deadlock detected' } };
    const committed = { data: true, error: null };
    it.each([
        { scenario: 'confirmed rollback then success', replies: [rollback, committed], successful: true },
        { scenario: 'two confirmed rollbacks', replies: [rollback, rollback], successful: false },
        { scenario: 'unknown commit after connection loss', replies: [new Error('connection lost')], successful: false },
        { scenario: 'operator cancellation', replies: [canceled], successful: false },
        { scenario: 'deadlock', replies: [deadlock], successful: false },
    ])('replays only the budget transaction: $scenario', async ({ replies, successful }) => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${devRegistry.deployments[0].supabaseProjectRef}.supabase.co`);
        const budget = await vi.importActual<typeof import('@/lib/services/dev-ui/live-budget')>(
            '@/lib/services/dev-ui/live-budget',
        );
        mocks.requireDevApproval.mockReturnValue({
            id: 'synthetic-approval', approvedAt: '2026-01-01T00:00:00Z', expiresAt: null,
            apifyMaxCents: 600, aiMaxCents: 1800,
        });
        mocks.reserveDevAttempt.mockImplementationOnce(budget.reserveDevLiveVertexAttempt);
        mocks.rpc.mockReset();
        for (const reply of replies) {
            if (reply instanceof Error) mocks.rpc.mockRejectedValueOnce(reply);
            else mocks.rpc.mockResolvedValueOnce(reply);
        }
        const audit = stageAuditOptions();
        if (successful) mocks.generateContent.mockResolvedValueOnce(successfulResponse());
        const response = analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema, model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
        });
        if (successful) await expect(response).resolves.toEqual({ value: 'ok' });
        else await expect(response).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        expect(mocks.rpc).toHaveBeenCalledTimes(replies.length);
        expect(mocks.rpc.mock.calls[0]).toEqual(['dev_live_budget_reserve_v1', expect.objectContaining({
            p_reservation_id: expect.any(String), p_provider: 'vertex',
        })]);
        if (replies.length === 2) expect(mocks.rpc.mock.calls[1]).toEqual(mocks.rpc.mock.calls[0]);
        expect(audit.onBeforeAttempt).toHaveBeenCalledTimes(successful ? 1 : 0);
        expect(mocks.generateContent).toHaveBeenCalledTimes(successful ? 1 : 0);
        expect(mocks.settleDevAttempt).toHaveBeenCalledTimes(successful ? 1 : 0);
    });

    it.each(['audit', 'SDK authentication'])('rejects a worker suspended during %s and returns its unused reservation once', async suspension => {
        vi.useFakeTimers();
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const reservation = { grantId: 'synthetic', reservationId: 'synthetic-reservation' };
        mocks.requireDevApproval.mockReturnValue({ id: 'synthetic' });
        mocks.reserveDevAttempt.mockResolvedValueOnce(reservation);
        const audit = stageAuditOptions();
        // Move wall time without running timers or aborting the signal.
        const stall = () => vi.setSystemTime(Date.now() + 300_000);
        if (suspension === 'audit') audit.onBeforeAttempt.mockImplementationOnce(async () => { stall(); });
        else mocks.generateContent.mockImplementationOnce(async () => {
            stall();
            return vertexDispatchFetch('https://vertex.invalid');
        });
        await expect(analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema, abortSignal: new AbortController().signal,
            model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
        })).rejects.toThrow('ANALYSIS_V2_AI_PREDISPATCH_REJECTED');
        expect(audit.onAttemptTelemetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            disposition: 'rejected', attempt: 1,
        }));
        expect(mocks.generateContent).toHaveBeenCalledTimes(suspension === 'audit' ? 0 : 1);
        expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(reservation, 0);
    });

    it('releases an approved Dev reservation at zero when audit admission rejects before dispatch', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const reservation = { grantId: grant.id, reservationId: 'synthetic-reservation' };
        const audit = stageAuditOptions();
        audit.onBeforeAttempt.mockRejectedValueOnce(new Error('ANALYSIS_V2_AI_CAPACITY_PENDING'));
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValueOnce(reservation);

        await expect(analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema,
        })).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
        expect(mocks.reserveDevAttempt.mock.invocationCallOrder[0])
            .toBeLessThan(audit.onBeforeAttempt.mock.invocationCallOrder[0]);
        expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(reservation, 0);
        expect(audit.onAttemptTelemetry).not.toHaveBeenCalled();
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it.each([false, true])('charges once after a rolled-back audit intent (redelivery=%s)', async redelivered => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const spend = { grantId: grant.id, reservationId: 'synthetic-reservation' };
        mocks.requireDevApproval.mockReturnValue(grant);
        const unused = { grantId: grant.id, reservationId: 'synthetic-unused-reservation' };
        if (redelivered) mocks.reserveDevAttempt.mockResolvedValueOnce(unused);
        mocks.reserveDevAttempt.mockResolvedValueOnce(spend);
        mocks.generateContent.mockResolvedValueOnce(successfulResponse());
        const attempt = {
            requestId: stageRequestId,
            jobKey: 'track:profile-ai:batch:0',
            operationKey: createAnalysisV2AiOperationKey('genderTriage', 'synthetic-checkpoint'),
            attempt: 1,
            retryCount: 0,
            modelName: 'gemini-3.1-flash-lite',
            location: 'global',
            stage: 'genderTriage',
            thinkingLevel: 'MINIMAL',
            mediaCount: 0,
            mediaResolution: 'LOW',
            promptVersion: 'gender-triage-v2',
            schemaVersion: 2,
            maxOutputTokens: 128,
        } as const;
        const rollback = {
            data: null,
            error: { code: '57014', message: 'canceling statement due to statement timeout' },
        };
        const rpc = vi.fn().mockResolvedValueOnce(rollback);
        if (redelivered) rpc.mockResolvedValueOnce(rollback);
        rpc.mockImplementation(async (_, args: Record<string, unknown>) => ({
                data: {
                    ...attempt,
                    reservationToken: args.p_reservation_token,
                    created: true,
                    status: 'reserved',
                    usageMetadataStatus: null,
                    usageComplete: null,
                    tokenUsage: null,
                    latencyMs: null,
                    estimatedCostUsd: null,
                    finishReason: null,
                    createdAt: '2026-07-14T01:00:00.000Z',
                    terminalizedAt: null,
                },
                error: null,
            }));
        const attemptStore = createAnalysisV2AiAttemptStore({ rpc });
        const audit = stageAuditOptions();
        let jobClaimToken = '123e4567-e89b-42d3-a456-426614174001';
        audit.onBeforeAttempt.mockImplementation(async () => {
            const reserved = await attemptStore.reserve({
                ...attempt,
                claimToken: jobClaimToken,
            });
            expect(reserved.created).toBe(true);
        });

        const invoke = () => analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema,
            model: attempt.modelName, maxOutputTokens: attempt.maxOutputTokens,
        });
        if (redelivered) {
            await expect(invoke()).rejects.toThrow('AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR');
            expect(mocks.generateContent).not.toHaveBeenCalled();
            expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(unused, 0);
            jobClaimToken = '123e4567-e89b-42d3-a456-426614174002';
        }

        await expect(invoke()).resolves.toEqual({ value: 'ok' });
        expect(rpc).toHaveBeenCalledTimes(redelivered ? 3 : 2);
        expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
        expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({
            p_operation_key: attempt.operationKey, p_attempt: 1, p_claim_token: jobClaimToken,
        });
        expect(rpc.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.generateContent.mock.invocationCallOrder[0]);
        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(mocks.reserveDevAttempt).toHaveBeenCalledTimes(redelivered ? 2 : 1);
        expect(mocks.settleDevAttempt).toHaveBeenCalledTimes(redelivered ? 2 : 1);
        expect(mocks.settleDevAttempt).toHaveBeenLastCalledWith(spend, expect.any(Number));
        expect(mocks.settleDevAttempt.mock.calls.at(-1)?.[1]).toBeGreaterThan(0);
        expect(audit.onAttemptTelemetry).toHaveBeenCalledOnce();
    });

    it.each([
        { failures: 1, code: 'AI_GENERATION_DEADLINE_EXCEEDED' },
        { failures: 2, code: 'DEV_LIVE_BUDGET_UNAVAILABLE' },
    ])('retries the same unused Dev reservation at zero after cancellation ($code)', async ({ failures, code }) => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const reservation = { grantId: grant.id, reservationId: 'synthetic-reservation' };
        const audit = stageAuditOptions();
        const controller = new AbortController();
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockImplementationOnce(async () => {
            controller.abort();
            return reservation;
        });
        for (let index = 0; index < failures; index++) {
            mocks.settleDevAttempt.mockRejectedValueOnce(new Error('synthetic settlement fault'));
        }

        await expect(analyzeWithGemini('prompt', undefined, {
            ...audit, stage: 'genderTriage', schema: responseSchema,
            abortSignal: controller.signal,
        })).rejects.toThrow(code);
        expect(mocks.settleDevAttempt.mock.calls).toEqual([[reservation, 0], [reservation, 0]]);
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it('reserves an owner-start run independently of the shared daily ledger', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        vi.stubEnv('DEV_LIVE_ANALYSIS_ARMED', 'true');
        vi.stubEnv('DEV_LIVE_ANALYSIS_MODE', 'owner_start');
        const grant = { id: 'synthetic-owner-grant' };
        const reservation = { grantId: grant.id, reservationId: 'synthetic-reservation' };
        const budgetGuard = { reserve: vi.fn(), settle: vi.fn(), cancel: vi.fn() };
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValue(reservation);
        mocks.generateContent.mockResolvedValueOnce(successfulResponse());

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema, model: 'gemini-3.1-flash-lite', maxOutputTokens: 128, skipTokenLog: true,
            budgetGuard: budgetGuard as unknown as VertexAiBudgetGuard,
        })).resolves.toEqual({ value: 'ok' });
        expect(budgetGuard.reserve).not.toHaveBeenCalled();
        expect(mocks.reserveDevAttempt).toHaveBeenCalledExactlyOnceWith(
            grant, mocks.generateContent.mock.calls[0][0], 'global',
        );
        expect(mocks.settleDevAttempt).toHaveBeenCalledOnce();
    });

    it('reserves against the same structured request and sliced image parts dispatched to Vertex', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const reservation = { grantId: grant.id, reservationId: 'synthetic-reservation' };
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValueOnce(reservation);
        mocks.generateContent.mockResolvedValueOnce(successfulResponse());
        const schema = z.object({ value: z.string().describe('후보 평가') }).strict();

        await expect(analyzeWithGemini('한글 입력', ['first', 'second', 'omitted'], {
            ...stageAuditOptions(),
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
            model: 'gemini-3-flash-preview',
            mediaResolution: 'MEDIUM',
            maxOutputTokens: 1_024,
            maxImages: 2,
            schema,
        })).resolves.toEqual({ value: 'ok' });

        const [request] = mocks.generateContent.mock.calls[0];
        expect(request).toMatchObject({
            contents: [{
                role: 'user',
                parts: [
                    { text: '한글 입력' },
                    { inlineData: { mimeType: 'image/jpeg', data: 'first' } },
                    { inlineData: { mimeType: 'image/jpeg', data: 'second' } },
                ],
            }],
            config: {
                responseJsonSchema: zodToGeminiResponseJsonSchema(schema),
                candidateCount: 1,
                maxOutputTokens: 1_024,
            },
        });
        expect(mocks.reserveDevAttempt).toHaveBeenCalledExactlyOnceWith(grant, request, 'global');
        expect(mocks.reserveDevAttempt.mock.calls[0][1]).toBe(request);
        expect(mocks.reserveDevAttempt.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.generateContent.mock.invocationCallOrder[0]);
    });

    it('disables SDK retry for a reserved Dev attempt and settles only complete usage', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const reservation = { grantId: 'synthetic-approval', reservationId: 'synthetic-reservation' };
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValue(reservation);
        mocks.generateContent
            .mockResolvedValueOnce(successfulResponse())
            .mockResolvedValueOnce(responseWithText('{"value":"ok"}', null))
            .mockResolvedValueOnce(responseWithText('{"value":"ok"}', { promptTokenCount: 10 }));
        const options = {
            schema: responseSchema, model: 'gemini-3.1-flash-lite', maxOutputTokens: 128, skipTokenLog: true,
        };

        await expect(analyzeWithGemini('prompt', undefined, options)).resolves.toEqual({ value: 'ok' });
        await expect(analyzeWithGemini('prompt', undefined, options)).resolves.toEqual({ value: 'ok' });
        await expect(analyzeWithGemini('prompt', undefined, options)).resolves.toEqual({ value: 'ok' });
        expect(mocks.reserveDevAttempt).toHaveBeenCalledTimes(3);
        expect(mocks.generateContent).toHaveBeenCalledWith(expect.objectContaining({
            config: expect.objectContaining({
                maxOutputTokens: 128, candidateCount: 1,
                httpOptions: expect.objectContaining({ retryOptions: { attempts: 1 } }),
            }),
        }));
        expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(reservation, 0.0000085);
    });

    it('settles the confirmed Dev SDK 429 at zero before reserving the retry', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        vi.useFakeTimers();
        const grant = { id: 'synthetic-approval' };
        const rejected = { grantId: grant.id, reservationId: 'rejected-reservation' };
        const succeeded = { grantId: grant.id, reservationId: 'succeeded-reservation' };
        const zeroSettlement = Promise.withResolvers<void>();
        const onAttemptTelemetry = vi.fn();
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValueOnce(rejected).mockResolvedValueOnce(succeeded);
        mocks.settleDevAttempt.mockReturnValueOnce(zeroSettlement.promise);
        mocks.generateContent
            .mockRejectedValueOnce(new ApiError({ message: 'provider quota detail', status: 429 }))
            .mockResolvedValueOnce(successfulResponse());

        const attempt = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema, model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
            skipTokenLog: true, maxAttempts: 2, onAttemptTelemetry,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(rejected, 0);
        expect(mocks.reserveDevAttempt).toHaveBeenCalledOnce();
        expect(mocks.generateContent).toHaveBeenCalledOnce();

        zeroSettlement.resolve();
        await vi.runAllTimersAsync();

        await expect(attempt).resolves.toEqual({ value: 'ok' });
        expect(mocks.settleDevAttempt.mock.calls).toEqual([[rejected, 0], [succeeded, 0.0000085]]);
        expect(onAttemptTelemetry.mock.calls.map(([entry]) => entry.disposition)).toEqual(['rate_limited', 'success']);
    });

    it.each([
        { error: new Error('network timeout after sending data'), code: 'AI_AMBIGUOUS_GENERATION_ERROR' },
        { error: new Error('provider message mentions HTTP 429'), code: 'AI_AMBIGUOUS_GENERATION_ERROR' },
        { error: new ApiError({ message: 'provider server failure', status: 503 }), code: 'AI_AMBIGUOUS_GENERATION_ERROR' },
        { error: Object.assign(new Error('status from an unknown source'), { status: 429 }), code: 'AI_RATE_LIMIT_ERROR' },
    ])('retains the reserved Dev cost when the rejection is unconfirmed: $error.message', async ({ error, code }) => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        const grant = { id: 'synthetic-approval' };
        const reservation = { grantId: grant.id, reservationId: 'reserved-attempt' };
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValueOnce(reservation);
        mocks.generateContent.mockRejectedValueOnce(error);

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema, model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
            skipTokenLog: true, maxAttempts: 1,
        })).rejects.toThrow(code);
        expect(mocks.reserveDevAttempt).toHaveBeenCalledOnce();
        expect(mocks.settleDevAttempt).not.toHaveBeenCalled();
    });

    it('records the confirmed Dev 429 and stops if its zero settlement fails', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        vi.useFakeTimers();
        const grant = { id: 'synthetic-approval' };
        const reservation = { grantId: grant.id, reservationId: 'reserved-attempt' };
        const onAttemptTelemetry = vi.fn();
        mocks.requireDevApproval.mockReturnValue(grant);
        mocks.reserveDevAttempt.mockResolvedValueOnce(reservation);
        mocks.settleDevAttempt.mockRejectedValueOnce(new Error('DEV_LIVE_BUDGET_UNAVAILABLE'));
        mocks.generateContent.mockRejectedValueOnce(new ApiError({ message: 'provider quota detail', status: 429 }));

        const rejection = expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema, model: 'gemini-3.1-flash-lite', maxOutputTokens: 128,
            skipTokenLog: true, maxAttempts: 2, onAttemptTelemetry,
        })).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await vi.runAllTimersAsync();
        await rejection;

        expect(onAttemptTelemetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ disposition: 'rate_limited' }));
        expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(reservation, 0);
        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(mocks.reserveDevAttempt).toHaveBeenCalledOnce();
    });

    it('does not retry an ambiguous generation and never exposes the provider error', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const attemptTelemetry = vi.fn();
        const providerSecret = 'fetch failed: ECONNRESET api-key=provider-secret';
        mocks.generateContent.mockRejectedValueOnce(new Error(providerSecret));

        const result = analyze(undefined, attemptTelemetry);
        await expect(result).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR: Gemini generation status is unknown; the request was not retried.'
        );

        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(attemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            attempt: 1,
            retryCount: 0,
            disposition: 'ambiguous',
            tokenUsage: null,
            usageComplete: false,
            estimatedCostUsd: null,
        }));
        expect(JSON.stringify(attemptTelemetry.mock.calls)).not.toContain(providerSecret);
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain(providerSecret);
        consoleError.mockRestore();
    });

    it('rejects an unclassified 3.7 override before provider dispatch in the cost policy', async () => {
        const audit = stageAuditOptions();

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            aiStagePolicyVersion: AI_STAGE_POLICY_V212_VERSION,
            model: 'gemini-3.7-flash',
            ...audit,
        })).rejects.toThrow('VERTEX_AI_ESCALATION_REASON_REQUIRED');

        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
    });

    it.each([
        ['gemini-3-flash-preview', 'default'],
        ['custom-free-form-model', 'default'],
    ] as const)('rejects a non-canonical v2.12 model override (%s) before dispatch', async (model, route) => {
        const audit = stageAuditOptions();

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            aiStagePolicyVersion: AI_STAGE_POLICY_V212_VERSION,
            model,
            budgetRoute: route,
            ...audit,
        })).rejects.toThrow('VERTEX_AI_DEFAULT_MODEL_MISMATCH');

        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
    });

    it('fails closed before a v2.12 provider call when production has no durable budget store', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('VERTEX_AI_BUDGET_STORE', 'memory');
        vi.stubEnv('VERTEX_AI_BUDGET_GUARD_ENABLED', 'false');
        const audit = stageAuditOptions();

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            aiStagePolicyVersion: AI_STAGE_POLICY_V212_VERSION,
            ...audit,
        })).rejects.toThrow('VERTEX_AI_BUDGET_STORE_REQUIRED');

        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
    });

    it('reserves the budget before attempt audit and provider dispatch', async () => {
        const audit = stageAuditOptions();
        const budgetGuard = {
            reserve: vi.fn().mockRejectedValue(new Error('VERTEX_AI_BUDGET_EXCEEDED:run')),
            settle: vi.fn(),
            cancel: vi.fn(),
            snapshot: vi.fn(),
        } as unknown as VertexAiBudgetGuard;

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            aiStagePolicyVersion: AI_STAGE_POLICY_V212_VERSION,
            budgetGuard,
            ...audit,
        })).rejects.toThrow('VERTEX_AI_BUDGET_EXCEEDED:run');

        expect(budgetGuard.reserve).toHaveBeenCalledOnce();
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it('does not retry a rate-limit phrase without an explicit 429 status', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const attemptTelemetry = vi.fn();
        mocks.generateContent.mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED rate limit'));

        await expect(analyze(undefined, attemptTelemetry)).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR'
        );

        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(attemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            disposition: 'ambiguous',
        }));
    });

    it('bounds explicit 429 retries at the configured maximum', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent.mockRejectedValue(new ApiError({ message: 'provider quota detail', status: 429 }));

        const attemptTelemetry = vi.fn();
        const result = analyze(undefined, attemptTelemetry);
        const rejection = expect(result).rejects.toThrow(
            'AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.'
        );
        await vi.runAllTimersAsync();
        await rejection;

        expect(mocks.generateContent).toHaveBeenCalledTimes(4);
        expect(mocks.settleDevAttempt).not.toHaveBeenCalled();
        expect(attemptTelemetry).toHaveBeenCalledTimes(4);
        expect(attemptTelemetry.mock.calls.map(call => call[0].disposition))
            .toEqual(['rate_limited', 'rate_limited', 'rate_limited', 'rate_limited']);
        expect(attemptTelemetry.mock.calls.map(call => call[0].retryCount))
            .toEqual([0, 1, 2, 3]);
    });

    it('retains success telemetry after a rate-limit backoff', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        const attemptTelemetry = vi.fn();
        mocks.generateContent
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockResolvedValueOnce(successfulResponse());

        const result = analyze(telemetry, attemptTelemetry);
        await vi.runAllTimersAsync();

        await expect(result).resolves.toEqual({ value: 'ok' });
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
        expect(telemetry).toHaveBeenCalledTimes(1);
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
            tokenUsage: {
                promptTokens: 10,
                completionTokens: 4,
                totalTokens: 14,
                thinkingTokens: 0,
            },
        }));
        expect(attemptTelemetry.mock.calls.map(call => call[0].disposition))
            .toEqual(['rate_limited', 'success']);
    });

    it('logs known usage and attempt telemetry before rejecting an empty response', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        const attemptTelemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText('', {
                promptTokenCount: 12,
                candidatesTokenCount: 0,
                totalTokenCount: 12,
                thoughtsTokenCount: 0,
        }));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'empty_response_test',
            requestId: 'request-1',
            onTelemetry: telemetry,
            onAttemptTelemetry: attemptTelemetry,
        })).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');

        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(mocks.tokenUsageInsert).toHaveBeenCalledTimes(1);
        expect(mocks.tokenUsageInsert).toHaveBeenCalledWith(expect.objectContaining({
            request_id: 'request-1',
            prompt_tokens: 12,
            completion_tokens: 0,
            total_tokens: 12,
            analysis_type: 'empty_response_test',
        }));
        expect(telemetry).not.toHaveBeenCalled();
        expect(attemptTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            disposition: 'response_rejected',
            tokenUsage: {
                promptTokens: 12,
                completionTokens: 0,
                totalTokens: 12,
                thinkingTokens: 0,
            },
        }));
    });

    it('does not log token usage or invoke later telemetry after B-lite aborts during attempt telemetry', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const controller = new AbortController();
        let markAttemptTelemetryStarted!: () => void;
        let releaseAttemptTelemetry!: () => void;
        const attemptTelemetryStarted = new Promise<void>(resolve => {
            markAttemptTelemetryStarted = resolve;
        });
        const onAttemptTelemetry = vi.fn(() => new Promise<void>(resolve => {
            releaseAttemptTelemetry = resolve;
            markAttemptTelemetryStarted();
        }));
        const onTelemetry = vi.fn();
        const budgetGuard = {
            reserve: vi.fn().mockResolvedValue({
                reservationId: 'reservation-1',
                reservationKey: 'request-1:precheckout_blite:1',
                runId: 'request-1',
                orderId: 'request-1',
                dayKey: '2026-09-02',
                route: 'default',
                modelName: 'gemini-3.1-flash-lite',
                attempt: 1,
                estimatedCostUsd: 0.001,
                actualCostUsd: null,
            }),
            settle: vi.fn().mockResolvedValue(undefined),
            cancel: vi.fn().mockResolvedValue(undefined),
            snapshot: vi.fn(),
        } as unknown as VertexAiBudgetGuard;
        mocks.generateContent.mockResolvedValueOnce(successfulResponse());
        setTimeout(() => controller.abort(), 56_000);

        const result = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'precheckout_blite',
            requestId: 'request-1',
            abortSignal: controller.signal,
            onAttemptTelemetry,
            onTelemetry,
            budgetGuard,
        });

        await attemptTelemetryStarted;
        await vi.advanceTimersByTimeAsync(56_000);
        releaseAttemptTelemetry();

        await expect(result).rejects.toThrow('AI_GENERATION_DEADLINE_EXCEEDED');
        expect(mocks.tokenUsageInsert).not.toHaveBeenCalled();
        expect(onTelemetry).not.toHaveBeenCalled();
        expect(budgetGuard.cancel).not.toHaveBeenCalled();
        expect(budgetGuard.settle).toHaveBeenCalledWith(
            expect.objectContaining({ reservationId: 'reservation-1' }),
            { actualCostUsd: 0.000017 },
        );
    });

    it('conservatively settles an unknown charge when abort arrives after provider dispatch', async () => {
        const controller = new AbortController();
        const onAttemptTelemetry = vi.fn();
        const budgetGuard = {
            reserve: vi.fn().mockResolvedValue({
                reservationId: 'reservation-aborted',
                reservationKey: 'request-aborted:featureAnalysis:1',
                runId: 'request-aborted',
                orderId: 'request-aborted',
                dayKey: '2026-09-02',
                route: 'default',
                modelName: 'gemini-3.1-flash-lite',
                attempt: 1,
                estimatedCostUsd: 0.001,
                actualCostUsd: null,
            }),
            settle: vi.fn().mockResolvedValue(undefined),
            cancel: vi.fn().mockResolvedValue(undefined),
            snapshot: vi.fn(),
        } as unknown as VertexAiBudgetGuard;
        mocks.generateContent.mockImplementationOnce(() => {
            controller.abort();
            return Promise.resolve(successfulResponse());
        });

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            requestId: stageRequestId,
            abortSignal: controller.signal,
            onBeforeAttempt: vi.fn().mockResolvedValue(undefined),
            onAttemptTelemetry,
            budgetGuard,
        })).rejects.toThrow('AI_GENERATION_DEADLINE_EXCEEDED');

        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(onAttemptTelemetry).not.toHaveBeenCalled();
        expect(budgetGuard.cancel).not.toHaveBeenCalled();
        expect(budgetGuard.settle).toHaveBeenCalledWith(
            expect.objectContaining({ reservationId: 'reservation-aborted' }),
            { actualCostUsd: null },
        );
    });

    it('does not retry schema-invalid responses', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        mocks.generateContent.mockResolvedValueOnce(responseWithText(JSON.stringify({ wrong: true })));
        await expect(analyze()).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');
        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    });

    it('retries schema-invalid responses for an opted-in stateless feature replay', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const attemptTelemetry = vi.fn();
        mocks.generateContent
            .mockResolvedValueOnce(responseWithText(JSON.stringify({ wrong: true })))
            .mockResolvedValueOnce(successfulResponse());

        const result = await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'feature_analysis_retry_test',
            stage: 'featureAnalysis',
            maxAttempts: 2,
            retryResponseRejections: true,
            replayCapability: issueReplayStatelessCapability(),
            ...stageAuditOptions(),
            onAttemptTelemetry: attemptTelemetry,
        });

        expect(result).toEqual({ value: 'ok' });
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
        expect(attemptTelemetry.mock.calls.map(call => call[0].disposition))
            .toEqual(['response_rejected', 'success']);
    });

    it('returns the original strict rejection when the durable ledger has terminalized the attempt', async () => {
        let terminal = false;
        const onBeforeAttempt = vi.fn(async () => {
            if (terminal) throw new Error('ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: unexpected attempt reservation.');
        });
        const onAttemptTelemetry = vi.fn(async () => { terminal = true; });
        mocks.generateContent.mockResolvedValueOnce(responseWithText(JSON.stringify({ wrong: true })));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            maxAttempts: 2,
            retryResponseRejections: true,
            ...stageAuditOptions(),
            onBeforeAttempt,
            onAttemptTelemetry,
        })).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');

        expect(onBeforeAttempt).toHaveBeenCalledOnce();
        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(onAttemptTelemetry).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ attempt: 1, disposition: 'response_rejected' }),
        );
    });

    it('emits PII-free feature response rejection diagnostics for aggregation', async () => {
        const rawSecret = 'private-profile-value';
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const audit = stageAuditOptions();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(JSON.stringify({
            value: 123,
            unexpectedPrivateField: rawSecret,
        })));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'featureAnalysis',
            analysisType: 'feature_analysis',
            ...audit,
        })).rejects.toThrow('AI_GENERATION_RESPONSE_REJECTED_ERROR');

        expect(audit.onAttemptTelemetry).toHaveBeenCalledWith(
            expect.objectContaining({
                disposition: 'response_rejected',
                responseRejection: {
                    category: 'schema_validation',
                    issues: [
                        { path: 'value', code: 'invalid_type' },
                        { path: '$', code: 'unrecognized_keys' },
                    ],
                    truncated: false,
                },
            })
        );
        expect(consoleWarn).toHaveBeenCalledWith(
            'ANALYSIS_V2_AI_RESPONSE_REJECTION_DIAGNOSTIC',
            expect.stringContaining('"stage":"featureAnalysis"')
        );
        expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(rawSecret);
        expect(JSON.stringify(audit.onAttemptTelemetry.mock.calls)).not.toContain(rawSecret);
    });

    it('rejects multiple candidates and non-natural finish reasons with attempt telemetry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const attemptTelemetry = vi.fn();
        const first = successfulResponse();
        mocks.generateContent.mockResolvedValueOnce({
            ...first,
            candidates: [...first.candidates, ...first.candidates],
        });

        await expect(analyze(undefined, attemptTelemetry)).rejects.toThrow(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR'
        );
        expect(attemptTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({
            disposition: 'response_rejected',
            finishReason: null,
        }));

        mocks.generateContent.mockResolvedValueOnce({
            ...successfulResponse(),
            candidates: [{
                finishReason: 'MAX_TOKENS',
                content: { parts: [{ text: JSON.stringify({ value: 'ok' }) }] },
            }],
        });
        await expect(analyze(undefined, attemptTelemetry)).rejects.toThrow(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR'
        );
        expect(attemptTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({
            disposition: 'response_rejected',
            finishReason: 'MAX_TOKENS',
        }));
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['missing', null],
        ['malformed', {
            promptTokenCount: 10,
            candidatesTokenCount: '4',
            totalTokenCount: 14,
        }],
    ] as const)(
        'marks %s usage unknown without fabricating zero tokens or cost',
        async (status, usageMetadata) => {
            vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const telemetry = vi.fn();
            const attemptTelemetry = vi.fn();
            mocks.generateContent.mockResolvedValueOnce(responseWithText(
                JSON.stringify({ value: 'ok' }),
                usageMetadata
            ));

            await expect(analyzeWithGemini('prompt', undefined, {
                schema: responseSchema,
                analysisType: 'unknown_usage_test',
                onTelemetry: telemetry,
                onAttemptTelemetry: attemptTelemetry,
            })).resolves.toEqual({ value: 'ok' });

            expect(mocks.tokenUsageInsert).not.toHaveBeenCalled();
            expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
                tokenUsage: null,
                usageComplete: false,
                usageMetadataStatus: status,
                estimatedCostUsd: null,
            }));
            expect(attemptTelemetry).toHaveBeenCalledWith(
                expect.objectContaining({
                    disposition: 'success',
                    tokenUsage: null,
                    usageComplete: false,
                    usageMetadataStatus: status,
                    estimatedCostUsd: null,
                }),
                { value: 'ok' }
            );
        }
    );

    it('distinguishes complete true-zero usage from missing metadata', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const telemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            {
                promptTokenCount: 0,
                candidatesTokenCount: 0,
                totalTokenCount: 0,
                thoughtsTokenCount: 0,
            }
        ));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'zero_usage_test',
            onTelemetry: telemetry,
        })).resolves.toEqual({ value: 'ok' });
        expect(mocks.tokenUsageInsert).toHaveBeenCalledWith(expect.objectContaining({
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            estimated_cost_usd: 0,
        }));
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
            tokenUsage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                thinkingTokens: 0,
            },
            usageComplete: true,
            usageMetadataStatus: 'complete',
            estimatedCostUsd: 0,
        }));
    });

    it('infers omitted thinking tokens from an exact total and rejects inconsistent totals', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const completeTelemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                totalTokenCount: 20,
            }
        ));

        await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            onTelemetry: completeTelemetry,
        });
        expect(completeTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            usageComplete: true,
            tokenUsage: expect.objectContaining({ thinkingTokens: 6 }),
        }));

        const malformedTelemetry = vi.fn();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                thoughtsTokenCount: 2,
                totalTokenCount: 20,
            }
        ));
        await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            onTelemetry: malformedTelemetry,
        });
        expect(malformedTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            usageComplete: false,
            usageMetadataStatus: 'malformed',
            tokenUsage: null,
            estimatedCostUsd: null,
        }));
    });
});

describe('analyzeWithGemini stage request policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tokenUsageInsert.mockResolvedValue({ error: null });
        mocks.generateContent.mockResolvedValue(successfulResponse());
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'true');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    function undispatchedBudgetGuard() {
        return {
            reserve: vi.fn().mockRejectedValue(new Error('test: budget must not be reserved')),
            settle: vi.fn(),
            cancel: vi.fn(),
            snapshot: vi.fn(),
        };
    }

    async function expectUnsupportedThinking(options: {
        model?: string;
        stage?: 'genderTriage' | 'featureAnalysis' | 'privateAccountName';
        thinkingLevel?: 'MINIMAL';
    }) {
        const audit = stageAuditOptions();
        const budgetGuard = undispatchedBudgetGuard();
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            aiStagePolicyVersion: AI_STAGE_POLICY_V212_VERSION,
            budgetRoute: 'high_value',
            budgetGuard: budgetGuard as unknown as VertexAiBudgetGuard,
            ...audit,
            ...options,
        })).rejects.toThrow('VERTEX_AI_THINKING_LEVEL_UNSUPPORTED');

        expect(mocks.prepareGoogleApplicationCredentials).not.toHaveBeenCalled();
        expect(budgetGuard.reserve).not.toHaveBeenCalled();
        expect(budgetGuard.settle).not.toHaveBeenCalled();
        expect(budgetGuard.cancel).not.toHaveBeenCalled();
        expect(audit.onBeforeAttempt).not.toHaveBeenCalled();
        expect(audit.onAttemptTelemetry).not.toHaveBeenCalled();
        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(mocks.tokenUsageInsert).not.toHaveBeenCalled();
    }

    it.each([
        'gemini-3.7-flash',
        'gemini-3.7-flash-001',
        'publishers/google/models/gemini-3.7-flash-001',
        'projects/test-project/locations/global/publishers/google/models/gemini-3.7-flash',
    ])('rejects explicit MINIMAL for %s before credential, budget, audit, or SDK work', async model => {
        await expectUnsupportedThinking({ model, stage: 'featureAnalysis', thinkingLevel: 'MINIMAL' });
    });

    it.each(['genderTriage', 'privateAccountName'] as const)(
        'rejects inherited MINIMAL when the %s model is overridden to 3.7',
        async stage => {
            await expectUnsupportedThinking({ model: 'gemini-3.7-flash', stage });
        },
    );

    it('rejects cost-optimized legacy MINIMAL when the configured model resolves to 3.7', async () => {
        vi.stubEnv('VERTEX_AI_MODEL', 'gemini-3.7-flash');

        await expectUnsupportedThinking({});
    });

    it.each(['LOW', 'MEDIUM', 'HIGH'] as const)(
        'dispatches supported 3.7 %s without changing audit or SDK thinking',
        async thinkingLevel => {
            const audit = stageAuditOptions();
            await expect(analyzeWithGemini('prompt', undefined, {
                schema: responseSchema,
                stage: 'genderTriage',
                model: 'publishers/google/models/gemini-3.7-flash-001',
                thinkingLevel,
                ...audit,
            })).resolves.toEqual({ value: 'ok' });

            expect(audit.onBeforeAttempt).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel }));
            expect(mocks.generateContent).toHaveBeenCalledOnce();
            expect(mocks.generateContent.mock.calls[0][0]).toMatchObject({
                model: 'publishers/google/models/gemini-3.7-flash-001',
                config: { thinkingConfig: { thinkingLevel: thinkingLevel.toLowerCase() } },
            });
        },
    );

    it('resumes a durable stage at the supplied absolute attempt and keeps retries contiguous', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        mocks.generateContent
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockResolvedValueOnce(successfulResponse());
        const audit = stageAuditOptions();

        const result = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            analysisType: 'resumed_gender_triage',
            startingAttempt: 2,
            ...audit,
        });
        await vi.runAllTimersAsync();

        await expect(result).resolves.toEqual({ value: 'ok' });
        expect(audit.onBeforeAttempt.mock.calls.map(call => call[0].attempt))
            .toEqual([2, 3]);
        expect(audit.onBeforeAttempt.mock.calls.map(call => call[0].retryCount))
            .toEqual([1, 2]);
        expect(audit.onAttemptTelemetry.mock.calls.map(call => call[0].attempt))
            .toEqual([2, 3]);
    });

    it.each([
        ['genderTriage', 'gemini-3.1-flash-lite', 'minimal', 'MEDIA_RESOLUTION_LOW', 512, 5],
        ['featureAnalysis', 'gemini-3.1-flash-lite', 'medium', 'MEDIA_RESOLUTION_MEDIUM', 2_048, 11],
        ['highRiskNarrative', 'gemini-3-flash-preview', 'high', 'MEDIA_RESOLUTION_MEDIUM', 4_096, 11],
        ['privateAccountName', 'gemini-3.1-flash-lite', 'minimal', 'MEDIA_RESOLUTION_LOW', 8_192, 0],
    ] as const)(
        'maps the %s policy into the generated SDK request',
        async (stage, model, thinking, resolution, maxOutputTokens, expectedMediaCount) => {
            const images = Array.from({ length: 12 }, (_, index) => `image-${index}`);

            await analyzeWithGemini('sensitive prompt', images, {
                schema: responseSchema,
                stage,
                ...stageAuditOptions(),
            });

            const request = mocks.generateContent.mock.calls[0][0];
            expect(request).toMatchObject({
                model,
                config: {
                    maxOutputTokens,
                    mediaResolution: resolution,
                    thinkingConfig: { thinkingLevel: thinking },
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: 'object',
                        properties: { value: { type: 'string' } },
                        required: ['value'],
                        additionalProperties: false,
                    },
                },
            });
            const mediaParts = request.contents[0].parts.filter(
                (part: { inlineData?: unknown }) => part.inlineData
            );
            expect(mediaParts).toHaveLength(expectedMediaCount);
        }
    );

    it('proves the V2 transport uses inline contents and never sends cachedContent', async () => {
        await analyzeWithGemini('inline-only prompt', ['image'], {
            schema: responseSchema,
            stage: 'featureAnalysis',
            ...stageAuditOptions(),
        });

        const request = mocks.generateContent.mock.calls[0][0] as {
            contents?: Array<{ parts?: Array<Record<string, unknown>> }>;
            config?: Record<string, unknown>;
            cachedContent?: unknown;
        };
        expect(request.contents).toHaveLength(1);
        expect(request.contents?.[0]?.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({ text: 'inline-only prompt' }),
        ]));
        expect(request).not.toHaveProperty('cachedContent');
        expect(request.config).not.toHaveProperty('cachedContent');
    });

    it('admits only the bounded v2.9 two-account gender microbatch media override', async () => {
        const images = Array.from({ length: 11 }, (_, index) => `image-${index}`);
        await analyzeWithGemini('prompt', images, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.9',
            maxImages: 10,
            ...stageAuditOptions(),
        });

        const request = mocks.generateContent.mock.calls[0][0];
        expect(request.config).toMatchObject({ maxOutputTokens: 1_024 });
        expect(request.contents[0].parts.filter(
            (part: { inlineData?: unknown }) => part.inlineData
        )).toHaveLength(10);
        await expect(analyzeWithGemini('prompt', images, {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.9',
            maxImages: 11,
            ...stageAuditOptions(),
        })).rejects.toThrow('maxImages override is restricted to bounded v2.9 gender batches');
    });

    it('allows explicit model, thinking, resolution, and output overrides without cost-mode coupling', async () => {
        await analyzeWithGemini('prompt', ['image'], {
            schema: responseSchema,
            stage: 'featureAnalysis',
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'LOW',
            mediaResolution: 'HIGH',
            maxOutputTokens: 777,
            ...stageAuditOptions(),
        });

        expect(mocks.generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-3-flash-preview',
            config: expect.objectContaining({
                maxOutputTokens: 777,
                mediaResolution: 'MEDIA_RESOLUTION_HIGH',
                thinkingConfig: { thinkingLevel: 'low' },
            }),
        }));
    });

    it('allows a staged caller to bind a distinct prompt and schema version while reusing its stage', async () => {
        const audit = stageAuditOptions();
        const onTelemetry = vi.fn();
        await analyzeWithGemini('name-only prompt', [], {
            schema: responseSchema,
            stage: 'genderTriage',
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
            promptVersion: 'gender-name-only-v1',
            schemaVersion: 1,
            maxOutputTokens: 4_096,
            ...audit,
            onTelemetry,
        });

        expect(audit.onBeforeAttempt).toHaveBeenCalledWith(expect.objectContaining({
            promptVersion: 'gender-name-only-v1',
            schemaVersion: 1,
            mediaCount: 0,
            maxOutputTokens: 4_096,
        }));
        expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({
            promptVersion: 'gender-name-only-v1',
            schemaVersion: 1,
            mediaCount: 0,
            maxOutputTokens: 4_096,
        }));
    });

    it('composes one explicit field with unrelated V1 cost-optimized defaults', async () => {
        await analyzeWithGemini('prompt', Array.from({ length: 11 }, () => 'image'), {
            schema: responseSchema,
            thinkingLevel: 'HIGH',
            skipTokenLog: true,
        });

        const request = mocks.generateContent.mock.calls[0][0];
        expect(request.model).toBe('gemini-3.1-flash-lite');
        expect(request.config).toMatchObject({
            thinkingConfig: { thinkingLevel: 'high' },
            mediaResolution: 'MEDIA_RESOLUTION_LOW',
            maxOutputTokens: 1_024,
        });
        expect(request.contents[0].parts).toHaveLength(4);
    });

    it('emits non-PII stage telemetry with model policy, media, latency, tokens, and cost', async () => {
        const onTelemetry = vi.fn();
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await analyzeWithGemini('do-not-leak-this-prompt', ['image-1', 'image-2'], {
            schema: responseSchema,
            stage: 'featureAnalysis',
            analysisType: 'feature_analysis',
            ...stageAuditOptions(),
            onTelemetry,
        });

        expect(onTelemetry).toHaveBeenCalledWith({
            tokenUsage: {
                promptTokens: 10,
                completionTokens: 4,
                totalTokens: 14,
                thinkingTokens: 0,
            },
            usageComplete: true,
            usageMetadataStatus: 'complete',
            modelName: 'gemini-3.1-flash-lite',
            location: 'global',
            stage: 'featureAnalysis',
            thinkingLevel: 'MEDIUM',
            mediaCount: 2,
            mediaResolution: 'MEDIUM',
            promptVersion: 'feature-analysis-v3',
            schemaVersion: 3,
            maxOutputTokens: 2_048,
            latencyMs: expect.any(Number),
            estimatedCostUsd: expect.any(Number),
        });
        expect(JSON.stringify(onTelemetry.mock.calls[0][0])).not.toContain('do-not-leak');
        expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('do-not-leak');
    });

    it('preserves the legacy cost-optimized defaults when no stage options are supplied', async () => {
        await analyzeWithGemini('prompt', ['one', 'two', 'three', 'four'], {
            schema: responseSchema,
            skipTokenLog: true,
        });

        const request = mocks.generateContent.mock.calls[0][0];
        expect(request.model).toBe('gemini-3.1-flash-lite');
        expect(request.config).toMatchObject({
            maxOutputTokens: 1_024,
            mediaResolution: 'MEDIA_RESOLUTION_LOW',
            thinkingConfig: { thinkingLevel: 'minimal' },
        });
        expect(request.contents[0].parts).toHaveLength(4);
    });

    it('requires an auditable stage identity and forbids bypassing durable stage logs', async () => {
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
        })).rejects.toThrow('valid request UUID and durable attempt callbacks');

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: 'not-a-uuid',
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
        })).rejects.toThrow('valid request UUID and durable attempt callbacks');

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...stageAuditOptions(),
            skipTokenLog: true,
        })).rejects.toThrow('cannot skip durable token logging');
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it('rejects forged or legacy boolean stateless replay bypasses', async () => {
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...stageAuditOptions(),
            skipTokenLog: true,
            replayCapability: {} as never,
        })).rejects.toThrow('Gemini replay capability is invalid');

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...stageAuditOptions(),
            skipTokenLog: true,
            statelessReplay: true,
        } as never)).rejects.toThrow('cannot skip durable token logging');
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });

    it('fails closed around both durable stage audit boundaries', async () => {
        const beforeFailure = vi.fn().mockRejectedValue(new Error('database unavailable'));
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt: beforeFailure,
            onAttemptTelemetry: vi.fn(),
        })).rejects.toThrow('AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR');
        expect(mocks.generateContent).not.toHaveBeenCalled();

        const onBeforeAttempt = vi.fn().mockResolvedValue(undefined);
        const onAttemptTelemetry = vi.fn().mockRejectedValue(new Error('database unavailable'));
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt,
            onAttemptTelemetry,
        })).rejects.toThrow('AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR');
        expect(mocks.generateContent).toHaveBeenCalledOnce();
        expect(onBeforeAttempt.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.generateContent.mock.invocationCallOrder[0]);
    });

    it('reports only the stage, audit boundary and allowlisted database reason before dispatch', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(analyzeWithGemini('prompt', undefined, {
                schema: responseSchema,
                stage: 'genderTriage',
                requestId: stageRequestId,
                onBeforeAttempt: vi.fn().mockRejectedValue(new Error(
                    'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: private diagnostic (40P01).'
                )),
                onAttemptTelemetry: vi.fn(),
            })).rejects.toThrow('AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR');
            expect(warn).toHaveBeenCalledWith(JSON.stringify({
                event: 'gemini_durable_audit_failed', boundary: 'intent', stage: 'genderTriage',
                reason: 'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR', databaseCode: '40P01',
            }));
            expect(JSON.stringify(warn.mock.calls)).not.toContain('private diagnostic');
            expect(mocks.generateContent).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it.each([
        'ANALYSIS_V2_AI_CAPACITY_PENDING',
        'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
        'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
    ])('preserves the pre-SDK admission signal %s without usage telemetry', async code => {
        const onAttemptTelemetry = vi.fn();
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt: vi.fn().mockRejectedValue(new Error(code)),
            onAttemptTelemetry,
        })).rejects.toThrow(code);
        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(onAttemptTelemetry).not.toHaveBeenCalled();
    });

    it('preserves a composed pre-dispatch rejection without touching Gemini or emitting duplicate telemetry', async () => {
        const onAttemptTelemetry = vi.fn();
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            requestId: stageRequestId,
            onBeforeAttempt: vi.fn().mockRejectedValue(new GeminiPreDispatchAdmissionError()),
            onAttemptTelemetry,
        })).rejects.toBeInstanceOf(GeminiPreDispatchAdmissionError);
        expect(mocks.generateContent).not.toHaveBeenCalled();
        expect(onAttemptTelemetry).not.toHaveBeenCalled();
    });

    it('durably emits a stage attempt even when SDK usage metadata is missing', async () => {
        const audit = stageAuditOptions();
        mocks.generateContent.mockResolvedValueOnce(responseWithText(
            JSON.stringify({ value: 'ok' }),
            null
        ));

        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderTriage',
            ...audit,
        })).resolves.toEqual({ value: 'ok' });

        expect(audit.onBeforeAttempt).toHaveBeenCalledOnce();
        expect(audit.onAttemptTelemetry).toHaveBeenCalledWith(
            expect.objectContaining({
                disposition: 'success',
                usageMetadataStatus: 'missing',
                tokenUsage: null,
            }),
            { value: 'ok' }
        );
    });

    it('preserves non-optimized V1 model and generation defaults while adding strict JSON output', async () => {
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'false');
        vi.stubEnv('VERTEX_AI_MODEL', 'gemini-legacy-override');

        await analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            skipTokenLog: true,
        });

        expect(mocks.generateContent).toHaveBeenCalledWith({
            model: 'gemini-legacy-override',
            contents: expect.any(Array),
            config: {
                responseMimeType: 'application/json',
                responseJsonSchema: expect.objectContaining({
                    type: 'object',
                    additionalProperties: false,
                }),
                httpOptions: { timeout: 210_000 },
            },
        });
    });
});

describe('Gemini response JSON Schema mapping', () => {
    it('keeps strict structure, converts literals, and removes unsupported schema keywords', () => {
        const schema = z.object({
            kind: z.literal('ok'),
            id: z.string().regex(/^[a-z]+$/).min(2).max(12),
        }).strict();

        const mapped = zodToGeminiResponseJsonSchema(schema);

        expect(mapped).toEqual({
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['ok'] },
                id: { type: 'string' },
            },
            required: ['kind', 'id'],
            additionalProperties: false,
        });
        expect(JSON.stringify(mapped)).not.toContain('$schema');
        expect(JSON.stringify(mapped)).not.toContain('pattern');
    });

    it('maps the model wire input for transforms and uses supported tuple prefix items', () => {
        const schema = z.object({
            transformed: z.string().transform(value => value.length),
            lines: z.tuple([z.string(), z.string()]),
        }).strict();

        expect(zodToGeminiResponseJsonSchema(schema)).toEqual({
            type: 'object',
            properties: {
                transformed: { type: 'string' },
                lines: {
                    type: 'array',
                    prefixItems: [{ type: 'string' }, { type: 'string' }],
                },
            },
            required: ['transformed', 'lines'],
            additionalProperties: false,
        });
    });

    it('maps every existing V1 response schema without weakening runtime validation', () => {
        const schemas: ZodType[] = [
            appearanceAnalysisResponseSchema,
            combinedAnalysisResponseSchema,
            exposureAnalysisResponseSchema,
            genderAnalysisResponseSchema,
            intimacyAnalysisResponseSchema,
            photogenicAnalysisResponseSchema,
            deepRiskNarrativeResponseSchema,
            createPrivateNameBatchResponseSchema(['expected-id']),
        ];

        for (const schema of schemas) {
            expect(zodToGeminiResponseJsonSchema(schema)).toEqual(expect.any(Object));
        }
        expect(() => deepRiskNarrativeResponseSchema.parse({ lines: ['invalid', 'invalid'] }))
            .toThrow();
    });

    it('keeps large private-name batch cardinality out of the Vertex response schema', () => {
        const expectedIds = Array.from({ length: 100 }, (_, index) => `account-${index}`);
        const schema = createPrivateNameBatchResponseSchema(expectedIds);
        const mapped = zodToGeminiResponseJsonSchema(schema);

        expect(mapped).not.toHaveProperty('minItems');
        expect(mapped).not.toHaveProperty('maxItems');
        expect(() => schema.parse([])).toThrow('exact input count');
    });
});

describe('analyzeWithGemini process concurrency', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.reserveDevAttempt.mockReset();
        mocks.settleDevAttempt.mockReset().mockResolvedValue(undefined);
        mocks.tokenUsageInsert.mockResolvedValue({ error: null });
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
        vi.stubEnv('VERTEX_AI_COST_OPTIMIZED', 'false');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    function deferredGenerations() {
        const releases: Array<() => void> = [];
        let active = 0;
        let maximumActive = 0;
        mocks.generateContent.mockImplementation(() => new Promise(resolve => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            releases.push(() => {
                active--;
                resolve(successfulResponse());
            });
        }));
        return {
            releases,
            maximumActive: () => maximumActive,
        };
    }

    it('uses the normal feature and shared generation limits for Dev owner-start Standard', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        vi.stubEnv('DEV_LIVE_ANALYSIS_MODE', 'owner_start');
        const approval = { planId: 'standard', expiresAt: null };
        mocks.requireDevApproval.mockReturnValue(approval);
        mocks.reserveDevAttempt.mockResolvedValue({ reservationId: 'synthetic-reservation' });

        const deferred = deferredGenerations();
        const audit = stageAuditOptions();
        const start = (stage: 'featureAnalysis' | 'genderTriage') => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage,
            aiStagePolicyVersion: 'ai-stage-policy-v2.11',
            ...audit,
        });
        const active: Array<ReturnType<typeof start>> = [];
        const begin = async (stage: 'featureAnalysis' | 'genderTriage') => {
            // Stage each import of the mocked budget module, then hold every SDK call open.
            active.push(start(stage));
            await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(active.length));
        };
        for (let i = 0; i < 3; i++) await begin('featureAnalysis');
        await expect(start('featureAnalysis')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
        expect(mocks.reserveDevAttempt).toHaveBeenCalledTimes(3);

        for (let i = 0; i < 5; i++) await begin('genderTriage');
        await expect(start('genderTriage')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
        expect(deferred.maximumActive()).toBe(8);
        expect(mocks.reserveDevAttempt).toHaveBeenCalledTimes(8);
        expect(audit.onBeforeAttempt).toHaveBeenCalledTimes(8);
        expect(mocks.settleDevAttempt).not.toHaveBeenCalled();

        deferred.releases.splice(0).forEach(release => release());
        await expect(Promise.all(active)).resolves.toHaveLength(8);
        expect(mocks.settleDevAttempt).toHaveBeenCalledTimes(8);
    });

    it.each([
        ['paid', 'basic', '2026-11-21T06:00:00.000Z', 'owner_start'],
        ['paid', 'basic', '2026-11-21T06:00:00.000Z', undefined],
        ['paid', 'standard', '2026-11-21T06:00:00.000Z', 'owner_start'],
        ['preflight', 'standard', null, 'owner_start'],
    ] as const)('serializes Dev %s %s with expiry %s in mode %s', async (role, planId, expiresAt, mode) => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', role);
        vi.stubEnv('DEV_LIVE_ANALYSIS_MODE', mode);
        mocks.requireDevApproval.mockReturnValue({ planId, expiresAt });
        mocks.reserveDevAttempt.mockResolvedValue({ reservationId: 'synthetic-reservation' });

        const deferred = deferredGenerations();
        const options = {
            schema: responseSchema,
            stage: 'genderTriage' as const,
            aiStagePolicyVersion: 'ai-stage-policy-v2.11' as const,
            ...stageAuditOptions(),
        };
        const first = analyzeWithGemini('prompt', undefined, options);
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(1));
        const second = analyzeWithGemini('prompt', undefined, options);
        await vi.waitFor(() => expect(mocks.requireDevApproval).toHaveBeenCalledTimes(2));
        expect(mocks.reserveDevAttempt).toHaveBeenCalledTimes(1);
        deferred.releases.shift()?.();
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(2));
        deferred.releases.shift()?.();
        await Promise.all([first, second]);
        expect(deferred.maximumActive()).toBe(1);
    });

    it('does not start audit or Vertex work for a parallel Dev Standard reservation that exceeds the cap', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
        vi.stubEnv('DEV_LIVE_ANALYSIS_MODE', 'owner_start');
        mocks.requireDevApproval.mockReturnValue({ planId: 'standard', expiresAt: null });

        const limit = 18_000_000;
        const reservationMicros = 153_875;
        // Simulate charges and reservations already committed by other workers.
        let committed = 8_200_000 + 62 * reservationMicros;
        const reservation = { reservationId: 'synthetic-reservation' };
        mocks.reserveDevAttempt.mockImplementation(async () => {
            if (committed + reservationMicros > limit) throw new Error('DEV_LIVE_BUDGET_EXCEEDED');
            committed += reservationMicros;
            return reservation;
        });
        mocks.settleDevAttempt.mockImplementation(async (_reservation: unknown, actual: number) => {
            committed += Math.ceil(actual * 1_000_000) - reservationMicros;
        });

        const deferred = deferredGenerations();
        const audit = stageAuditOptions();
        const options = {
            schema: responseSchema,
            stage: 'featureAnalysis' as const,
            aiStagePolicyVersion: 'ai-stage-policy-v2.11' as const,
            ...audit,
        };
        const first = analyzeWithGemini('prompt', undefined, options);
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(1));
        await expect(analyzeWithGemini('prompt', undefined, options)).rejects.toThrow('DEV_LIVE_BUDGET_EXCEEDED');
        expect(committed).toBeLessThan(limit);
        expect(mocks.generateContent).toHaveBeenCalledTimes(1);
        expect(audit.onBeforeAttempt).toHaveBeenCalledTimes(1);
        expect(mocks.settleDevAttempt).not.toHaveBeenCalled();
        deferred.releases.shift()?.();
        await expect(first).resolves.toEqual({ value: 'ok' });
        expect(mocks.settleDevAttempt).toHaveBeenCalledExactlyOnceWith(reservation, expect.any(Number));
    });

    it('caps all process-shared generations at eight', async () => {
        const deferred = deferredGenerations();
        const calls = Array.from({ length: 12 }, () => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            skipTokenLog: true,
        }));

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(8));
        expect(deferred.maximumActive()).toBe(8);
        deferred.releases.splice(0, 8).forEach(release => release());
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(12));
        deferred.releases.splice(0).forEach(release => release());

        await expect(Promise.all(calls)).resolves.toHaveLength(12);
        expect(deferred.maximumActive()).toBe(8);
    });

    it('applies the lower high-risk narrative cap of three', async () => {
        const deferred = deferredGenerations();
        const calls = Array.from({ length: 5 }, () => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'highRiskNarrative',
            ...stageAuditOptions(),
        }));

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(3));
        expect(deferred.maximumActive()).toBe(3);
        deferred.releases.splice(0, 3).forEach(release => release());
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(5));
        deferred.releases.splice(0).forEach(release => release());

        await expect(Promise.all(calls)).resolves.toHaveLength(5);
        expect(deferred.maximumActive()).toBe(3);
    });

    it.each([
        ['genderTriage', 4],
        ['featureAnalysis', 4],
        ['privateAccountName', 2],
    ] as const)('enforces the v2.7 %s stage semaphore at %i', async (stage, concurrency) => {
        const deferred = deferredGenerations();
        const options = {
            schema: responseSchema,
            stage,
            aiStagePolicyVersion: 'ai-stage-policy-v2.7' as const,
            ...stageAuditOptions(),
        };
        const calls = Array.from({ length: concurrency + 1 }, () =>
            analyzeWithGemini('prompt', undefined, options)
        );

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency));
        expect(deferred.maximumActive()).toBe(concurrency);
        deferred.releases.splice(0, concurrency).forEach(release => release());
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency + 1));
        deferred.releases.splice(0).forEach(release => release());

        await expect(Promise.all(calls)).resolves.toHaveLength(concurrency + 1);
        expect(deferred.maximumActive()).toBe(concurrency);
    });

    it.each([
        ['genderTriage', 6],
        ['featureAnalysis', 3],
        ['privateAccountName', 2],
    ] as const)(
        'matches the v2.8 scheduler %s cap at %i without hidden queueing',
        async (stage, concurrency) => {
            const deferred = deferredGenerations();
            const options = {
                schema: responseSchema,
                stage,
                aiStagePolicyVersion: 'ai-stage-policy-v2.8' as const,
                ...stageAuditOptions(),
            };
            const active = Array.from({ length: concurrency }, () =>
                analyzeWithGemini('prompt', undefined, options)
            );

            await vi.waitFor(() => (
                expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency)
            ));
            await expect(analyzeWithGemini('prompt', undefined, options))
                .rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            expect(mocks.generateContent).toHaveBeenCalledTimes(concurrency);
            deferred.releases.splice(0).forEach(release => release());
            await expect(Promise.all(active)).resolves.toHaveLength(concurrency);
            expect(deferred.maximumActive()).toBe(concurrency);
        },
    );

    it('never queues a resolver when either bounded slot is unavailable', async () => {
        const deferred = deferredGenerations();
        const resolverOptions = {
            schema: responseSchema,
            stage: 'genderResolution' as const,
            aiStagePolicyVersion: 'ai-stage-policy-v2.7' as const,
            ...stageAuditOptions(),
        };
        const first = analyzeWithGemini('prompt', undefined, resolverOptions);
        const second = analyzeWithGemini('prompt', undefined, resolverOptions);

        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(2));
        await expect(analyzeWithGemini('prompt', undefined, resolverOptions))
            .rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        expect(mocks.generateContent).toHaveBeenCalledTimes(2);

        deferred.releases.splice(0).forEach(release => release());
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    });

    it('removes an aborted queued B-lite request without consuming a generation permit', async () => {
        const deferred = deferredGenerations();
        const active = Array.from({ length: 8 }, () => analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            skipTokenLog: true,
        }));
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(8));

        const controller = new AbortController();
        const onAttemptTelemetry = vi.fn();
        const queued = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            analysisType: 'precheckout_blite',
            skipTokenLog: true,
            abortSignal: controller.signal,
            onAttemptTelemetry,
        });
        controller.abort();

        await expect(queued).rejects.toThrow('AI_GENERATION_DEADLINE_EXCEEDED');
        expect(mocks.generateContent).toHaveBeenCalledTimes(8);
        expect(onAttemptTelemetry).not.toHaveBeenCalled();

        deferred.releases.splice(0).forEach(release => release());
        await expect(Promise.all(active)).resolves.toHaveLength(8);

        const followUp = analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            skipTokenLog: true,
        });
        await vi.waitFor(() => expect(mocks.generateContent).toHaveBeenCalledTimes(9));
        deferred.releases.splice(0).forEach(release => release());
        await expect(followUp).resolves.toEqual({ value: 'ok' });
    });

    it('rejects resolver use under the frozen v2.6 policy', async () => {
        await expect(analyzeWithGemini('prompt', undefined, {
            schema: responseSchema,
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.6',
            ...stageAuditOptions(),
        })).rejects.toThrow('Unsupported AI stage');
        expect(mocks.generateContent).not.toHaveBeenCalled();
    });
});
