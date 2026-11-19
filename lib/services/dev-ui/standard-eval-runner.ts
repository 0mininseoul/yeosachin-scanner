import { randomUUID } from 'node:crypto';
import type { AppearanceGrade } from '@/lib/domain/analysis/risk-policy';
import type { GeminiAttemptTelemetry, TokenUsage } from '@/lib/services/ai/gemini';
import { estimateGeminiRequestCostStrict } from '@/lib/services/ai/gemini-cost';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import {
    featureAnalysis,
    projectV211FeatureEvaluation,
    type FeatureAnalysisInput,
    type FeatureAnalysisResult,
    type FeatureEvalThinkingLevel,
} from '@/lib/services/ai/v2-staged-analysis';
import {
    estimateVertexAiPreDispatchCost,
    InMemoryVertexAiBudgetStore,
    type VertexAiBudgetGuard,
} from '@/lib/services/ai/vertex-ai-cost-policy';
import type { AnalysisV2AiResultIdentity } from '@/lib/services/analysis/v2-ai-result-identity';
import { calculateV2FinalScores } from '@/lib/services/analysis/v2-candidate-scoring';
import { screenAnalysisV2OfficialAccount } from '@/lib/services/analysis/v2-official-account-screening';
import { devStandardEvalBundleSchema, type DevStandardEvalBundle } from './standard-eval-types';

const BUDGET_USD = 0.67;
const MAX_INPUT_TOKENS = 32_768;
const MAX_OUTPUT_TOKENS = 8_192;
// Reserve twice the documented 560 tokens for each MEDIUM-resolution image.
const MEDIA_TOKEN_ALLOWANCE = 1_120;
const ENVELOPE_TOKEN_ALLOWANCE = 2_048;
const MODEL = 'gemini-3.7-flash';
const LOCATION = 'global';
const MEDIA_RESOLUTION = 'MEDIUM';
const RISK_POLICY = 'risk-policy-v2.5';
const LEVELS = ['HIGH', 'MEDIUM'] as const;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;
const GLOBAL_INTRODUCTORY_PRICE_END = '2027-01-01T00:00:00Z';
const GLOBAL_INTRODUCTORY_PRICE_END_MS = Date.parse(GLOBAL_INTRODUCTORY_PRICE_END);

function roundUsd(cost: number) {
    return Number(cost.toFixed(12));
}

type Sample = DevStandardEvalBundle['candidates'][number];
type Projection = ReturnType<typeof projectV211FeatureEvaluation>;
type CompletedArm = { result: FeatureAnalysisResult; usage: ReturnType<typeof safeUsage> };
type EvalRequest = Readonly<{
    ordinal: number;
    input: FeatureAnalysisInput;
    thinkingLevel: FeatureEvalThinkingLevel;
    identity: AnalysisV2AiResultIdentity;
    runId: string;
    budgetGuard: VertexAiBudgetGuard;
}>;

export type DevStandardEvalGenerate = (input: EvalRequest) => Promise<{
    result: FeatureAnalysisResult;
    tokenUsage: TokenUsage;
    latencyMs: number;
}>;

const activeNativeRequests = new WeakSet<EvalRequest>();

export const generateDevStandardEvalFeature: DevStandardEvalGenerate = async request => {
    if (!activeNativeRequests.delete(request)) {
        throw new Error('DEV_STANDARD_EVAL_NATIVE_REQUEST_UNAUTHORIZED');
    }

    let telemetry: GeminiAttemptTelemetry | undefined;
    const result = await featureAnalysis(request.input, {
        requestId: request.runId,
        operationKey: request.identity.operationKey,
        resultIdentity: request.identity,
        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
        onBeforeAttempt: attempt => {
            if (
                attempt.attempt !== 1 || attempt.retryCount !== 0 || attempt.modelName !== MODEL
                || attempt.location !== LOCATION || attempt.thinkingLevel !== request.thinkingLevel
                || attempt.mediaResolution !== MEDIA_RESOLUTION
                || attempt.maxOutputTokens !== MAX_OUTPUT_TOKENS
            ) {
                throw new Error('DEV_STANDARD_EVAL_NATIVE_OPTIONS_INVALID');
            }
        },
        onAttemptTelemetry: attempt => {
            if (telemetry) throw new Error('DEV_STANDARD_EVAL_MULTIPLE_ATTEMPTS');
            telemetry = attempt;
        },
        budgetGuard: request.budgetGuard,
    }, {
        aiStagePolicyVersion: AI_STAGE_POLICY_V211_VERSION,
        replayCapability: issueReplayStatelessCapability(),
        replayThinkingLevel: request.thinkingLevel,
    });

    if (
        telemetry?.disposition !== 'success' || telemetry.attempt !== 1 || telemetry.retryCount !== 0
        || telemetry.usageMetadataStatus !== 'complete' || !telemetry.tokenUsage
        || telemetry.modelName !== MODEL || telemetry.location !== LOCATION
        || telemetry.thinkingLevel !== request.thinkingLevel || telemetry.mediaResolution !== MEDIA_RESOLUTION
        || telemetry.maxOutputTokens !== MAX_OUTPUT_TOKENS
    ) {
        throw new Error('DEV_STANDARD_EVAL_USAGE_UNVERIFIED');
    }
    return { result, tokenUsage: telemetry.tokenUsage, latencyMs: telemetry.latencyMs };
};

function featureEvidence(result: FeatureAnalysisResult, input: FeatureAnalysisInput, independentPartner?: 'weak' | 'strong') {
    const feature = result.features;
    const accountContext = feature.accountContext === 'official_group_or_brand'
        ? screenAnalysisV2OfficialAccount({
            modelAccountContext: feature.accountContext,
            fullName: input.accountProfile?.fullName ?? null,
            bio: input.bio,
        }).accountContext
        : feature.accountContext;
    const hasStrongPartnerEvidence = independentPartner === 'strong' || (feature.partnerExclusionContext === 'none'
        && (feature.marriageEvidence === 'strong' || feature.partnerEvidence === 'strong'));
    const hasWeakPartnerEvidence = !hasStrongPartnerEvidence && (independentPartner === 'weak'
        || (feature.partnerExclusionContext === 'none'
            && (feature.marriageEvidence === 'possible' || feature.partnerEvidence === 'weak')));
    return {
        appearanceGrade: feature.appearanceGrade as AppearanceGrade,
        exposureScore: feature.exposureScore,
        accountContext,
        hasStrongPartnerEvidence,
        hasWeakPartnerEvidence,
    };
}

function scoresFor(bundle: DevStandardEvalBundle, replacements?: ReadonlyMap<string, ReturnType<typeof featureEvidence> | null>) {
    const preliminary = bundle.preliminary.flatMap(row => {
        const replacement = replacements?.get(row.candidateId);
        if (replacement === null) return [];
        return [{ ...row, ...replacement }];
    });
    const included = new Set(preliminary.map(row => row.candidateId));
    return calculateV2FinalScores({
        preliminary,
        observedReverseLikeCandidateIds: new Set(bundle.observed.filter(id => included.has(id))),
        notCollectedCandidateIds: new Set(bundle.notCollected.filter(id => included.has(id))),
        riskPolicyVersion: RISK_POLICY,
    });
}

function checkBaseline(bundle: DevStandardEvalBundle) {
    const baseline = scoresFor(bundle);
    const ids = new Set(bundle.originalHighRiskIds);
    const computedIds = baseline.filter(row => row.riskBand === 'high_risk').map(row => row.candidateId);
    if (computedIds.length !== ids.size || computedIds.some(id => !ids.has(id))) {
        throw new Error('DEV_STANDARD_EVAL_BASELINE_MISMATCH');
    }
    return baseline;
}

function checkProjection(sample: Sample, projection: Projection) {
    const { identity } = projection;
    if (
        identity.modelName !== MODEL || identity.maxOutputTokens !== MAX_OUTPUT_TOKENS
        || identity.mediaResolution !== MEDIA_RESOLUTION || projection.mediaCount < 1
    ) {
        throw new Error('DEV_STANDARD_EVAL_FEATURE_POLICY_INVALID');
    }
    const originalResult = projection.validateResult(sample.featureResult);
    if (originalResult.finalGenderDecision !== 'verified_female') {
        throw new Error('DEV_STANDARD_EVAL_BASELINE_MISMATCH');
    }
}

function requestBudgetGuard(
    ledger: InMemoryVertexAiBudgetStore,
    request: Pick<EvalRequest, 'identity' | 'runId'>,
): VertexAiBudgetGuard {
    return {
        reserve(input) {
            if (
                input.runId !== request.runId || input.operationKey !== request.identity.operationKey
                || input.reservationKey !== `${request.runId}:${request.identity.operationKey}:1`
                || input.orderId != null || input.route !== 'high_value'
                || input.attempt !== 1 || input.modelName !== MODEL || input.location !== LOCATION
                || input.maxOutputTokens !== MAX_OUTPUT_TOKENS || input.inputTokens > MAX_INPUT_TOKENS
            ) {
                throw new Error('DEV_STANDARD_EVAL_RESERVATION_INVALID');
            }
            return ledger.reserve({ ...input, inputTokens: MAX_INPUT_TOKENS });
        },
        settle: (reservation, input) => ledger.settle(reservation, input),
        cancel: reservation => ledger.cancel(reservation),
        snapshot: () => ledger.snapshot(),
    };
}

function safeUsage(tokenUsage: TokenUsage, latencyMs: number) {
    const { promptTokens, completionTokens, thinkingTokens, totalTokens } = tokenUsage;
    if (
        [promptTokens, completionTokens, totalTokens, thinkingTokens ?? 0]
            .some(value => !Number.isSafeInteger(value) || value < 0)
        || promptTokens < 1 || totalTokens < promptTokens + completionTokens
        || (thinkingTokens !== undefined && totalTokens !== promptTokens + completionTokens + thinkingTokens)
        || !Number.isFinite(latencyMs) || latencyMs < 0
    ) {
        throw new Error('DEV_STANDARD_EVAL_USAGE_UNVERIFIED');
    }
    const cost = estimateGeminiRequestCostStrict(tokenUsage, MODEL, LOCATION);
    if (cost.inputTokens > MAX_INPUT_TOKENS || cost.outputTokens > MAX_OUTPUT_TOKENS) {
        throw new Error('DEV_STANDARD_EVAL_USAGE_OVER_RESERVATION');
    }
    return {
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        completionTokens,
        totalTokens,
        thinkingTokens: thinkingTokens ?? Math.max(0, totalTokens - promptTokens - completionTokens),
        estimatedCostUsd: cost.totalCostUsd,
        estimatedCurrentRateUsd: Date.now() < GLOBAL_INTRODUCTORY_PRICE_END_MS
            ? roundUsd((cost.inputTokens * 0.75 + cost.outputTokens * 3.75) / 1_000_000)
            : cost.totalCostUsd,
        latencyMs: Math.round(latencyMs),
    };
}

export async function runDevStandardEval({ bundle: rawBundle, generate, beforeDispatch }: {
    bundle: unknown;
    generate: DevStandardEvalGenerate;
    beforeDispatch?: () => void | Promise<void>;
}) {
    const parsed = devStandardEvalBundleSchema.safeParse(rawBundle);
    if (!parsed.success) throw new Error('DEV_STANDARD_EVAL_BUNDLE_INVALID');
    const bundle = parsed.data;
    if (bundle.expiresAt > Date.now() + MAX_CAPTURE_AGE_MS) throw new Error('DEV_STANDARD_EVAL_BUNDLE_INVALID');
    const partnerById = new Map(bundle.partnerOverrides.map(row => [row.candidateId, row.evidence]));
    const checkExpiry = () => {
        if (bundle.expiresAt <= Date.now()) throw new Error('DEV_STANDARD_EVAL_BUNDLE_EXPIRED');
    };
    checkExpiry();
    let baseline: ReturnType<typeof checkBaseline>;
    let reservations;
    try {
        baseline = checkBaseline(bundle);
        const sampledBaseline = new Map(baseline.map(row => [row.candidateId, row]));
        reservations = bundle.candidates.map((sample, index) => {
            const high = projectV211FeatureEvaluation(sample.input, 'HIGH');
            const medium = projectV211FeatureEvaluation(sample.input, 'MEDIUM');
            checkProjection(sample, high);
            if (
                high.identity.operationKey !== sample.featureOperationKey
                || high.identity.operationKey === medium.identity.operationKey
                || high.identity.inputHash !== medium.identity.inputHash
                || high.identity.mediaSnapshotHash !== medium.identity.mediaSnapshotHash
            ) {
                throw new Error('DEV_STANDARD_EVAL_INPUT_MISMATCH');
            }
            const row = sampledBaseline.get(sample.candidateId);
            const stored = featureEvidence(sample.featureResult, sample.input, partnerById.get(sample.candidateId));
            if (
                !row || row.appearanceGrade !== stored.appearanceGrade || row.exposureScore !== stored.exposureScore
                || row.accountContext !== stored.accountContext
                || row.hasWeakPartnerEvidence !== stored.hasWeakPartnerEvidence
                || row.hasStrongPartnerEvidence !== stored.hasStrongPartnerEvidence
            ) {
                throw new Error('DEV_STANDARD_EVAL_BASELINE_MISMATCH');
            }
            // Estimate the retained text and image envelope before any model operation.
            // Measured usage may be lower, but may not authorize extra attempts or cases.
            const inputEnvelope = high.promptUtf8Bytes + high.responseSchemaUtf8Bytes
                + high.mediaCount * MEDIA_TOKEN_ALLOWANCE + ENVELOPE_TOKEN_ALLOWANCE;
            if (inputEnvelope > MAX_INPUT_TOKENS) throw new Error('DEV_STANDARD_EVAL_BUDGET_EXCEEDED');
            return { sample, ordinal: index + 1, high, medium };
        });
        if (new Set(reservations.map(row => row.high.identity.operationKey)).size !== reservations.length) {
            throw new Error('DEV_STANDARD_EVAL_DUPLICATE_INPUT');
        }
    } catch (error) {
        if (error instanceof Error && /^DEV_STANDARD_EVAL_[A-Z_]+$/.test(error.message)) throw error;
        throw new Error('DEV_STANDARD_EVAL_BUNDLE_INVALID');
    }
    const reservedPerAttempt = estimateVertexAiPreDispatchCost({
        modelName: MODEL, location: LOCATION, inputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS,
    }).totalCostUsd;
    const reservedUpperUsd = roundUsd(reservations.length * LEVELS.length * reservedPerAttempt);
    if (reservedUpperUsd > BUDGET_USD) throw new Error('DEV_STANDARD_EVAL_BUDGET_EXCEEDED');
    if (generate === generateDevStandardEvalFeature && !beforeDispatch) {
        throw new Error('DEV_STANDARD_EVAL_NATIVE_REQUEST_UNAUTHORIZED');
    }
    checkExpiry();
    await beforeDispatch?.();

    const runId = randomUUID();
    const ledger = new InMemoryVertexAiBudgetStore({ perRunUsd: BUDGET_USD, perOrderUsd: BUDGET_USD, dailyUsd: BUDGET_USD });
    const results: Record<FeatureEvalThinkingLevel, Map<string, CompletedArm>> = { HIGH: new Map(), MEDIUM: new Map() };
    for (const reservation of reservations) {
        const { sample, ordinal, high, medium } = reservation;
        // Balance first-arm order while keeping calls serial and reproducible.
        const order = ordinal % 2 === 0 ? [...LEVELS].reverse() : LEVELS;
        for (const thinkingLevel of order) {
            checkExpiry();
            const projection = thinkingLevel === 'HIGH' ? high : medium;
            const request: EvalRequest = Object.freeze({
                ordinal, input: sample.input, thinkingLevel, identity: projection.identity, runId,
                budgetGuard: requestBudgetGuard(ledger, { identity: projection.identity, runId }),
            });
            let generated;
            if (beforeDispatch) activeNativeRequests.add(request);
            try {
                generated = await generate(request);
            } catch {
                throw new Error('DEV_STANDARD_EVAL_GENERATION_FAILED');
            } finally {
                activeNativeRequests.delete(request);
            }
            try {
                const result = projection.validateResult(generated.result);
                const usage = safeUsage(generated.tokenUsage, generated.latencyMs);
                results[thinkingLevel].set(sample.candidateId, { result, usage });
            } catch (error) {
                if (error instanceof Error && /^DEV_STANDARD_EVAL_USAGE_[A-Z_]+$/.test(error.message)) throw error;
                throw new Error('DEV_STANDARD_EVAL_FEATURE_RESULT_MISMATCH');
            }
        }
    }

    const compare = (level: FeatureEvalThinkingLevel) => {
        const replacements = new Map(bundle.candidates.map(sample => {
            const { result } = results[level].get(sample.candidateId)!;
            return [sample.candidateId, result.finalGenderDecision === 'verified_female'
                ? featureEvidence(result, sample.input, partnerById.get(sample.candidateId)) : null];
        }));
        const scores = scoresFor(bundle, replacements);
        const byId = new Map(scores.map(row => [row.candidateId, row.riskBand]));
        const usage = [...results[level].values()].map(row => row.usage);
        return {
            summary: {
                cohortSize: scores.length,
                featureEligibleCount: bundle.candidates.filter(sample => byId.has(sample.candidateId)).length,
                highRiskCount: scores.filter(row => row.riskBand === 'high_risk').length,
                estimatedCostUsd: roundUsd(usage.reduce((sum, row) => sum + row.estimatedCostUsd, 0)),
                estimatedCurrentRateUsd: roundUsd(usage.reduce((sum, row) => sum + row.estimatedCurrentRateUsd, 0)),
            },
            candidate(sample: Sample) {
                return {
                    riskBand: byId.get(sample.candidateId) ?? null,
                    usage: results[level].get(sample.candidateId)!.usage,
                };
            },
        };
    };
    const high = compare('HIGH');
    const medium = compare('MEDIUM');
    const original = new Map(baseline.map(row => [row.candidateId, row.riskBand]));
    const pairs = reservations.map(({ ordinal, sample }) => ({
        ordinal,
        originalRiskBand: original.get(sample.candidateId)!,
        high: high.candidate(sample),
        medium: medium.candidate(sample),
    }));
    return {
        cohortSize: bundle.preliminary.length,
        reservedUpperUsd,
        introductoryRateEndsAt: GLOBAL_INTRODUCTORY_PRICE_END,
        arms: { high: high.summary, medium: medium.summary },
        estimatedCurrentRateSavingsUsd: roundUsd(high.summary.estimatedCurrentRateUsd - medium.summary.estimatedCurrentRateUsd),
        highRiskMissingAtMedium: pairs.filter(pair => pair.high.riskBand === 'high_risk' && pair.medium.riskBand !== 'high_risk')
            .map(pair => pair.ordinal),
        pairs,
    };
}
