import 'server-only';

import { createHash } from 'node:crypto';

import { z } from 'zod';
import { DEV_LIVE_STANDARD_CAPS } from '@/lib/constants/dev-ui';

export const DEV_LIVE_PREFLIGHT_KEY_PREFIX = 'dev-live:';
export const DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX = 'dev-live:owner:';
export const DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX = 'dev-live:owner:standard:';
export const DEV_LIVE_OWNER_START_ATTEMPT = 'x-dev-live-attempt-id';
export const DEV_LIVE_OWNER_CAPS = Object.freeze({ apifyMaxCents: 500, aiMaxCents: 200 });
export const DEV_LIVE_RUNNER_PLAN = 'basic' as const;
export const DEV_LIVE_STANDARD_ARCHIVE_REQUIRED = 'DEV_LIVE_STANDARD_ARCHIVE_REQUIRED';
export type DevLivePlan = 'basic' | 'standard';

const instagramIdSchema = z.string().regex(/^[a-z0-9._]{1,30}$/);
export const devLiveApprovalId = z.string().uuid({ version: 'v4' }).transform(id => id.toLowerCase());
const approvalFields = {
    id: devLiveApprovalId,
    targetInstagramId: instagramIdSchema,
    approvedAt: z.string().datetime(),
};
const basicApprovalSchema = z.object({
    ...approvalFields,
    expiresAt: z.string().datetime(),
    apifyMaxCents: z.number().int().positive().max(DEV_LIVE_OWNER_CAPS.apifyMaxCents),
    aiMaxCents: z.number().int().positive().max(DEV_LIVE_OWNER_CAPS.aiMaxCents),
}).strict();
const standardApprovalSchema = z.object({
    ...approvalFields,
    planId: z.literal('standard'),
    expiresAt: z.string().datetime().nullable(),
    apifyMaxCents: z.literal(DEV_LIVE_STANDARD_CAPS.apifyMaxCents),
    aiMaxCents: z.union([z.literal(400), z.literal(DEV_LIVE_STANDARD_CAPS.aiMaxCents)]),
    archiveReplay: z.object({
        sourceGrantId: devLiveApprovalId,
        slotHash: z.string().regex(/^[a-f0-9]{64}$/),
        expiresAt: z.string(),
    }).strict().optional(),
}).strict();

type DevLiveApprovalDescriptor = (z.infer<typeof basicApprovalSchema> & { planId: 'basic' })
    | z.infer<typeof standardApprovalSchema>;

export type DevLiveApproval = DevLiveApprovalDescriptor & {
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

export function devLiveStandardCaptureConfigured(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.DEV_LIVE_STANDARD_COLLECTION_MODE === 'archive_capture'
        && typeof env.DEV_LIVE_STANDARD_ARCHIVE_SLOT === 'string'
        && /^[a-f0-9]{32}$/.test(env.DEV_LIVE_STANDARD_ARCHIVE_SLOT)
        && z.string().datetime().safeParse(env.DEV_LIVE_STANDARD_ARCHIVE_APPROVAL_NOT_BEFORE).success;
}

export function devLiveStandardReplayConfiguration(
    env: Record<string, string | undefined> = process.env,
): { sourceGrantId: string; slotHash: string } | null {
    const slot = env.DEV_LIVE_STANDARD_ARCHIVE_SLOT;
    const source = devLiveApprovalId.safeParse(env.DEV_LIVE_STANDARD_ARCHIVE_SOURCE_APPROVAL);
    if (env.DEV_LIVE_STANDARD_COLLECTION_MODE !== 'archive_replay'
        || env.DEV_LIVE_STANDARD_ARCHIVE_REPLAY_ENABLED !== 'true'
        || !slot || !/^[a-f0-9]{32}$/.test(slot) || !source.success) return null;
    return {
        sourceGrantId: source.data,
        slotHash: createHash('sha256').update(`dev-standard-archive-replay:v1\n${slot}`, 'utf8').digest('hex'),
    };
}

export function devLiveStandardNeedsArchive(env: Record<string, string | undefined> = process.env): boolean {
    return env.DEV_LIVE_STANDARD_COLLECTION_MODE !== 'live_apify'
        && !devLiveStandardCaptureConfigured(env)
        && !devLiveStandardReplayConfiguration(env);
}

function activeApproval(approval: DevLiveApprovalDescriptor, prefix: string, now: number): DevLiveApproval | null {
    const startsAt = Date.parse(approval.approvedAt);
    if (!Number.isFinite(now) || !Number.isFinite(startsAt) || now < startsAt) return null;
    if (approval.expiresAt === null) {
        if (approval.aiMaxCents !== DEV_LIVE_STANDARD_CAPS.aiMaxCents) return null;
    } else {
        const expiresAt = Date.parse(approval.expiresAt);
        const maxApprovalDurationMs = (approval.planId === 'standard' ? 150 : 30) * 60_000;
        if (!Number.isFinite(expiresAt) || now >= expiresAt || expiresAt - startsAt > maxApprovalDurationMs) return null;
    }
    return {
        ...approval,
        idempotencyKey: prefix + approval.id,
        nonce: `dev-live-${approval.id}`,
    };
}

function parseBasicApproval(value: unknown, prefix: string, now: number): DevLiveApproval | null {
    const parsed = basicApprovalSchema.safeParse(value);
    return parsed.success ? activeApproval({ ...parsed.data, planId: 'basic' }, prefix, now) : null;
}

export function parseDevLiveOwnerApproval(value: unknown, now = Date.now()): DevLiveApproval | null {
    const approval = parseBasicApproval(value, DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX, now);
    return approval?.apifyMaxCents === DEV_LIVE_OWNER_CAPS.apifyMaxCents
        && approval.aiMaxCents === DEV_LIVE_OWNER_CAPS.aiMaxCents ? approval : null;
}

export function parseDevLiveStandardApproval(value: unknown, targetInstagramId: string, now = Date.now()): DevLiveApproval | null {
    const parsed = standardApprovalSchema.safeParse(value);
    if (!parsed.success || parsed.data.targetInstagramId !== targetInstagramId) return null;
    return activeApproval(parsed.data, DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX, now);
}

export function readDevLiveApproval(
    env: Record<string, string | undefined> = process.env,
    now = Date.now(),
): DevLiveApproval | null {
    if (env.DEV_LIVE_ANALYSIS_ARMED !== 'true' || env.DEV_LIVE_ANALYSIS_MODE !== undefined
        || !env.DEV_LIVE_ANALYSIS_APPROVAL) return null;
    try {
        return parseBasicApproval(JSON.parse(env.DEV_LIVE_ANALYSIS_APPROVAL), DEV_LIVE_PREFLIGHT_KEY_PREFIX, now);
    } catch {
        return null;
    }
}
