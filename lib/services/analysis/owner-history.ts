import { z } from 'zod';

const instagramUsernameSchema = z.string()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9._]+$/);

const ownerAnalysisHistoryItemV1Schema = z.object({
    id: z.string().uuid(),
    targetInstagramId: instagramUsernameSchema.nullable(),
    status: z.enum(['pending', 'processing', 'completed', 'failed']),
    createdAt: z.string().datetime({ offset: true }).nullable(),
    planType: z.string().min(1).max(20).regex(/^[a-z0-9_-]+$/).nullable(),
    pipelineVersion: z.enum(['v1', 'v2']),
}).strict().superRefine((item, context) => {
    if (
        item.pipelineVersion === 'v2'
        && item.targetInstagramId?.toLowerCase().startsWith('retained.')
    ) {
        context.addIssue({
            code: 'custom',
            message: 'V2 request tombstones cannot be exposed as owner history usernames.',
            path: ['targetInstagramId'],
        });
    }
});

export const ownerAnalysisHistoryV1Schema = z.object({
    schemaVersion: z.literal(1),
    items: z.array(ownerAnalysisHistoryItemV1Schema),
}).strict();

export type OwnerAnalysisHistoryItemV1 = z.infer<typeof ownerAnalysisHistoryItemV1Schema>;

export function ownerHistoryTargetLabel(item: OwnerAnalysisHistoryItemV1): string {
    return item.targetInstagramId ? `@${item.targetInstagramId}` : '보호 처리된 계정';
}
