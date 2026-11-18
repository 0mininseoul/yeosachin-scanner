import 'server-only';

import { z } from 'zod';

export const DEV_LIVE_PREFLIGHT_KEY_PREFIX = 'dev-live:';
export const DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX = 'dev-live:owner:';
export const DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX = 'dev-live:owner:standard:';
export const DEV_LIVE_OWNER_START_ATTEMPT = 'x-dev-live-attempt-id';
export const DEV_LIVE_OWNER_CAPS = Object.freeze({ apifyMaxCents: 500, aiMaxCents: 200 });
const STANDARD_OWNER_CAPS = Object.freeze({ apifyMaxCents: 600, aiMaxCents: 400 });
export const DEV_LIVE_RUNNER_PLAN = 'basic' as const;
export type DevLivePlan = 'basic' | 'standard';

const instagramIdSchema = z.string().regex(/^[a-z0-9._]{1,30}$/);
export const devLiveApprovalId = z.string().uuid({ version: 'v4' }).transform(id => id.toLowerCase());
const approvalFields = {
    id: devLiveApprovalId,
    targetInstagramId: instagramIdSchema,
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
};
const basicApprovalSchema = z.object({
    ...approvalFields,
    apifyMaxCents: z.number().int().positive().max(DEV_LIVE_OWNER_CAPS.apifyMaxCents),
    aiMaxCents: z.number().int().positive().max(DEV_LIVE_OWNER_CAPS.aiMaxCents),
}).strict();
const standardApprovalSchema = z.object({
    ...approvalFields,
    planId: z.literal('standard'),
    apifyMaxCents: z.literal(STANDARD_OWNER_CAPS.apifyMaxCents),
    aiMaxCents: z.literal(STANDARD_OWNER_CAPS.aiMaxCents),
}).strict();

export type DevLiveApproval = z.infer<typeof basicApprovalSchema> & {
    planId: DevLivePlan;
    idempotencyKey: string;
    nonce: string;
};

export function devLiveOwnerStartEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.DEV_LIVE_ANALYSIS_ARMED === 'true' && env.DEV_LIVE_ANALYSIS_MODE === 'owner_start';
}

export function devLiveStandardTarget(env: Record<string, string | undefined> = process.env): string | null {
    if (!devLiveOwnerStartEnabled(env)) return null;
    const target = instagramIdSchema.safeParse(env.DEV_LIVE_STANDARD_TARGET);
    return target.success ? target.data : null;
}

function activeApproval(value: unknown, planId: DevLivePlan, prefix: string, now: number): DevLiveApproval | null {
    const parsed = (planId === 'standard' ? standardApprovalSchema : basicApprovalSchema).safeParse(value);
    if (!parsed.success) return null;
    const approval = parsed.data;
    const startsAt = Date.parse(approval.approvedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    const maxApprovalDurationMs = (planId === 'standard' ? 150 : 30) * 60_000;
    if (!Number.isFinite(now) || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt)
        || now < startsAt || now >= expiresAt || expiresAt - startsAt > maxApprovalDurationMs) return null;
    return {
        ...approval,
        planId,
        idempotencyKey: prefix + approval.id,
        nonce: `dev-live-${approval.id}`,
    };
}

export function parseDevLiveOwnerApproval(value: unknown, now = Date.now()): DevLiveApproval | null {
    const approval = activeApproval(value, 'basic', DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX, now);
    return approval?.apifyMaxCents === DEV_LIVE_OWNER_CAPS.apifyMaxCents
        && approval.aiMaxCents === DEV_LIVE_OWNER_CAPS.aiMaxCents ? approval : null;
}

export function parseDevLiveStandardApproval(value: unknown, targetInstagramId: string, now = Date.now()): DevLiveApproval | null {
    const approval = activeApproval(value, 'standard', DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX, now);
    return approval?.targetInstagramId === targetInstagramId ? approval : null;
}

export function readDevLiveApproval(
    env: Record<string, string | undefined> = process.env,
    now = Date.now(),
): DevLiveApproval | null {
    if (env.DEV_LIVE_ANALYSIS_ARMED !== 'true' || env.DEV_LIVE_ANALYSIS_MODE !== undefined
        || !env.DEV_LIVE_ANALYSIS_APPROVAL) return null;
    try {
        return activeApproval(JSON.parse(env.DEV_LIVE_ANALYSIS_APPROVAL), 'basic', DEV_LIVE_PREFLIGHT_KEY_PREFIX, now);
    } catch {
        return null;
    }
}
