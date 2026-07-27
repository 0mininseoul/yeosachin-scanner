import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_DURATION_ESTIMATE_VERSION,
    estimatePersistedAnalysisDuration,
    estimatePreflightAnalysisDuration,
    hasAnalysisDurationExceeded,
} from './duration-estimate';

describe('analysis duration estimator v1', () => {
    const capacity = { followers: 800, following: 800 };

    it.each([
        [0, 0, 'small', { lowMinutes: 4, highMinutes: 6 }],
        [200, 200, 'small', { lowMinutes: 4, highMinutes: 6 }],
        [201, 201, 'typical', { lowMinutes: 5, highMinutes: 8 }],
        [474, 644, 'typical', { lowMinutes: 5, highMinutes: 8 }],
        [601, 800, 'large', { lowMinutes: 8, highMinutes: 12 }],
    ] as const)('maps preflight %i/%i to the conservative %s band', (followers, following, band, range) => {
        expect(estimatePreflightAnalysisDuration({
            followersCount: followers,
            followingCount: following,
            planCapacity: capacity,
        })).toEqual({ version: ANALYSIS_DURATION_ESTIMATE_VERSION, band, range });
    });

    it('keeps the largest supported plan in the 10–15 minute band', () => {
        expect(estimatePreflightAnalysisDuration({
            followersCount: 901,
            followingCount: 1_200,
            planCapacity: { followers: 1_200, following: 1_200 },
        })).toMatchObject({ band: 'largest', range: { lowMinutes: 10, highMinutes: 15 } });
    });

    it('uses actual persisted workload rather than an exposed screening scope', () => {
        expect(estimatePersistedAnalysisDuration({
            mutualCount: 250,
            publicCount: 430,
            privateCount: 20,
            profileBatchCount: 5,
            privateNameBatchCount: 1,
            completedStageOperations: 2,
        })).toMatchObject({ band: 'typical', range: { lowMinutes: 5, highMinutes: 8 } });
    });

    it('marks only ranges whose upper bound has elapsed as delayed', () => {
        const estimateValue = estimatePreflightAnalysisDuration({
            followersCount: 474, followingCount: 644, planCapacity: capacity,
        });
        expect(hasAnalysisDurationExceeded(1_000, estimateValue, 481_000)).toBe(false);
        expect(hasAnalysisDurationExceeded(1_000, estimateValue, 481_001)).toBe(true);
        expect(hasAnalysisDurationExceeded(null, estimateValue, 999_999)).toBe(false);
    });
});
