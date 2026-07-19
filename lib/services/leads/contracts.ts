import { z } from 'zod';
import { isJsonRequest, isSameOriginMutation } from '@/lib/services/earlybird/contracts';

export { isJsonRequest, isSameOriginMutation };

// pending-analysis-target 의 TARGET_PATTERN 과 동일한 인스타 아이디 규칙.
const TARGET_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export function normalizeLeadInstagramId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^@+/, '').toLowerCase();
    if (!TARGET_PATTERN.test(normalized)) return null;
    if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) {
        return null;
    }
    return normalized;
}

const attributionSchema = z.object({
    source: z.string().max(64).optional(),
    medium: z.string().max(64).optional(),
    campaign: z.string().max(64).optional(),
    content: z.string().max(64).optional(),
    term: z.string().max(64).optional(),
}).optional();

export const landingLeadRequestSchema = z.object({
    instagramId: z.string().min(1).max(100),
    rawInput: z.string().max(100).optional(),
    attribution: attributionSchema,
    referrer: z.string().max(500).optional(),
});

export type LandingLeadRequest = z.infer<typeof landingLeadRequestSchema>;
