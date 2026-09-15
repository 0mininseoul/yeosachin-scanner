import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    evaluateVertexAiCostGate,
    type VertexAiCostGateFixture,
} from '@/lib/services/ai/vertex-ai-cost-gate';

describe('checked-in Vertex AI cost gate fixture', () => {
    it('derives recall from counts and keeps rollout blocked until real evidence exists', () => {
        const fixture = JSON.parse(readFileSync(resolve(
            process.cwd(),
            'reports/vertex-ai-cost-optimization-fixture.json',
        ), 'utf8')) as VertexAiCostGateFixture;
        const result = evaluateVertexAiCostGate(fixture);

        expect(result.baselineCostUsd).toBe(146.801862);
        expect(result.proposedCostUsd).toBe(56.801862);
        expect(result.qualityContract).toMatchObject({
            highRiskRecall: 0.97,
            requiredHighRiskRecall: 0.95,
            highRiskRecallEvidenceStatus: 'unverified_fixture',
        });
        expect(result.violations).toContain('VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_UNVERIFIED');
        expect(result.passed).toBe(false);
    });
});
