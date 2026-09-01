import { describe, expect, it } from 'vitest';
import {
    evaluateVertexAiCostGate,
    type VertexAiCostGateFixture,
} from './vertex-ai-cost-gate';

const qualityFixture: VertexAiCostGateFixture = {
    baseline: {
        modelName: 'gemini-3.7-flash',
        inputTokens: 28_696_298,
        outputTokens: 13_834_322,
        highRiskRecall: 1,
    },
    proposed: {
        routes: [
            {
                route: 'default',
                reason: null,
                modelName: 'gemini-3.1-flash-lite',
                inputTokens: 24_000_000,
                outputTokens: 10_000_000,
                calls: 80,
                attempts: 80,
            },
            {
                route: 'high_value',
                reason: 'high_value',
                modelName: 'gemini-3.7-flash',
                inputTokens: 4_696_298,
                outputTokens: 3_834_322,
                calls: 20,
                attempts: 20,
            },
        ],
        unknownUsageRate: 0,
        highRiskRecall: 0.97,
        maxOutputTokens: 4_096,
        maxThinkingLevel: 'LOW',
        maxAttempts: 2,
    },
};

describe('Vertex AI dry-run quality and cost gate', () => {
    it('proves the exact baseline and at least 50% modeled gross savings', () => {
        const result = evaluateVertexAiCostGate(qualityFixture);

        expect(result.passed).toBe(true);
        expect(result.baselineCostUsd).toBe(146.801862);
        expect(result.proposedCostUsd).toBe(56.801862);
        expect(result.savingsUsd).toBe(90);
        expect(result.savingsRate).toBeCloseTo(0.61307124, 8);
        expect(result.qualityContract).toMatchObject({
            unknownUsageRate: 0,
            highRiskRecall: 0.97,
            defaultRouteShare: 0.8,
        });
    });

    it('fails closed for unknown pricing and an unapproved 3.7 route', () => {
        const result = evaluateVertexAiCostGate({
            ...qualityFixture,
            proposed: {
                ...qualityFixture.proposed,
                routes: [{
                    ...qualityFixture.proposed.routes[0]!,
                    modelName: 'unknown-model',
                }, {
                    ...qualityFixture.proposed.routes[1]!,
                    reason: null,
                }],
            },
        });

        expect(result.passed).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            'VERTEX_AI_PRICING_UNKNOWN',
            'VERTEX_AI_ESCALATION_REASON_REQUIRED',
        ]));
    });

    it('protects quality and retry/output budgets in the release contract', () => {
        const result = evaluateVertexAiCostGate({
            ...qualityFixture,
            proposed: {
                ...qualityFixture.proposed,
                unknownUsageRate: 0.31,
                highRiskRecall: 0.94,
                maxOutputTokens: 8_192,
                maxThinkingLevel: 'HIGH',
                maxAttempts: 3,
            },
        });

        expect(result.passed).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            'VERTEX_AI_UNKNOWN_USAGE_RATE_TOO_HIGH',
            'VERTEX_AI_HIGH_RISK_RECALL_TOO_LOW',
            'VERTEX_AI_OUTPUT_BUDGET_TOO_HIGH',
            'VERTEX_AI_THINKING_BUDGET_TOO_HIGH',
            'VERTEX_AI_RETRY_BUDGET_TOO_HIGH',
        ]));
    });
});
