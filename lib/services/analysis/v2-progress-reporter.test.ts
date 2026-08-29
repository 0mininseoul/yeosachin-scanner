import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
    AnalysisV2DagBatchResultManifest,
    AnalysisV2DagState,
} from './v2-dag-planner';
import type { ClaimedAnalysisV2Job } from './v2-job-store';
import {
    AnalysisV2ProgressConflictError,
    AnalysisV2ProgressFenceError,
    type AnalysisV2ProgressCheckpointInput,
    type AnalysisV2ProgressStore,
} from './v2-progress-store';
import { createAnalysisV2ProgressReporter } from './v2-progress-reporter';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000';
const candidateKey = 'b'.repeat(64);

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

function batchResult(label: string): AnalysisV2DagBatchResultManifest {
    return {
        batch: 0,
        itemCount: 1,
        producerInputHash: hash(`producer:${label}`),
        revision: 1,
        resultHash: hash(`result:${label}`),
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

    it('fails open with a nullable result when initialize transport is unavailable', async () => {
        const checkpoint = vi.fn(async () => {
            throw new TypeError('fetch failed: ECONNREFUSED');
        });
        const onFailOpen = vi.fn();
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
            onFailOpen,
        });

        await expect(reporter.initialize({ claim: claim(), state: state() }))
            .resolves.toBeNull();
        expect(onFailOpen).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'initialize',
            code: 'ANALYSIS_V2_PROGRESS_INITIALIZE_FAIL_OPEN',
            correlation: 'transport',
        }));
    });

    it('keeps initialize progress fences fatal', async () => {
        const checkpoint = vi.fn(async () => {
            throw new AnalysisV2ProgressFenceError();
        });
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
        });

        await expect(reporter.initialize({ claim: claim(), state: state() }))
            .rejects.toBeInstanceOf(AnalysisV2ProgressFenceError);
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

    it('retries a stale worker stage against newer canonical DAG counters', async () => {
        const staleState = state({
            relationships: {
                revision: 1,
                resultHash: hash('relationships'),
                detectedMutualCount: 1,
                publicCount: 1,
                privateCount: 0,
                detailedSelectedPublicCount: 1,
                notScreenedPublicCount: 0,
                profileBatches: [{
                    batch: 0,
                    itemCount: 1,
                    inputHash: hash('profile-topology'),
                }],
                privateNameBatches: [],
            },
            profileFetchBatches: [batchResult('fetch')],
        });
        const newerCanonicalState = {
            ...staleState,
            profileAiBatches: [batchResult('ai')],
        };
        const checkpoint = vi.fn()
            .mockRejectedValueOnce(new Error(
                'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: checkpoint response drift against newer canonical DAG state.'
            ))
            .mockResolvedValueOnce({ snapshot: {} as never, event: null, advanced: true });
        const reloadState = vi.fn(async () => newerCanonicalState);
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
            reloadState,
        });

        await expect(reporter.report({
            claim: claim({
                jobKey: 'track:profiles:batch:0',
                track: 'profiles',
                kind: 'profile_fetch',
                batch: 0,
            }),
            state: staleState,
            stage: 'profile_fetch',
            includeStageEvent: false,
        })).resolves.toMatchObject({ advanced: true });

        const retryInput = (checkpoint.mock.calls as unknown as [
            [AnalysisV2ProgressCheckpointInput],
            [AnalysisV2ProgressCheckpointInput],
        ])[1][0];
        expect(reloadState).toHaveBeenCalledOnce();
        expect(retryInput.tracks.relationshipAi.done).toBe(3);
        expect(retryInput.tracks.relationshipAi.stageCode)
            .toBe('PUBLIC_PROFILES_COLLECTING');
    });

    it('masks the actual executor-start username before heartbeat persistence', async () => {
        const heartbeatActiveProfile = vi.fn(async () => true);
        const candidateKeyDeriver = vi.fn(() => candidateKey);
        const store = progressStore();
        store.heartbeatActiveProfile = heartbeatActiveProfile;
        const reporter = createAnalysisV2ProgressReporter({ store, candidateKeyDeriver });

        await reporter.heartbeat!({
            claim: claim({
                jobKey: 'track:profiles:batch:0',
                track: 'profiles',
                kind: 'profile_fetch',
                batch: 0,
            }),
            stage: 'profile_fetch',
            username: 'Candidate.Name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
        });

        expect(heartbeatActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            maskedUsername: 'c************e',
            candidateKey,
            imageUrl: null,
            feedImageUrls: [],
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
        }));
        expect(candidateKeyDeriver).toHaveBeenCalledExactlyOnceWith(
            requestId,
            'Candidate.Name'
        );
        expect(JSON.stringify(heartbeatActiveProfile.mock.calls)).not.toContain('Candidate.Name');
    });

    it('forwards bounded in-stage ordinal and call-phase signals', async () => {
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
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 10,
            currentOrdinal: 99,
            callPhase: 'analyzing',
        });

        expect(heartbeatActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            currentOrdinal: 10,
            callPhase: 'analyzing',
        }));
    });

    it('signs an already-selected candidate preview before one heartbeat persistence call', async () => {
        const heartbeatActiveProfile = vi.fn(async () => true);
        const candidateKeyDeriver = vi.fn(() => candidateKey);
        const imageProxySigner = vi.fn((rawUrl: string | null | undefined) => (
            rawUrl ? `/api/image-proxy?token=signed-${rawUrl.split('/').at(-1)}` : undefined
        ));
        const store = progressStore();
        store.heartbeatActiveProfile = heartbeatActiveProfile;
        const reporter = createAnalysisV2ProgressReporter({
            store,
            imageProxySigner,
            candidateKeyDeriver,
        });

        await reporter.heartbeat!({
            claim: claim({
                jobKey: 'track:profile-ai:batch:0', track: 'profile_ai', kind: 'ai', batch: 0,
            }),
            stage: 'profile_ai',
            username: 'Candidate.Name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            preview: {
                profilePicUrl: 'https://cdninstagram.com/candidate/profile.jpg',
                feedImageUrls: [
                    'https://cdninstagram.com/candidate/post-1.jpg',
                    'https://cdninstagram.com/candidate/post-2.jpg',
                ],
            },
        });

        expect(imageProxySigner).toHaveBeenCalledTimes(3);
        expect(heartbeatActiveProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            maskedUsername: 'c************e',
            candidateKey,
            imageUrl: '/api/image-proxy?token=signed-profile.jpg',
            feedImageUrls: [
                '/api/image-proxy?token=signed-post-1.jpg',
                '/api/image-proxy?token=signed-post-2.jpg',
            ],
        }));
        expect(candidateKeyDeriver).toHaveBeenCalledExactlyOnceWith(
            requestId,
            'Candidate.Name'
        );
        expect(JSON.stringify(heartbeatActiveProfile.mock.calls))
            .not.toContain('https://cdninstagram.com');
    });

    it('keeps rich media in one legacy no-key heartbeat when key derivation fails', async () => {
        const heartbeatActiveProfile = vi.fn(async () => true);
        const store = progressStore();
        store.heartbeatActiveProfile = heartbeatActiveProfile;
        const reporter = createAnalysisV2ProgressReporter({
            store,
            candidateKeyDeriver: () => { throw new Error('IDENTITY_CONFIG_FAILED'); },
            imageProxySigner: rawUrl => (
                rawUrl ? `/api/image-proxy?token=${rawUrl.split('/').at(-1)}` : undefined
            ),
        });

        await expect(reporter.heartbeat!({
            claim: claim(),
            stage: 'profile_ai',
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            preview: {
                profilePicUrl: 'https://cdninstagram.com/candidate/profile.jpg',
                feedImageUrls: ['https://cdninstagram.com/candidate/post.jpg'],
            },
        })).resolves.toBe(true);

        const heartbeatInput = (heartbeatActiveProfile.mock.calls as unknown as [
            [Record<string, unknown>],
        ])[0][0];
        expect(heartbeatActiveProfile).toHaveBeenCalledOnce();
        expect(heartbeatInput).toMatchObject({
            imageUrl: '/api/image-proxy?token=profile.jpg',
            feedImageUrls: ['/api/image-proxy?token=post.jpg'],
        });
        expect(Object.hasOwn(heartbeatInput, 'candidateKey')).toBe(false);
    });

    it('falls back to one media-free heartbeat when preview signing fails', async () => {
        const heartbeatActiveProfile = vi.fn(async () => true);
        const store = progressStore();
        store.heartbeatActiveProfile = heartbeatActiveProfile;
        const reporter = createAnalysisV2ProgressReporter({
            store,
            imageProxySigner: () => { throw new Error('SIGNING_FAILED'); },
        });

        await expect(reporter.heartbeat!({
            claim: claim(),
            stage: 'profile_ai',
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            preview: {
                profilePicUrl: 'https://cdninstagram.com/candidate/profile.jpg',
                feedImageUrls: [],
            },
        })).resolves.toBe(true);

        expect(heartbeatActiveProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            imageUrl: null,
            feedImageUrls: [],
        }));
    });

    it('falls back to one media-free heartbeat when preview validation fails', async () => {
        const heartbeatActiveProfile = vi.fn(async () => true);
        const store = progressStore();
        store.heartbeatActiveProfile = heartbeatActiveProfile;
        const reporter = createAnalysisV2ProgressReporter({
            store,
            imageProxySigner: rawUrl => `/api/image-proxy?token=${rawUrl}`,
        });

        await expect(reporter.heartbeat!({
            claim: claim(),
            stage: 'profile_ai',
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            preview: {
                feedImageUrls: [
                    'https://cdninstagram.com/candidate/post-1.jpg',
                    'https://cdninstagram.com/candidate/post-2.jpg',
                    'https://cdninstagram.com/candidate/post-3.jpg',
                    'https://cdninstagram.com/candidate/post-4.jpg',
                ],
            },
        })).resolves.toBe(true);

        expect(heartbeatActiveProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            imageUrl: null,
            feedImageUrls: [],
        }));
    });

    it('fails open on heartbeat persistence drift and reports a safe subcode', async () => {
        const store = progressStore();
        store.heartbeatActiveProfile = vi.fn(async () => {
            throw new Error(
                'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: heartbeat failed (PGRST000).'
            );
        });
        const onFailOpen = vi.fn();
        const reporter = createAnalysisV2ProgressReporter({
            store,
            imageProxySigner: () => '/api/image-proxy?token=signed',
            candidateKeyDeriver: () => candidateKey,
            onFailOpen,
        });

        await expect(reporter.heartbeat!({
            claim: claim(),
            stage: 'profile_ai',
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            preview: {
                profilePicUrl: 'https://cdninstagram.com/candidate/profile.jpg',
                feedImageUrls: [],
            },
        })).resolves.toBe(false);
        expect(store.heartbeatActiveProfile).toHaveBeenCalledOnce();
        expect(onFailOpen).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'heartbeat',
            code: 'ANALYSIS_V2_PROGRESS_HEARTBEAT_FAIL_OPEN',
            correlation: 'persistence',
        }));
    });

    it('fails open on a low-level transport failure and classifies it safely', async () => {
        const store = progressStore();
        store.heartbeatActiveProfile = vi.fn(async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        });
        const logger = { emit: vi.fn() };
        const onFailOpen = vi.fn();
        const reporter = createAnalysisV2ProgressReporter({ store, logger, onFailOpen });

        await expect(reporter.heartbeat!({
            claim: claim(),
            stage: 'profile_ai',
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
        })).resolves.toBe(false);

        expect(onFailOpen).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'heartbeat',
            correlation: 'transport',
        }));
        expect(logger.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            event: 'analysis_v2.progress_fail_open',
            severity: 'warn',
            fields: expect.objectContaining({
                request_id: requestId,
                job_key: 'coordinator:bootstrap',
                error_code: 'ANALYSIS_V2_PROGRESS_HEARTBEAT_FAIL_OPEN',
                correlation: 'transport',
                disposition: 'fallback',
                retryable: true,
            }),
        }));
        expect(JSON.stringify(logger.emit.mock.calls)).not.toContain('ECONNREFUSED');
    });

    it('never fails open on a progress fence mismatch', async () => {
        const store = progressStore();
        store.heartbeatActiveProfile = vi.fn(async () => {
            throw new AnalysisV2ProgressFenceError();
        });
        const reporter = createAnalysisV2ProgressReporter({ store });

        await expect(reporter.heartbeat!({
            claim: claim(),
            stage: 'profile_ai',
            username: 'candidate.name',
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
        })).rejects.toBeInstanceOf(AnalysisV2ProgressFenceError);
    });

    it('fails open when a concurrent progress conflict cannot be reconciled', async () => {
        const checkpoint = vi.fn().mockRejectedValue(new AnalysisV2ProgressConflictError());
        const onFailOpen = vi.fn();
        const reloadState = vi.fn(async () => null);
        const reporter = createAnalysisV2ProgressReporter({
            store: progressStore(checkpoint),
            reloadState,
            onFailOpen,
        });

        await expect(reporter.report({
            claim: claim({
                jobKey: 'track:relationships:collect',
                track: 'relationships',
                kind: 'collection',
            }),
            state: state(),
            stage: 'relationships',
        })).resolves.toBeNull();
        expect(reloadState).toHaveBeenCalledOnce();
        expect(onFailOpen).toHaveBeenCalledWith(expect.objectContaining({
            correlation: 'conflict',
        }));
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
