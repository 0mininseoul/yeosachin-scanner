import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalysisV2DagState } from './v2-dag-planner';
import {
    getAnalysisV2ProgressWorkTotals,
    projectAnalysisV2Progress,
} from './v2-progress-projector';

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function state(overrides: Partial<AnalysisV2DagState> = {}): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: hash('request'),
        planId: 'basic',
        planSnapshotHash: hash('plan'),
        girlfriendExclusion: { decisionHash: hash('exclusion'), excludedCount: 1 },
        ...overrides,
    };
}

describe('analysis V2 progress projector', () => {
    it('uses the frozen fan-out topology instead of a plan-capacity estimate', () => {
        expect(getAnalysisV2ProgressWorkTotals(state())).toEqual({
            relationshipAi: 4,
            interactions: 2,
            finalization: 3,
        });
        expect(getAnalysisV2ProgressWorkTotals(state({
            relationships: {
                revision: 1,
                resultHash: hash('relationships'),
                detectedMutualCount: 31,
                publicCount: 30,
                privateCount: 1,
                detailedSelectedPublicCount: 30,
                notScreenedPublicCount: 0,
                profileBatches: [{ batch: 0, itemCount: 30, inputHash: hash('profile') }],
                privateNameBatches: [{ batch: 0, itemCount: 1, inputHash: hash('private') }],
            },
        }))).toEqual({
            relationshipAi: 6,
            interactions: 2,
            finalization: 4,
        });
    });

    it('starts only the active parallel track and exposes no profile identity', () => {
        const projected = projectAnalysisV2Progress({
            state: state(),
            activeStage: 'target_evidence',
        });
        expect(projected.tracks.interactions).toMatchObject({
            state: 'running',
            stageCode: 'TARGET_INTERACTIONS_COLLECTING',
            done: 0,
            total: 2,
        });
        expect(projected.tracks.relationshipAi.state).toBe('pending');
        expect(JSON.stringify(projected)).not.toContain('username');
    });

    it('derives counters and bounded public events from append-only manifests', () => {
        const projected = projectAnalysisV2Progress({
            activeStage: 'profile_ai',
            state: state({
                relationships: {
                    revision: 1,
                    resultHash: hash('relationships'),
                    detectedMutualCount: 31,
                    publicCount: 30,
                    privateCount: 1,
                    detailedSelectedPublicCount: 30,
                    notScreenedPublicCount: 0,
                    profileBatches: [{ batch: 0, itemCount: 30, inputHash: hash('profile') }],
                    privateNameBatches: [{ batch: 0, itemCount: 1, inputHash: hash('private') }],
                },
                profileFetchBatches: [{
                    batch: 0,
                    itemCount: 30,
                    producerInputHash: hash('profile-job'),
                    revision: 1,
                    resultHash: hash('profile-result'),
                }],
                profileAiBatches: [{
                    batch: 0,
                    itemCount: 30,
                    producerInputHash: hash('profile-ai-job'),
                    revision: 1,
                    resultHash: hash('profile-ai-result'),
                }],
            }),
        });
        expect(projected.tracks.relationshipAi.done).toBe(3);
        expect(projected.event).toEqual({
            state: 'confirmed',
            eventCode: 'PROFILE_SCREENED',
            copyCode: 'PROFILES_SCREENED',
            aggregateCount: 30,
        });
    });

    it('finishes a track only after its semantic terminal checkpoint', () => {
        const relationships = {
            revision: 1,
            resultHash: hash('relationships'),
            detectedMutualCount: 0,
            publicCount: 0,
            privateCount: 0,
            detailedSelectedPublicCount: 0,
            notScreenedPublicCount: 0,
            profileBatches: [],
            privateNameBatches: [],
        };
        const projected = projectAnalysisV2Progress({
            activeStage: 'partner_safety',
            state: state({
                relationships,
                profileFetchBatches: [],
                profileAiBatches: [],
                primaryJoin: { revision: 1, resultHash: hash('join'), verifiedFemaleCount: 0 },
                screening: {
                    revision: 1,
                    resultHash: hash('screening'),
                    verifiedFemaleCount: 0,
                    shortlistCount: 0,
                    shortlistHash: hash('shortlist'),
                },
                partnerSafety: {
                    revision: 1,
                    resultHash: hash('partner'),
                    shortlistCount: 0,
                },
            }),
        });
        expect(projected.tracks.relationshipAi).toEqual({
            state: 'completed',
            stageCode: 'RELATIONSHIP_AI_COMPLETE',
            done: 4,
            total: 4,
        });
    });

    it('keeps shortlist progress neutral and final score facts confirmed', () => {
        const screening = projectAnalysisV2Progress({
            activeStage: 'screening',
            state: state({
                screening: {
                    revision: 1,
                    resultHash: hash('screening'),
                    verifiedFemaleCount: 6,
                    shortlistCount: 6,
                    shortlistHash: hash('shortlist'),
                },
            }),
        });
        const final = projectAnalysisV2Progress({
            activeStage: 'final_score',
            state: state({
                finalScore: {
                    revision: 1,
                    resultHash: hash('final'),
                    featuredHighRiskCount: 2,
                    narrativeCount: 2,
                    narrativeBatchHash: hash('narratives'),
                },
            }),
        });
        expect(screening.event).toMatchObject({
            state: 'confirmed',
            eventCode: 'SHORTLIST_READY',
            copyCode: 'SHORTLIST_READY',
        });
        expect(screening.event?.aggregateCount).toBe(6);
        expect(final.event).toMatchObject({
            state: 'confirmed',
            eventCode: 'FINDING_CONFIRMED',
            aggregateCount: 2,
        });
    });
});
