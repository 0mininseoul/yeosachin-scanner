import { describe, expect, it } from 'vitest';
import type { ProgressEventV1 } from '@/lib/contracts/analysis-v2';
import {
    mergeProgressEvents,
    shouldApplyProgressRevision,
} from './v2-progress-client-state';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

function event(seq: number, revision = seq): ProgressEventV1 {
    return {
        schemaVersion: 1,
        requestId: REQUEST_ID,
        seq,
        revision,
        occurredAt: `2026-07-14T12:00:${String(seq).padStart(2, '0')}.000Z`,
        state: 'confirmed',
        eventCode: 'PROFILE_SCREENED',
        copyCode: 'PROFILES_SCREENED',
        aggregateCount: seq,
    };
}

describe('V2 progress client state', () => {
    it('rejects an older snapshot revision without rejecting an equal replay', () => {
        expect(shouldApplyProgressRevision(8, 7)).toBe(false);
        expect(shouldApplyProgressRevision(8, 8)).toBe(true);
        expect(shouldApplyProgressRevision(8, 9)).toBe(true);
    });

    it('deduplicates out-of-order event pages by sequence and keeps canonical order', () => {
        expect(mergeProgressEvents(
            [event(1), event(2)],
            [event(2, 4), event(4), event(3)]
        ).map(item => [item.seq, item.revision])).toEqual([
            [1, 1],
            [2, 4],
            [3, 3],
            [4, 4],
        ]);
    });

    it('retains only the newest bounded event window', () => {
        expect(mergeProgressEvents([], [event(1), event(2), event(3)], 2)
            .map(item => item.seq)).toEqual([2, 3]);
        expect(mergeProgressEvents([], [event(1)], 0)).toEqual([]);
    });
});
