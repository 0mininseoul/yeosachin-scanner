import { describe, expect, it } from 'vitest';
import { hydratePersistedAnalysisDurationEstimate, persistedAnalysisWorkload } from './duration-estimate-store';
import type { AnalysisV2DagState } from './v2-dag-planner';

const hash = 'a'.repeat(64);

function state(): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: hash,
        planId: 'standard',
        planSnapshotHash: hash,
        girlfriendExclusion: { decisionHash: hash, excludedCount: 0 },
        relationships: {
            revision: 1, resultHash: hash, detectedMutualCount: 474, publicCount: 430, privateCount: 44,
            detailedSelectedPublicCount: 300, notScreenedPublicCount: 130,
            profileBatches: Array.from({ length: 5 }, (_, batch) => ({ batch, itemCount: 86, inputHash: hash })),
            privateNameBatches: [{ batch: 0, itemCount: 44, inputHash: hash }],
        },
        profileFetchBatches: [], profileAiBatches: [], privateNameBatches: [],
    };
}

describe('persisted duration estimate hydration', () => {
    it('does not produce a stage-two range until persisted relationships exist', () => {
        const withoutRelationships = { ...state(), relationships: undefined };
        expect(persistedAnalysisWorkload(withoutRelationships)).toBeNull();
        expect(hydratePersistedAnalysisDurationEstimate(withoutRelationships)).toBeNull();
    });

    it('hydrates only the public range and never the persisted workload counts', () => {
        const output = hydratePersistedAnalysisDurationEstimate(state());
        expect(output).toEqual({
            source: 'workload',
            estimate: { version: 'v1', band: 'typical', range: { lowMinutes: 5, highMinutes: 8 } },
        });
        expect(JSON.stringify(output)).not.toContain('474');
        expect(JSON.stringify(output)).not.toContain('detailed');
    });
});
