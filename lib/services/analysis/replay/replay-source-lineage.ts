import { z } from 'zod';

const pipeline = z.literal('v2');

/**
 * Historical source lineage accepted for capture. This is intentionally separate
 * from the current AI policy selected by the stateless replay adapter.
 */
export const replaySourceLineageSchema = z.discriminatedUnion('selectedPlanId', [
    z.object({
        selectedPlanId: z.literal('standard'),
        policyVersions: z.object({
            pipeline,
            aiStage: z.literal('ai-stage-policy-v2.7'),
            risk: z.enum(['risk-policy-v2.3', 'risk-policy-v2.4']),
        }).passthrough(),
    }).strict(),
    z.object({
        selectedPlanId: z.literal('plus'),
        policyVersions: z.object({
            pipeline,
            aiStage: z.literal('ai-stage-policy-v2.4'),
            risk: z.literal('risk-policy-v2.2'),
        }).passthrough(),
    }).strict(),
]);

export type ReplaySourceLineage = z.infer<typeof replaySourceLineageSchema>;
