import { z } from 'zod';
import { isJsonRequest, isSameOriginMutation } from '@/lib/services/earlybird/contracts';

export { isJsonRequest, isSameOriginMutation };

/** Mirrors the CHECK constraint on result_feedback.body. */
export const RESULT_FEEDBACK_MAX_LENGTH = 1000;

export const resultFeedbackRequestSchema = z.object({
    requestId: z.string().uuid(),
    body: z.string().min(1).max(RESULT_FEEDBACK_MAX_LENGTH),
}).strict();

export type ResultFeedbackRequest = z.infer<typeof resultFeedbackRequestSchema>;

/** Returns the trimmed body, or null when it carries no actual content. */
export function normalizeResultFeedbackBody(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > RESULT_FEEDBACK_MAX_LENGTH) return null;
    return trimmed;
}
