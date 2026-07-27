import { z } from 'zod';
import {
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
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
/** Explicitly sealed non-exact historical media-availability audit capability. */
export const HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY =
    'historical-partial-available-standard-v27-risk-v23-to-ai-v29' as const;
const currentEvaluationPolicySchema = z.object({
    capability: z.literal(REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
}).strict();
const historicalOfficialE2EEvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
}).strict();
const historicalPartialAvailableEvaluationPolicySchema = z.object({
    capability: z.literal(HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY),
    aiStage: z.literal(AI_STAGE_POLICY_V29_VERSION),
}).strict();
export const replayEvaluationPolicySchema = z.union([
    currentEvaluationPolicySchema,
    historicalOfficialE2EEvaluationPolicySchema,
    historicalPartialAvailableEvaluationPolicySchema,
]);
export type ReplayEvaluationPolicy = z.infer<typeof replayEvaluationPolicySchema>;

export type ReplaySupportedAiStagePolicyVersion = Extract<
    AiStagePolicyVersion,
    | typeof AI_STAGE_POLICY_V27_VERSION
    | typeof AI_STAGE_POLICY_V28_VERSION
    | typeof AI_STAGE_POLICY_V29_VERSION
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
        || parsed.data.capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY
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
