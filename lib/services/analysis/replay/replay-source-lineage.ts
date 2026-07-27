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
