import 'server-only';

import { z } from 'zod';

export const DEV_LIVE_PREFLIGHT_KEY_PREFIX = 'dev-live:';
export const DEV_LIVE_PLAN = 'basic' as const;

const maxApprovalDurationMs = 30 * 60_000;
const approvalSchema = z.object({
    id: z.string().uuid({ version: 'v4' }).transform(id => id.toLowerCase()),
    targetInstagramId: z.string().regex(/^[a-z0-9._]{1,30}$/),
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    apifyMaxCents: z.number().int().positive().max(500),
    aiMaxCents: z.number().int().positive().max(200),
}).strict();

export type DevLiveApproval = z.infer<typeof approvalSchema> & {
    idempotencyKey: string;
    nonce: string;
};

export function readDevLiveApproval(
    env: Record<string, string | undefined> = process.env,
    now = Date.now(),
): DevLiveApproval | null {
    if (env.DEV_LIVE_ANALYSIS_ARMED !== 'true' || !env.DEV_LIVE_ANALYSIS_APPROVAL) return null;
    try {
        const approval = approvalSchema.parse(JSON.parse(env.DEV_LIVE_ANALYSIS_APPROVAL));
        const startsAt = Date.parse(approval.approvedAt);
        const expiresAt = Date.parse(approval.expiresAt);
        if (!Number.isFinite(now) || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt)
            || now < startsAt || now >= expiresAt || expiresAt - startsAt > maxApprovalDurationMs) return null;
        return {
            ...approval,
            idempotencyKey: `${DEV_LIVE_PREFLIGHT_KEY_PREFIX}${approval.id}`,
            nonce: `dev-live-${approval.id}`,
        };
    } catch {
        return null;
    }
}
