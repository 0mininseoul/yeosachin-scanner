import { describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_VERTEX_AI_BUDGET_LIMITS,
    VertexAiBudgetExceededError,
    createVertexAiBudgetGuard,
    estimateVertexAiPreDispatchCost,
    isVertexAiDefaultModel,
    isVertexAiEscalationModel,
    selectVertexAiRoute,
} from './vertex-ai-cost-policy';

describe('Vertex AI cost routing', () => {
    it('uses Flash-Lite for a first pass when no escalation reason is present', () => {
        const route = selectVertexAiRoute({ stage: 'featureAnalysis' });

        expect(route).toMatchObject({
            route: 'default',
            modelName: 'gemini-3.1-flash-lite',
            thinkingLevel: 'LOW',
            maxOutputTokens: 1_024,
            maxAttempts: 1,
        });
    });

    it('allows 3.7 only for typed high-value or ambiguous escalation', () => {
        expect(selectVertexAiRoute({
            stage: 'highRiskNarrative',
            escalationReason: 'high_value',
        })).toMatchObject({
            route: 'high_value',
            modelName: 'gemini-3.7-flash',
            maxOutputTokens: 4_096,
            maxAttempts: 2,
            retryResponseRejections: false,
        });
        expect(selectVertexAiRoute({
            stage: 'featureAnalysis',
            escalationReason: 'ambiguous',
        }).retryResponseRejections).toBe(true);
    });

    it('estimates a bounded, known cost before dispatch', () => {
        expect(estimateVertexAiPreDispatchCost({
            modelName: 'gemini-3.7-flash',
            location: 'global',
            inputTokens: 28_696_298,
            maxOutputTokens: 13_834_322,
        }).totalCostUsd).toBe(146.801862);
        expect(() => estimateVertexAiPreDispatchCost({
            modelName: 'unknown-model',
            location: 'global',
            inputTokens: 1,
            maxOutputTokens: 1,
        })).toThrow('VERTEX_AI_PRICING_UNKNOWN');
        expect(isVertexAiEscalationModel('publishers/google/models/gemini-3.7-flash-001')).toBe(true);
        expect(isVertexAiEscalationModel('gemini-3.1-flash-lite')).toBe(false);
    });

    it('recognizes only the canonical v2.12 default and escalation model families', () => {
        expect(isVertexAiDefaultModel('gemini-3.1-flash-lite')).toBe(true);
        expect(isVertexAiDefaultModel('publishers/google/models/gemini-3.1-flash-lite-001'))
            .toBe(true);
        expect(isVertexAiDefaultModel('gemini-3-flash-preview')).toBe(false);
        expect(isVertexAiEscalationModel('gemini-3.7-flash-001')).toBe(true);
        expect(isVertexAiEscalationModel('gemini-3-flash-preview')).toBe(false);
    });
});

describe('Vertex AI budget guard', () => {
    it('enforces run, order, and UTC-day limits before the provider callback', async () => {
        const guard = createVertexAiBudgetGuard({
            limits: {
                ...DEFAULT_VERTEX_AI_BUDGET_LIMITS,
                perRunUsd: 0.01,
                perOrderUsd: 0.02,
                dailyUsd: 0.03,
            },
            now: () => new Date('2026-08-19T03:00:00.000Z'),
        });
        const input = {
            reservationKey: 'run-1:operation-1:1',
            runId: 'run-1',
            orderId: 'order-1',
            operationKey: 'operation-1',
            attempt: 1,
            modelName: 'gemini-3.7-flash',
            location: 'global',
            inputTokens: 1_000,
            maxOutputTokens: 1_000,
            route: 'high_value' as const,
        };
        const reservation = await guard.reserve(input);
        expect(reservation.estimatedCostUsd).toBe(0.009);

        await expect(guard.reserve({
            ...input,
            reservationKey: 'run-1:operation-2:1',
            operationKey: 'operation-2',
            inputTokens: 2_000,
            maxOutputTokens: 2_000,
        })).rejects.toBeInstanceOf(VertexAiBudgetExceededError);
        expect((await guard.snapshot()).run['run-1']).toBe(0.009);
    });

    it('is idempotent for recovery and treats a retry as a new reservation', async () => {
        const guard = createVertexAiBudgetGuard({
            limits: { perRunUsd: 1, perOrderUsd: 2, dailyUsd: 3 },
            now: () => new Date('2026-08-19T03:00:00.000Z'),
        });
        const input = {
            reservationKey: 'run-2:operation-1:1',
            runId: 'run-2',
            orderId: 'order-2',
            operationKey: 'operation-1',
            attempt: 1,
            modelName: 'gemini-3.1-flash-lite',
            location: 'global',
            inputTokens: 1_000,
            maxOutputTokens: 1_000,
            route: 'default' as const,
        };
        const first = await guard.reserve(input);
        const duplicate = await guard.reserve(input);
        expect(duplicate.reservationId).toBe(first.reservationId);

        const retry = await guard.reserve({ ...input, reservationKey: 'run-2:operation-1:2', attempt: 2 });
        expect(retry.reservationId).not.toBe(first.reservationId);
        await guard.settle(first, { actualCostUsd: null });
        expect((await guard.snapshot()).run['run-2']).toBe(0.0035);
    });

    it('keeps settlement idempotent and rejects conflicting second actual costs', async () => {
        const guard = createVertexAiBudgetGuard({
            limits: { perRunUsd: 1, perOrderUsd: 1, dailyUsd: 1 },
        });
        const reservation = await guard.reserve({
            reservationKey: 'settle-key',
            runId: 'run-settle',
            operationKey: 'operation-settle',
            attempt: 1,
            route: 'default',
            modelName: 'gemini-3.1-flash-lite',
            inputTokens: 1_000,
            maxOutputTokens: 1_000,
        });
        await guard.settle(reservation, { actualCostUsd: 0.001 });
        await guard.settle(reservation, { actualCostUsd: 0.001 });
        expect((await guard.snapshot()).run['run-settle']).toBeCloseTo(0.001, 12);
        await expect(guard.settle(reservation, { actualCostUsd: 0.002 }))
            .rejects.toThrow('VERTEX_AI_BUDGET_SETTLEMENT_IDENTITY_DRIFT');
    });

    it('keeps an implicit active reservation on its original UTC day during recovery', async () => {
        let now = new Date('2026-08-19T23:59:59.000Z');
        const guard = createVertexAiBudgetGuard({
            limits: { perRunUsd: 1, perOrderUsd: 2, dailyUsd: 3 },
            now: () => now,
        });
        const input = {
            reservationKey: 'midnight-active',
            runId: 'midnight-run',
            operationKey: 'operation-1',
            attempt: 1,
            route: 'default' as const,
            modelName: 'gemini-3.1-flash-lite',
            inputTokens: 1_000,
            maxOutputTokens: 1_000,
        };

        const first = await guard.reserve(input);
        now = new Date('2026-08-20T00:00:01.000Z');
        const recovered = await guard.reserve(input);

        expect(first.dayKey).toBe('2026-08-19');
        expect(recovered.reservationId).toBe(first.reservationId);
        expect(recovered.dayKey).toBe('2026-08-19');
        expect((await guard.snapshot()).day).toEqual({ '2026-08-19': 0.00175 });
    });

    it('re-admits a cancelled implicit retry on the new UTC day', async () => {
        let now = new Date('2026-08-19T23:59:59.000Z');
        const guard = createVertexAiBudgetGuard({
            limits: { perRunUsd: 1, perOrderUsd: 2, dailyUsd: 3 },
            now: () => now,
        });
        const input = {
            reservationKey: 'midnight-cancelled',
            runId: 'midnight-cancelled-run',
            operationKey: 'operation-1',
            attempt: 1,
            route: 'default' as const,
            modelName: 'gemini-3.1-flash-lite',
            inputTokens: 1_000,
            maxOutputTokens: 1_000,
        };

        const first = await guard.reserve(input);
        await guard.cancel(first);
        now = new Date('2026-08-20T00:00:01.000Z');
        const retry = await guard.reserve(input);

        expect(retry.reservationId).not.toBe(first.reservationId);
        expect(retry.dayKey).toBe('2026-08-20');
        expect((await guard.snapshot()).day).toEqual({ '2026-08-20': 0.00175 });
    });

    it('fails closed in production without the durable Supabase budget store', () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('VERTEX_AI_BUDGET_STORE', 'memory');

        expect(() => createVertexAiBudgetGuard()).toThrow('VERTEX_AI_BUDGET_STORE_REQUIRED');
        vi.stubEnv('VERTEX_AI_BUDGET_STORE', 'supabase');
        expect(() => createVertexAiBudgetGuard()).toThrow('VERTEX_AI_BUDGET_STORE_CLIENT_REQUIRED');
        expect(() => createVertexAiBudgetGuard({
            store: {
                reserve: vi.fn(),
                settle: vi.fn(),
                cancel: vi.fn(),
                snapshot: vi.fn(),
            },
        })).not.toThrow();
        vi.unstubAllEnvs();
    });
});
