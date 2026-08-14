import { z } from 'zod';
import { precheckoutBliteV1Schema } from './blite-contract';
import { BLITE_FALLBACK_DEMO_DURATION_MS } from './blite-deadline';
import type { PrecheckoutBliteStatus } from './blite-store';

const timestamp = z.string().datetime({ offset: true });

export const bliteStatusV1Schema = z.discriminatedUnion('state', [
    z.object({
        state: z.literal('pending'),
        submittedAt: timestamp,
        deadlineAt: timestamp,
        fallbackAt: timestamp,
        retryAfterMs: z.number().int().min(500).max(2_000),
    }).strict(),
    z.object({
        state: z.literal('complete'),
        submittedAt: timestamp,
        deadlineAt: timestamp,
        fallbackAt: timestamp,
        completedAt: timestamp,
        dto: precheckoutBliteV1Schema,
    }).strict(),
    z.object({
        state: z.literal('failed'),
        submittedAt: timestamp,
        deadlineAt: timestamp,
        fallbackAt: timestamp,
    }).strict(),
]);

export type BliteStatusV1 = z.infer<typeof bliteStatusV1Schema>;

export function toBliteStatusV1(
    status: PrecheckoutBliteStatus,
    retryAfterMs = 1_000,
): BliteStatusV1 | null {
    const submittedAtMs = Date.parse(status.submittedAt);
    const deadlineAtMs = Date.parse(status.deadlineAt);
    const fallbackAtMs = deadlineAtMs - BLITE_FALLBACK_DEMO_DURATION_MS;
    if (
        !Number.isFinite(submittedAtMs)
        || !Number.isFinite(deadlineAtMs)
        || !Number.isFinite(fallbackAtMs)
        || fallbackAtMs < submittedAtMs
        || retryAfterMs < 500
        || retryAfterMs > 2_000
    ) return null;
    const base = {
        submittedAt: status.submittedAt,
        deadlineAt: status.deadlineAt,
        fallbackAt: new Date(fallbackAtMs).toISOString(),
    };
    const value = status.state === 'pending'
        ? { state: 'pending' as const, ...base, retryAfterMs }
        : status.state === 'complete'
            ? { state: 'complete' as const, ...base, completedAt: status.completedAt, dto: status.dto }
            : { state: 'failed' as const, ...base };
    const parsed = bliteStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
