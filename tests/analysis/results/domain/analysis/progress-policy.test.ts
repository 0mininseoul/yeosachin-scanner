import { describe, expect, it } from 'vitest';
import {
    PROGRESS_BASIS_POINTS_MAX,
    PROGRESS_TRACK_WEIGHTS_BP,
    advancePersistedProgress,
    assertNextProgressEventSequence,
    calculateTrackProgressBp,
    calculateWeightedProgress,
    nextProgressEventSequence,
    type ProgressTrackWorkMap,
} from '../../../../../lib/domain/analysis/progress-policy';

const SNAPSHOT_A = 'a'.repeat(64);
const SNAPSHOT_B = 'b'.repeat(64);

function persisted(overrides: Partial<{
    revision: number;
    overallProgressBp: number;
    status: 'queued' | 'processing' | 'completed' | 'failed' | 'upgrade_required';
    lastEventSeq: number;
    snapshotFingerprint: string;
}> = {}) {
    return {
        revision: 1,
        overallProgressBp: 0,
        status: 'processing' as const,
        lastEventSeq: 0,
        snapshotFingerprint: SNAPSHOT_A,
        ...overrides,
    };
}

function tracks(
    overrides: Partial<ProgressTrackWorkMap> = {}
): ProgressTrackWorkMap {
    return {
        relationshipAi: { done: 0, total: 1 },
        interactions: { done: 0, total: 1 },
        finalization: { done: 0, total: 1 },
        ...overrides,
    };
}

describe('weighted analysis progress', () => {
    it('keeps the three canonical track weights at exactly 10,000 basis points', () => {
        expect(PROGRESS_TRACK_WEIGHTS_BP).toEqual({
            relationshipAi: 7_200,
            interactions: 1_700,
            finalization: 1_100,
        });
        expect(Object.values(PROGRESS_TRACK_WEIGHTS_BP)
            .reduce((sum, weight) => sum + weight, 0))
            .toBe(PROGRESS_BASIS_POINTS_MAX);
    });

    it('calculates each track and the weighted overall value from done/total work', () => {
        const result = calculateWeightedProgress(tracks({
            relationshipAi: { done: 1, total: 2 },
            interactions: { done: 1, total: 4 },
            finalization: { done: 0, total: 2 },
        }), 'processing');

        expect(result.trackProgressBp).toEqual({
            relationshipAi: 5_000,
            interactions: 2_500,
            finalization: 0,
        });
        expect(result.overallProgressBp).toBe(4_025);
        expect(calculateTrackProgressBp({ done: 2, total: 3 })).toBe(6_666);
    });

    it('keeps an unplanned zero-total track at zero without division errors', () => {
        const result = calculateWeightedProgress(tracks({
            relationshipAi: { done: 0, total: 0 },
        }), 'queued');

        expect(result.trackProgressBp.relationshipAi).toBe(0);
        expect(result.overallProgressBp).toBe(0);
    });

    it('reserves 10,000 for completed status even when all work units are done', () => {
        const allDone = tracks({
            relationshipAi: { done: 4, total: 4 },
            interactions: { done: 3, total: 3 },
            finalization: { done: 2, total: 2 },
        });

        expect(calculateWeightedProgress(allDone, 'processing').overallProgressBp).toBe(9_999);
        expect(calculateWeightedProgress(allDone, 'completed').overallProgressBp).toBe(10_000);
        expect(calculateWeightedProgress(tracks(), 'completed').overallProgressBp).toBe(10_000);
    });

    it('rejects malformed work and malformed weight policies', () => {
        expect(() => calculateTrackProgressBp({ done: -1, total: 1 })).toThrow(RangeError);
        expect(() => calculateTrackProgressBp({ done: 1.5, total: 2 })).toThrow(RangeError);
        expect(() => calculateTrackProgressBp({ done: 2, total: 1 })).toThrow('cannot exceed');
        expect(() => calculateWeightedProgress(tracks(), 'processing', {
            relationshipAi: 7_200,
            interactions: 1_700,
            finalization: 1_099,
        })).toThrow('must total 10000');
    });
});

describe('persisted progress transitions', () => {
    it('increments revision exactly once when external progress advances', () => {
        const next = advancePersistedProgress({
            previous: persisted({ revision: 7, overallProgressBp: 4_000 }),
            tracks: tracks({
                relationshipAi: { done: 1, total: 2 },
                interactions: { done: 1, total: 4 },
            }),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        });

        expect(next).toMatchObject({
            revision: 8,
            overallProgressBp: 4_025,
            calculatedProgressBp: 4_025,
            advanced: true,
            progressAdvanced: true,
        });
    });

    it('does not regress progress or revision when a retry reports lower done counts', () => {
        const retry = advancePersistedProgress({
            previous: persisted({ revision: 8, overallProgressBp: 4_025 }),
            tracks: tracks({
                relationshipAi: { done: 1, total: 3 },
                interactions: { done: 0, total: 4 },
            }),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        });

        expect(retry.calculatedProgressBp).toBe(2_400);
        expect(retry.overallProgressBp).toBe(4_025);
        expect(retry.revision).toBe(8);
        expect(retry.advanced).toBe(false);
        expect(retry.progressAdvanced).toBe(false);
    });

    it('treats a duplicate progress update as a revision-preserving no-op', () => {
        const duplicate = advancePersistedProgress({
            previous: persisted({ revision: 4, overallProgressBp: 3_600 }),
            tracks: tracks({ relationshipAi: { done: 1, total: 2 } }),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        });

        expect(duplicate).toMatchObject({
            revision: 4,
            overallProgressBp: 3_600,
            calculatedProgressBp: 3_600,
            advanced: false,
        });
    });

    it('forces completion to 10,000 and advances revision once', () => {
        const completed = advancePersistedProgress({
            previous: persisted({ revision: 12, overallProgressBp: 8_700 }),
            tracks: tracks(),
            status: 'completed',
            lastEventSeq: 1,
            snapshotFingerprint: SNAPSHOT_B,
        });

        expect(completed).toMatchObject({
            revision: 13,
            overallProgressBp: 10_000,
            calculatedProgressBp: 10_000,
            advanced: true,
            progressAdvanced: true,
        });
    });

    it('increments revision for terminal, active-profile, and event changes at the same percent', () => {
        const previous = persisted({ revision: 7, overallProgressBp: 3_600 });
        const failed = advancePersistedProgress({
            previous,
            tracks: tracks({ relationshipAi: { done: 1, total: 2 } }),
            status: 'failed',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        });
        const profileChanged = advancePersistedProgress({
            previous,
            tracks: tracks({ relationshipAi: { done: 1, total: 2 } }),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_B,
        });
        const eventChanged = advancePersistedProgress({
            previous,
            tracks: tracks({ relationshipAi: { done: 1, total: 2 } }),
            status: 'processing',
            lastEventSeq: 1,
            snapshotFingerprint: SNAPSHOT_A,
        });

        for (const transition of [failed, profileChanged, eventChanged]) {
            expect(transition.revision).toBe(8);
            expect(transition.overallProgressBp).toBe(3_600);
            expect(transition.advanced).toBe(true);
            expect(transition.progressAdvanced).toBe(false);
        }
    });

    it('rejects invalid persisted state and unsafe revision overflow', () => {
        expect(() => advancePersistedProgress({
            previous: persisted({ revision: -1 }),
            tracks: tracks(),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        })).toThrow(RangeError);
        expect(() => advancePersistedProgress({
            previous: persisted({ overallProgressBp: 10_001 }),
            tracks: tracks(),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        })).toThrow(RangeError);
        expect(() => advancePersistedProgress({
            previous: persisted({
                revision: Number.MAX_SAFE_INTEGER,
                overallProgressBp: 0,
            }),
            tracks: tracks({ relationshipAi: { done: 1, total: 2 } }),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        })).toThrow('cannot be incremented safely');
    });

    it('requires contiguous event sequences and rejects terminal-state mutation', () => {
        expect(nextProgressEventSequence(0)).toBe(1);
        expect(nextProgressEventSequence(9)).toBe(10);
        expect(() => assertNextProgressEventSequence(9, 11)).toThrow('must be contiguous');
        expect(() => advancePersistedProgress({
            previous: persisted({ status: 'failed' }),
            tracks: tracks(),
            status: 'processing',
            lastEventSeq: 0,
            snapshotFingerprint: SNAPSHOT_A,
        })).toThrow('terminal status cannot change');
    });
});
