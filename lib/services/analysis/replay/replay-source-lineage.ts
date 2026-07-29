import { z } from 'zod';
import {
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V211_VERSION,
    AI_STAGE_POLICY_V212_VERSION,
    AI_STAGE_POLICY_V213_VERSION,
    AI_STAGE_POLICY_V214_VERSION,
    AI_STAGE_POLICY_V215_VERSION,
    AI_STAGE_POLICY_V216_VERSION,
    AI_STAGE_POLICY_V217_VERSION,
    type AiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';

const pipeline = z.literal('v2');
/** Immutable historical replay lineage; never alias this to the moving latest policy. */
export const AI_STAGE_POLICY_V27_VERSION = 'ai-stage-policy-v2.7' as const;

/**
 * Historical source lineage accepted for capture. This is intentionally separate
 * from the current AI policy selected by the stateless replay adapter.
 */
const standardV27PolicySchema = z.object({
    pipeline,
    aiStage: z.literal(AI_STAGE_POLICY_V27_VERSION),
    risk: z.enum(['risk-policy-v2.3', 'risk-policy-v2.4']),
    scheduler: z.literal('ai-scheduler-v1').optional(),
}).strict();

const standardV28PolicySchema = z.object({
    pipeline,
    aiStage: z.literal(AI_STAGE_POLICY_V28_VERSION),
    risk: z.literal('risk-policy-v2.4'),
    scheduler: z.literal('ai-scheduler-v1'),
}).strict();

const standardV29PolicySchema = z.object({
    pipeline,
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
    risk: z.literal('risk-policy-v2.4'),
    scheduler: z.literal('ai-scheduler-v1'),
}).strict();

/**
 * Source lineage is deliberately exact. Historical v2.7 snapshots predate the
 * scheduler key, so that key is optional only for v2.7. v2.8 starts after the
 * scheduler rollout and must carry its exact four-key snapshot.
 */
export const replaySourceLineageSchema = z.union([
    z.object({
        selectedPlanId: z.literal('standard'),
        policyVersions: standardV27PolicySchema,
    }).strict(),
    z.object({
        selectedPlanId: z.literal('standard'),
        policyVersions: standardV28PolicySchema,
    }).strict(),
    z.object({
        selectedPlanId: z.literal('standard'),
        policyVersions: standardV29PolicySchema,
    }).strict(),
    z.object({
        selectedPlanId: z.literal('plus'),
        policyVersions: z.object({
            pipeline,
            aiStage: z.literal('ai-stage-policy-v2.4'),
            risk: z.literal('risk-policy-v2.2'),
        }).strict(),
    }).strict(),
]);

export type ReplaySourceLineage = z.infer<typeof replaySourceLineageSchema>;

export const REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY =
    'standard-v27-v28-risk-v24-scheduler-v1-to-ai-v29' as const;
export const HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY =
    'historical-official-e2e-standard-v27-risk-v23-to-ai-v29' as const;
/** v2.10 is a distinct historical evaluation fence, never a v2.9 alias. */
export const HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY =
    'historical-official-e2e-standard-v27-risk-v23-to-ai-v210' as const;
/** Explicitly sealed non-exact historical media-availability audit capability. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v29' as const;
/** Distinct non-exact historical evaluation fence for the v2.10 successor. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v210' as const;
/** Evaluation-only v2.11 gender-quality fence; never a production policy alias. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v211-gender-quality' as const;
export const HISTORICAL_OFFICIAL_E2E_REPLAY_V211_CAPABILITY =
    'historical-official-e2e-standard-v27-risk-v23-to-ai-v211-gender-quality' as const;
/** v2.12 is a separately sealed successor; neither v2.11 capability authenticates it. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality' as const;
export const HISTORICAL_OFFICIAL_E2E_REPLAY_V212_CAPABILITY =
    'historical-official-e2e-standard-v27-risk-v23-to-ai-v212-gender-quality' as const;
/** Evaluation-only HIGH-resolution feature shadow rescue over a v2.12 control. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V213_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow' as const;
/** Evaluation-only feature-model shadow rescue over the same v2.12 control. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V214_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v214-feature-model-shadow' as const;
/** Evaluation-only feature output-cap shadow rescue over the same v2.12 control. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V215_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v215-feature-output-cap-shadow' as const;
/** Evaluation-only single-profile feature admission shadow over v2.15. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V216_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v216-single-profile-admission-shadow' as const;
/** Evaluation-only public name and existing-visual agreement shadow over v2.12. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V217_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v217-public-name-visual-fusion-shadow' as const;
const currentEvaluationPolicySchema = z.object({
    capability: z.literal(REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
}).strict();
const historicalOfficialE2EEvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
}).strict();
const historicalOfficialE2EV210EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V210_VERSION),
}).strict();
const historicalPartialAvailableEvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
}).strict();
const historicalPartialAvailableV210EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V210_VERSION),
}).strict();
const historicalPartialAvailableV211EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V211_VERSION),
}).strict();
const historicalOfficialE2EV211EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_OFFICIAL_E2E_REPLAY_V211_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V211_VERSION),
}).strict();
const historicalPartialAvailableV212EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V212_VERSION),
}).strict();
const historicalOfficialE2EV212EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_OFFICIAL_E2E_REPLAY_V212_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V212_VERSION),
}).strict();
const historicalPartialAvailableV213EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V213_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V213_VERSION),
}).strict();
const historicalPartialAvailableV214EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V214_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V214_VERSION),
}).strict();
const historicalPartialAvailableV215EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V215_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V215_VERSION),
}).strict();
const historicalPartialAvailableV216EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V216_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V216_VERSION),
}).strict();
const historicalPartialAvailableV217EvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V217_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V217_VERSION),
}).strict();
export const replayEvaluationPolicySchema = z.union([
    currentEvaluationPolicySchema,
    historicalOfficialE2EEvaluationPolicySchema,
    historicalOfficialE2EV210EvaluationPolicySchema,
    historicalPartialAvailableEvaluationPolicySchema,
    historicalPartialAvailableV210EvaluationPolicySchema,
    historicalPartialAvailableV211EvaluationPolicySchema,
    historicalOfficialE2EV211EvaluationPolicySchema,
    historicalPartialAvailableV212EvaluationPolicySchema,
    historicalOfficialE2EV212EvaluationPolicySchema,
    historicalPartialAvailableV213EvaluationPolicySchema,
    historicalPartialAvailableV214EvaluationPolicySchema,
    historicalPartialAvailableV215EvaluationPolicySchema,
    historicalPartialAvailableV216EvaluationPolicySchema,
    historicalPartialAvailableV217EvaluationPolicySchema,
]);
export type ReplayEvaluationPolicy = z.infer<typeof replayEvaluationPolicySchema>;

export type ReplaySupportedAiStagePolicyVersion = Extract<
    AiStagePolicyVersion,
    | typeof AI_STAGE_POLICY_V27_VERSION
    | typeof AI_STAGE_POLICY_V28_VERSION
    | typeof AI_STAGE_POLICY_V29_VERSION
    | typeof AI_STAGE_POLICY_V210_VERSION
    | typeof AI_STAGE_POLICY_V211_VERSION
    | typeof AI_STAGE_POLICY_V212_VERSION
    | typeof AI_STAGE_POLICY_V213_VERSION
    | typeof AI_STAGE_POLICY_V214_VERSION
    | typeof AI_STAGE_POLICY_V215_VERSION
    | typeof AI_STAGE_POLICY_V216_VERSION
    | typeof AI_STAGE_POLICY_V217_VERSION
>;

/**
 * A paid replay must use the policy frozen into its authenticated bundle. This
 * intentionally refuses older read-only lineage rather than substituting the
 * ambient latest policy.
 */
export function replayAiStagePolicyVersion(
    lineage: ReplaySourceLineage,
): ReplaySupportedAiStagePolicyVersion {
    const version = lineage.policyVersions.aiStage;
    if (
        version === AI_STAGE_POLICY_V27_VERSION
        || version === AI_STAGE_POLICY_V28_VERSION
        || version === AI_STAGE_POLICY_V29_VERSION
    ) {
        return version;
    }
    throw new Error('ANALYSIS_V2_REPLAY_AI_POLICY_UNSUPPORTED');
}

export function resolveReplayAiStagePolicyVersion(
    lineage: ReplaySourceLineage,
    evaluationPolicy?: ReplayEvaluationPolicy,
): ReplaySupportedAiStagePolicyVersion {
    if (!evaluationPolicy) return replayAiStagePolicyVersion(lineage);
    const parsed = replayEvaluationPolicySchema.safeParse(evaluationPolicy);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    }
    const policy = lineage.policyVersions;
    // The historical v2.7/risk-v2.3 snapshot predates risk/scheduler telemetry;
    // that missing telemetry does not change the replayed AI semantics.
    if (
        parsed.data.capability === HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY
        || parsed.data.capability === HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY
        || parsed.data.capability === HISTORICAL_OFFICIAL_E2E_REPLAY_V211_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY
        || parsed.data.capability === HISTORICAL_OFFICIAL_E2E_REPLAY_V212_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V213_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V214_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V215_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V216_CAPABILITY
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V217_CAPABILITY
    ) {
        if (
            lineage.selectedPlanId !== 'standard'
            || policy.pipeline !== 'v2'
            || policy.risk !== 'risk-policy-v2.3'
            || policy.aiStage !== AI_STAGE_POLICY_V27_VERSION
            || 'scheduler' in policy
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_EVALUATION_SOURCE_INELIGIBLE');
        }
        return parsed.data.aiStage;
    }
    if (
        lineage.selectedPlanId !== 'standard'
        || policy.pipeline !== 'v2'
        || policy.risk !== 'risk-policy-v2.4'
        || !('scheduler' in policy)
        || policy.scheduler !== 'ai-scheduler-v1'
        || (
            policy.aiStage !== AI_STAGE_POLICY_V27_VERSION
            && policy.aiStage !== AI_STAGE_POLICY_V28_VERSION
        )
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_EVALUATION_SOURCE_INELIGIBLE');
    }
    return parsed.data.aiStage;
}
