import {
    estimateGeminiRequestCostStrict,
    type GeminiRequestCostEstimate,
} from './gemini-cost';
import {
    isVertexAiDefaultModel,
    isVertexAiEscalationModel,
    type VertexAiCostRoute,
} from './vertex-ai-cost-policy';

export const VERTEX_AI_COST_GATE_MIN_SAVINGS_RATE = 0.5;
export const VERTEX_AI_COST_GATE_MAX_UNKNOWN_USAGE_RATE = 0.3;
export const VERTEX_AI_COST_GATE_MIN_HIGH_RISK_RECALL = 0.95;
export const VERTEX_AI_COST_GATE_MAX_OUTPUT_TOKENS = 4_096;
export const VERTEX_AI_COST_GATE_MAX_ATTEMPTS = 2;

export type VertexAiCostGateEvidenceStatus = 'labeled' | 'canary' | 'unverified_fixture';

export interface VertexAiCostGateRecallEvidence {
    truePositiveCases: number;
    actualHighRiskCases: number;
    status: VertexAiCostGateEvidenceStatus;
}

export interface VertexAiCostGateBaseline {
    modelName: string;
    location?: string;
    inputTokens: number;
    outputTokens: number;
    highRiskRecallEvidence: VertexAiCostGateRecallEvidence;
}

export interface VertexAiCostGateRoute {
    route: VertexAiCostRoute;
    reason: 'high_value' | 'ambiguous' | null;
    modelName: string;
    location?: string;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    attempts: number;
}

export interface VertexAiCostGateProposed {
    routes: readonly VertexAiCostGateRoute[];
    unknownUsageRate: number;
    highRiskRecallEvidence: VertexAiCostGateRecallEvidence;
    maxOutputTokens: number;
    maxThinkingLevel: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
    maxAttempts: number;
}

export interface VertexAiCostGateFixture {
    baseline: VertexAiCostGateBaseline;
    proposed: VertexAiCostGateProposed;
}

export interface VertexAiCostGateQualityContract {
    unknownUsageRate: number;
    /** Observed ratio derived from case counts; null means the evidence is malformed. */
    highRiskRecall: number | null;
    requiredHighRiskRecall: number;
    highRiskRecallEvidenceStatus: VertexAiCostGateEvidenceStatus | null;
    defaultRouteShare: number;
    maxOutputTokens: number;
    maxThinkingLevel: VertexAiCostGateProposed['maxThinkingLevel'];
    maxAttempts: number;
}

export interface VertexAiCostGateResult {
    passed: boolean;
    baselineCostUsd: number | null;
    proposedCostUsd: number | null;
    savingsUsd: number | null;
    savingsRate: number | null;
    baselineTokens: { input: number; output: number };
    proposedTokens: { input: number; output: number };
    qualityContract: VertexAiCostGateQualityContract;
    routeCosts: readonly {
        route: VertexAiCostRoute;
        reason: 'high_value' | 'ambiguous' | null;
        modelName: string;
        inputTokens: number;
        outputTokens: number;
        costUsd: number | null;
    }[];
    violations: readonly string[];
}

function roundUsd(value: number): number {
    return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function finiteRatio(value: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= 1;
}

function tokenCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function validRecallEvidence(value: unknown): value is VertexAiCostGateRecallEvidence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const evidence = value as Partial<VertexAiCostGateRecallEvidence>;
    const truePositiveCases = evidence.truePositiveCases;
    const actualHighRiskCases = evidence.actualHighRiskCases;
    return typeof truePositiveCases === 'number'
        && Number.isSafeInteger(truePositiveCases)
        && truePositiveCases >= 0
        && typeof actualHighRiskCases === 'number'
        && Number.isSafeInteger(actualHighRiskCases)
        && actualHighRiskCases > 0
        && truePositiveCases <= actualHighRiskCases
        && (
            evidence.status === 'labeled'
            || evidence.status === 'canary'
            || evidence.status === 'unverified_fixture'
        );
}

function recallFromEvidence(
    evidence: VertexAiCostGateRecallEvidence,
): number {
    return evidence.truePositiveCases / evidence.actualHighRiskCases;
}

function estimateRoute(route: VertexAiCostGateRoute): GeminiRequestCostEstimate | null {
    try {
        return estimateGeminiRequestCostStrict(
            {
                promptTokens: route.inputTokens,
                completionTokens: route.outputTokens,
                totalTokens: route.inputTokens + route.outputTokens,
            },
            route.modelName,
            route.location ?? 'global',
        );
    } catch {
        return null;
    }
}

/**
 * Evaluate the release fixture without importing a provider client or reading credentials.
 * Violations are returned in stable code order so CI output is reproducible.
 */
export function evaluateVertexAiCostGate(
    fixture: VertexAiCostGateFixture,
): VertexAiCostGateResult {
    const violations: string[] = [];
    const baseline = fixture.baseline;
    const proposed = fixture.proposed;
    const baselineValid = tokenCount(baseline.inputTokens)
        && tokenCount(baseline.outputTokens)
        && validRecallEvidence(baseline.highRiskRecallEvidence);
    if (!baselineValid) violations.push('VERTEX_AI_BASELINE_INVALID');

    const baselineRecall = baselineValid
        ? recallFromEvidence(baseline.highRiskRecallEvidence)
        : null;
    const proposedRecallEvidenceValid = validRecallEvidence(proposed.highRiskRecallEvidence);
    if (!proposedRecallEvidenceValid) {
        violations.push('VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_INVALID');
    }
    const proposedRecall = proposedRecallEvidenceValid
        ? recallFromEvidence(proposed.highRiskRecallEvidence)
        : null;
    const requiredHighRiskRecall = baselineRecall === null
        ? VERTEX_AI_COST_GATE_MIN_HIGH_RISK_RECALL
        : baselineRecall * VERTEX_AI_COST_GATE_MIN_HIGH_RISK_RECALL;

    const baselineEstimate = baselineValid
        ? (() => {
            try {
                return estimateGeminiRequestCostStrict(
                    {
                        promptTokens: baseline.inputTokens,
                        completionTokens: baseline.outputTokens,
                        totalTokens: baseline.inputTokens + baseline.outputTokens,
                    },
                    baseline.modelName,
                    baseline.location ?? 'global',
                );
            } catch {
                return null;
            }
        })()
        : null;
    if (!baselineEstimate) violations.push('VERTEX_AI_PRICING_UNKNOWN');

    const routeCosts = proposed.routes.map(route => {
        const estimate = tokenCount(route.inputTokens) && tokenCount(route.outputTokens)
            ? estimateRoute(route)
            : null;
        if (!estimate) violations.push('VERTEX_AI_PRICING_UNKNOWN');
        if (route.route === 'default' && !isVertexAiDefaultModel(route.modelName)) {
            violations.push('VERTEX_AI_DEFAULT_MODEL_MISMATCH');
        }
        if (route.route !== 'default' && !isVertexAiEscalationModel(route.modelName)) {
            violations.push('VERTEX_AI_ESCALATION_MODEL_MISMATCH');
        }
        if (isVertexAiEscalationModel(route.modelName)
            && (route.route === 'default' || route.reason === null)) {
            violations.push('VERTEX_AI_ESCALATION_REASON_REQUIRED');
        }
        if (route.route !== 'default'
            && route.reason !== 'high_value'
            && route.reason !== 'ambiguous') {
            violations.push('VERTEX_AI_ESCALATION_REASON_REQUIRED');
        }
        if (!Number.isSafeInteger(route.calls) || route.calls < 1
            || !Number.isSafeInteger(route.attempts) || route.attempts < route.calls) {
            violations.push('VERTEX_AI_ROUTE_ATTEMPTS_INVALID');
        }
        return {
            route: route.route,
            reason: route.reason,
            modelName: route.modelName,
            inputTokens: route.inputTokens,
            outputTokens: route.outputTokens,
            costUsd: estimate?.totalCostUsd ?? null,
        };
    });

    const proposedInput = proposed.routes.reduce((sum, route) => sum + route.inputTokens, 0);
    const proposedOutput = proposed.routes.reduce((sum, route) => sum + route.outputTokens, 0);
    if (baselineValid && (
        proposedInput !== baseline.inputTokens || proposedOutput !== baseline.outputTokens
    )) {
        violations.push('VERTEX_AI_TOKEN_VOLUME_DRIFT');
    }

    const proposedCost = routeCosts.every(route => route.costUsd !== null)
        ? roundUsd(routeCosts.reduce((sum, route) => sum + (route.costUsd ?? 0), 0))
        : null;
    const baselineCost = baselineEstimate?.totalCostUsd ?? null;
    const savingsUsd = baselineCost !== null && proposedCost !== null
        ? roundUsd(baselineCost - proposedCost)
        : null;
    const savingsRate = baselineCost !== null && proposedCost !== null && baselineCost > 0
        ? (baselineCost - proposedCost) / baselineCost
        : null;
    if (savingsRate === null || savingsRate < VERTEX_AI_COST_GATE_MIN_SAVINGS_RATE) {
        violations.push('VERTEX_AI_SAVINGS_BELOW_THRESHOLD');
    }

    if (!finiteRatio(proposed.unknownUsageRate)
        || proposed.unknownUsageRate > VERTEX_AI_COST_GATE_MAX_UNKNOWN_USAGE_RATE) {
        violations.push('VERTEX_AI_UNKNOWN_USAGE_RATE_TOO_HIGH');
    }
    if (proposedRecall === null || proposedRecall < requiredHighRiskRecall) {
        violations.push('VERTEX_AI_HIGH_RISK_RECALL_TOO_LOW');
    }
    if (
        proposedRecallEvidenceValid
        && proposed.highRiskRecallEvidence.status === 'unverified_fixture'
    ) {
        violations.push('VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_UNVERIFIED');
    }

    const totalCalls = proposed.routes.reduce((sum, route) => sum + Math.max(0, route.calls), 0);
    const defaultCalls = proposed.routes
        .filter(route => route.route === 'default')
        .reduce((sum, route) => sum + Math.max(0, route.calls), 0);
    const defaultRouteShare = totalCalls > 0 ? defaultCalls / totalCalls : 0;
    if (defaultRouteShare <= 0.5) violations.push('VERTEX_AI_DEFAULT_ROUTE_NOT_MAJORITY');
    if (!Number.isSafeInteger(proposed.maxOutputTokens)
        || proposed.maxOutputTokens < 1
        || proposed.maxOutputTokens > VERTEX_AI_COST_GATE_MAX_OUTPUT_TOKENS) {
        violations.push('VERTEX_AI_OUTPUT_BUDGET_TOO_HIGH');
    }
    if (proposed.maxThinkingLevel === 'HIGH') {
        violations.push('VERTEX_AI_THINKING_BUDGET_TOO_HIGH');
    }
    if (!Number.isSafeInteger(proposed.maxAttempts)
        || proposed.maxAttempts < 1
        || proposed.maxAttempts > VERTEX_AI_COST_GATE_MAX_ATTEMPTS) {
        violations.push('VERTEX_AI_RETRY_BUDGET_TOO_HIGH');
    }

    const qualityContract: VertexAiCostGateQualityContract = {
        unknownUsageRate: proposed.unknownUsageRate,
        highRiskRecall: proposedRecall,
        requiredHighRiskRecall,
        highRiskRecallEvidenceStatus: proposedRecallEvidenceValid
            ? proposed.highRiskRecallEvidence.status
            : null,
        defaultRouteShare,
        maxOutputTokens: proposed.maxOutputTokens,
        maxThinkingLevel: proposed.maxThinkingLevel,
        maxAttempts: proposed.maxAttempts,
    };
    return {
        passed: violations.length === 0,
        baselineCostUsd: baselineCost,
        proposedCostUsd: proposedCost,
        savingsUsd,
        savingsRate,
        baselineTokens: { input: baseline.inputTokens, output: baseline.outputTokens },
        proposedTokens: { input: proposedInput, output: proposedOutput },
        qualityContract,
        routeCosts,
        violations: [...new Set(violations)],
    };
}
