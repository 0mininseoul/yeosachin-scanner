import { z } from 'zod';
import { storedAnalysisResultPageV1Schema } from './analysis-v2';

const candidateCount = z.number().int().min(0).max(10);
export const replayScopeDeltaSchema = z.object({
    added: candidateCount,
    removed: candidateCount,
    unverified: candidateCount,
}).strict().refine(({ added, removed, unverified }) =>
    added + unverified <= 10 && removed + unverified <= 10 && added + removed + unverified > 0,
);

export type ReplayScopeDelta = z.infer<typeof replayScopeDeltaSchema>;

export const devStandardOwnerResultPageSchema = storedAnalysisResultPageV1Schema.safeExtend({
    replayScopeDelta: replayScopeDeltaSchema.optional(),
}).refine(page => !page.replayScopeDelta || page.summary.planId === 'standard');
