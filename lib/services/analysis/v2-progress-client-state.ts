import type { ProgressEventV1 } from '@/lib/contracts/analysis-v2';

export const V2_PROGRESS_EVENT_RETENTION_LIMIT = 50;

export function shouldApplyProgressRevision(
    currentRevision: number,
    nextRevision: number
): boolean {
    return Number.isSafeInteger(nextRevision) && nextRevision >= currentRevision;
}

export function mergeProgressEvents(
    existing: readonly ProgressEventV1[],
    incoming: readonly ProgressEventV1[],
    limit = V2_PROGRESS_EVENT_RETENTION_LIMIT
): ProgressEventV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];

    const bySequence = new Map<number, ProgressEventV1>();
    for (const event of [...existing, ...incoming]) {
        bySequence.set(event.seq, event);
    }

    return [...bySequence.values()]
        .sort((left, right) => left.seq - right.seq)
        .slice(-limit);
}
