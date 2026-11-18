import 'server-only';

import { z } from 'zod';

export const DEV_LIVE_PREFLIGHT_KEY_PREFIX = 'dev-live:';
export const DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX = 'dev-live:owner:';
export const DEV_LIVE_OWNER_START_ATTEMPT = 'x-dev-live-attempt-id';
export const DEV_LIVE_OWNER_CAPS = Object.freeze({ apifyMaxCents: 500, aiMaxCents: 200 });
export const DEV_LIVE_PLAN = 'basic' as const;

const maxApprovalDurationMs = 30 * 60_000;
export const devLiveApprovalId = z.string().uuid({ version: 'v4' }).transform(id => id.toLowerCase());
const approvalSchema = z.object({
    id: devLiveApprovalId,
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

export function devLiveOwnerStartEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.DEV_LIVE_ANALYSIS_ARMED === 'true' && env.DEV_LIVE_ANALYSIS_MODE === 'owner_start';
}

function activeApproval(value: unknown, prefix: string, now: number): DevLiveApproval | null {
    const parsed = approvalSchema.safeParse(value);
    if (!parsed.success) return null;
    const approval = parsed.data;
    const startsAt = Date.parse(approval.approvedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt)
        || now < startsAt || now >= expiresAt || expiresAt - startsAt > maxApprovalDurationMs) return null;
    return {
        ...approval,
        idempotencyKey: prefix + approval.id,
        nonce: `dev-live-${approval.id}`,
    };
}

export function parseDevLiveOwnerApproval(value: unknown, now = Date.now()): DevLiveApproval | null {
    const approval = activeApproval(value, DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX, now);
    return approval?.apifyMaxCents === DEV_LIVE_OWNER_CAPS.apifyMaxCents
        && approval.aiMaxCents === DEV_LIVE_OWNER_CAPS.aiMaxCents ? approval : null;
}

export function readDevLiveApproval(
    env: Record<string, string | undefined> = process.env,
    now = Date.now(),
): DevLiveApproval | null {
    if (env.DEV_LIVE_ANALYSIS_ARMED !== 'true' || env.DEV_LIVE_ANALYSIS_MODE !== undefined
        || !env.DEV_LIVE_ANALYSIS_APPROVAL) return null;
    try {
        return activeApproval(JSON.parse(env.DEV_LIVE_ANALYSIS_APPROVAL), DEV_LIVE_PREFLIGHT_KEY_PREFIX, now);
    } catch {
        return null;
    }
}
