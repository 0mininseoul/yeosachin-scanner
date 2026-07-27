import { describe, expect, it } from 'vitest';
import { __test__ } from '@/hooks/useAnalysisDurationEstimate';

describe('duration estimate client hydration boundary', () => {
    it('hydrates only approved public ranges', () => {
        expect(__test__.parseEstimate({ estimate: {
            version: 'v1', band: 'typical', range: { lowMinutes: 5, highMinutes: 8 },
        } })).toEqual({ source: 'workload', estimate: {
            version: 'v1', band: 'typical', range: { lowMinutes: 5, highMinutes: 8 },
        } });
    });

    it('rejects raw workload fields and unapproved ranges', () => {
        expect(__test__.parseEstimate({ estimate: {
            version: 'v1', band: 'typical', range: { lowMinutes: 5, highMinutes: 8 }, mutualCount: 474,
        } })).toBeNull();
        expect(__test__.parseEstimate({ estimate: {
            version: 'v1', band: 'typical', range: { lowMinutes: 6, highMinutes: 8 },
        } })).toBeNull();
    });

    it('keeps synthetic demo on its isolated 60–90 second range', () => {
        expect(__test__.parseEstimate({
            source: 'demo', version: 'demo-v1', rangeSeconds: { lowSeconds: 60, highSeconds: 90 },
        })).toEqual({ source: 'demo', lowSeconds: 60, highSeconds: 90 });
    });
});
