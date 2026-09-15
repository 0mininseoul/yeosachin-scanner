import { describe, expect, it } from "vitest";
import { resultPageHeader } from "../../../lib/services/analysis/result-page-header";
import { __test__ } from "@/hooks/useAnalysisDurationEstimate";
import { hydratePersistedAnalysisDurationEstimate, persistedAnalysisWorkload } from "../../../lib/services/analysis/duration-estimate-store";
import { type AnalysisV2DagState } from "../../../lib/services/analysis/v2-dag-planner";
import { type ProgressEventV1 } from "@/lib/contracts/analysis-v2";
import { mergeProgressEvents, preferredProgressNarration, shouldApplyProgressRevision } from "../../../lib/services/analysis/v2-progress-client-state";
import { isAnalysisDeletable } from "../../../lib/services/analysis/deletion";

describe("result-page-header", () => {
    describe('resultPageHeader', () => {
        it('uses the stored target full name and a normalized target profile URL', () => {
            expect(resultPageHeader({
                targetFullName: '  김준호  ',
                targetInstagramId: '@Target.User',
            })).toEqual({
                displayName: '김준호',
                username: 'target.user',
                instagramUrl: 'https://www.instagram.com/target.user/',
            });
        });

        it('falls back to the stored target username when a full name is absent', () => {
            expect(resultPageHeader({
                targetFullName: '   ',
                targetInstagramId: 'Target_User',
            })).toMatchObject({
                displayName: 'target_user',
                username: 'target_user',
                instagramUrl: 'https://www.instagram.com/target_user/',
            });
        });

        it('fails closed on a malformed target username instead of making an external link', () => {
            expect(resultPageHeader({
                targetFullName: null,
                targetInstagramId: 'target/account',
            })).toEqual({
                displayName: '분석 대상',
                username: null,
                instagramUrl: null,
            });
        });

        it('does not link profile names that Instagram itself cannot resolve', () => {
            expect(resultPageHeader({
                targetFullName: null,
                targetInstagramId: '..target',
            })).toMatchObject({
                displayName: '분석 대상',
                username: null,
                instagramUrl: null,
            });
        });
    });
});

describe("duration-estimate-hydration", () => {
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
});

describe("duration-estimate-store", () => {
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
});

describe("v2-progress-client-state", () => {
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

        it('keeps the current snapshot narration ahead of an older event', () => {
            expect(preferredProgressNarration(
                '@a*** · 맞팔 계정을 판독하고 있습니다.',
                [event(1)]
            )).toBe('@a*** · 맞팔 계정을 판독하고 있습니다.');
        });
    });
});

describe("deletion", () => {
    describe('isAnalysisDeletable', () => {
        it.each(['completed', 'failed'])('allows terminal status %s', (status) => {
            expect(isAnalysisDeletable(status)).toBe(true);
        });

        it.each(['pending', 'processing', 'unknown'])('rejects non-terminal status %s', (status) => {
            expect(isAnalysisDeletable(status)).toBe(false);
        });
    });
});
