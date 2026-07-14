import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AnalysisV2DagState } from './v2-dag-planner';
import type { ClaimedAnalysisV2Job } from './v2-job-store';
import {
    AnalysisV2ProgressConflictError,
    type AnalysisV2ProgressCheckpointInput,
    type AnalysisV2ProgressStore,
} from './v2-progress-store';
import { createAnalysisV2ProgressReporter } from './v2-progress-reporter';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000';

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function state(overrides: Partial<AnalysisV2DagState> = {}): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: hash('request'),
        planId: 'basic',
        planSnapshotHash: hash('plan'),
        girlfriendExclusion: { decisionHash: hash('exclude'), excludedCount: 1 },
        ...overrides,
    };
}

function claim(overrides: Partial<ClaimedAnalysisV2Job> = {}): ClaimedAnalysisV2Job {
    return {
        requestId,
        jobKey: 'coordinator:bootstrap',
        track: 'coordinator',
        kind: 'bootstrap',
        batch: null,
        inputHash: hash('input'),
        generation: 1,
        reservationToken: '323e4567-e89b-42d3-a456-426614174000',
        claimToken,
        attemptCount: 1,
        ...overrides,
    };
}

function progressStore(checkpoint = vi.fn(async (input) => ({
    snapshot: input,
    event: input.event ?? null,
    advanced: true,
}))): AnalysisV2ProgressStore {
    return {
        checkpoint,
        loadForOwner: vi.fn(),
    } as unknown as AnalysisV2ProgressStore;
}

describe('analysis V2 progress reporter', () => {
    it('initializes server-owned progress with a target-ready event and ETA', async () => {
        const checkpoint = vi.fn(async () => ({
            snapshot: {} as never,
            event: null,
            advanced: true,
        }));
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
        });

        await reporter.initialize({ claim: claim(), state: state() });

        expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
            status: 'processing',
            backgroundProcessing: true,
            activeProfile: null,
            event: {
                state: 'confirmed',
                eventCode: 'TARGET_PROFILE_READY',
                copyCode: 'TARGET_PROFILE_READY',
                aggregateCount: null,
            },
            etaRange: expect.objectContaining({
                lowSeconds: expect.any(Number),
                highSeconds: expect.any(Number),
            }),
        }));
    });

    it('reports only sanitized DAG-derived aggregate progress', async () => {
        const checkpoint = vi.fn(async () => ({
            snapshot: {} as never,
            event: null,
            advanced: true,
        }));
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
        });
        const relationshipState = state({
            relationships: {
                revision: 1,
                resultHash: hash('relationship-result'),
                detectedMutualCount: 42,
                publicCount: 40,
                privateCount: 2,
                detailedSelectedPublicCount: 40,
                notScreenedPublicCount: 0,
                profileBatches: [
                    { batch: 0, itemCount: 30, inputHash: hash('batch-0') },
                    { batch: 1, itemCount: 10, inputHash: hash('batch-1') },
                ],
                privateNameBatches: [
                    { batch: 0, itemCount: 2, inputHash: hash('private-0') },
                ],
            },
        });
        await reporter.report({
            claim: claim({
                jobKey: 'track:relationships:collect',
                track: 'relationships',
                kind: 'collection',
            }),
            state: relationshipState,
            stage: 'relationships',
        });
        const payload = (checkpoint.mock.calls as unknown as [
            [AnalysisV2ProgressCheckpointInput],
        ])[0][0];
        expect(payload.event).toMatchObject({
            eventCode: 'RELATIONSHIP_PROGRESS',
            aggregateCount: 42,
        });
        expect(payload.tracks.relationshipAi.done).toBe(1);
        expect(JSON.stringify(payload)).not.toContain('instagram');
    });

    it('masks the actual executor-start username before heartbeat persistence', async () => {
        const heartbeatActiveProfile = vi.fn(async () => true);
        const store = progressStore();
        store.heartbeatActiveProfile = heartbeatActiveProfile;
        const reporter = createAnalysisV2ProgressReporter({ store });

        await reporter.heartbeat!({
            claim: claim({
                jobKey: 'track:profile-ai:batch:0',
                track: 'profile_ai',
                kind: 'ai',
                batch: 0,
            }),
            stage: 'profile_ai',
            username: 'Candidate.Name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
        });

        expect(heartbeatActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            maskedUsername: 'c************e',
            imageUrl: null,
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
        }));
        expect(JSON.stringify(heartbeatActiveProfile.mock.calls)).not.toContain('Candidate.Name');
    });

    it('reloads current DAG state once when a parallel completion makes counters stale', async () => {
        const checkpoint = vi.fn()
            .mockRejectedValueOnce(new AnalysisV2ProgressConflictError())
            .mockResolvedValueOnce({ snapshot: {} as never, event: null, advanced: true });
        const current = state({
            targetEvidence: {
                revision: 1,
                resultHash: hash('target'),
                interactorCount: 12,
            },
            reverseLikes: {
                revision: 1,
                resultHash: hash('reverse'),
                shortlistCount: 3,
            },
        });
        const reloadState = vi.fn(async () => current);
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
            reloadState,
        });

        await reporter.report({
            claim: claim({
                jobKey: 'track:target-evidence:collect',
                track: 'target_evidence',
                kind: 'collection',
            }),
            state: state(),
            stage: 'target_evidence',
            includeStageEvent: false,
        });

        expect(reloadState).toHaveBeenCalledWith(requestId);
        expect(checkpoint).toHaveBeenCalledTimes(2);
        expect(checkpoint.mock.calls[1]![0].tracks.interactions).toMatchObject({
            state: 'completed',
            done: 2,
            total: 2,
        });
    });
});
