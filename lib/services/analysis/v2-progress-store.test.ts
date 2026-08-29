import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    AnalysisV2ProgressConflictError,
    AnalysisV2ProgressFenceError,
    createAnalysisV2ProgressStore,
    maskAnalysisV2ProgressUsername,
    type AnalysisV2ProgressCheckpointInput,
    type AnalysisV2ProgressSupabaseClient,
} from './v2-progress-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const claimToken = '323e4567-e89b-42d3-a456-426614174000';
const inputHash = 'a'.repeat(64);
const candidateKey = 'b'.repeat(64);

function input(
    overrides: Partial<AnalysisV2ProgressCheckpointInput> = {}
): AnalysisV2ProgressCheckpointInput {
    return {
        requestId,
        jobKey: 'track:profiles:batch:0',
        claimToken,
        jobInputHash: inputHash,
        status: 'processing',
        backgroundProcessing: true,
        tracks: {
            relationshipAi: {
                state: 'running',
                stageCode: 'PROFILE_SCREENING',
                done: 2,
                total: 4,
            },
            interactions: {
                state: 'completed',
                stageCode: 'INTERACTIONS_COMPLETE',
                done: 2,
                total: 2,
            },
            finalization: {
                state: 'pending',
                stageCode: 'FINALIZATION_PENDING',
                done: 0,
                total: 1,
            },
        },
        activeProfile: {
            maskedUsername: 'c*******e',
            imageUrl: '/api/image-proxy?url=https%3A%2F%2Fcdninstagram.com%2Fa.jpg',
        },
        etaRange: { lowSeconds: 60, highSeconds: 120 },
        event: {
            state: 'confirmed',
            eventCode: 'PROFILE_SCREENED',
            copyCode: 'PROFILE_SCREENED_CONFIRMED',
            aggregateCount: 2,
        },
        ...overrides,
    };
}

function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        requestId,
        revision: 3,
        status: 'processing',
        progressBp: 5_300,
        backgroundProcessing: true,
        tracks: {
            relationshipAi: {
                state: 'running',
                stageCode: 'PROFILE_SCREENING',
                done: 2,
                total: 4,
                progressBp: 5_000,
            },
            interactions: {
                state: 'completed',
                stageCode: 'INTERACTIONS_COMPLETE',
                done: 2,
                total: 2,
                progressBp: 10_000,
            },
            finalization: {
                state: 'pending',
                stageCode: 'FINALIZATION_PENDING',
                done: 0,
                total: 1,
                progressBp: 0,
            },
        },
        activeProfile: {
            maskedUsername: 'c*******e',
            imageUrl: '/api/image-proxy?url=https%3A%2F%2Fcdninstagram.com%2Fa.jpg',
        },
        etaRange: { lowSeconds: 60, highSeconds: 120 },
        lastEventSeq: 2,
        ...overrides,
    };
}

function event(seq = 2, revision = 3) {
    return {
        schemaVersion: 1,
        requestId,
        seq,
        revision,
        occurredAt: '2026-07-13T10:00:00.000Z',
        state: 'confirmed',
        eventCode: 'PROFILE_SCREENED',
        copyCode: 'PROFILE_SCREENED_CONFIRMED',
        aggregateCount: 2,
    };
}

function client(data: unknown, error: { code?: string; message?: string } | null = null) {
    return {
        rpc: vi.fn().mockResolvedValue({ data, error }),
    } satisfies AnalysisV2ProgressSupabaseClient;
}

describe('V2 progress persistence adapter', () => {
    it('masks raw usernames before they can enter a public snapshot', () => {
        expect(maskAnalysisV2ProgressUsername('Candidate.Name')).toBe('c************e');
        expect(maskAnalysisV2ProgressUsername('  @CANDIDATE.NAME  '))
            .toBe('c************e');
        expect(maskAnalysisV2ProgressUsername('ab')).toBe('a*');
        expect(maskAnalysisV2ProgressUsername('x')).toBe('*');
        expect(() => maskAnalysisV2ProgressUsername('bad handle')).toThrow('invalid username');
    });

    it('checkpoints calculated work with an exact live job identity', async () => {
        const mock = client({
            snapshot: snapshot(),
            event: event(),
            advanced: true,
        });
        const store = createAnalysisV2ProgressStore(mock);

        const result = await store.checkpoint(input());

        expect(result.snapshot.progressBp).toBe(5_300);
        expect(result.event?.seq).toBe(2);
        expect(mock.rpc).toHaveBeenCalledWith(
            'checkpoint_analysis_v2_progress',
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: 'track:profiles:batch:0',
                p_claim_token: claimToken,
                p_job_input_hash: inputHash,
                p_progress_bp: 5_300,
                p_tracks: expect.objectContaining({
                    relationshipAi: expect.objectContaining({ progressBp: 5_000 }),
                    interactions: expect.objectContaining({ progressBp: 10_000 }),
                }),
                p_snapshot_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
                p_event_key: expect.stringMatching(/^[a-f0-9]{64}$/),
            })
        );
    });

    it('persists masked profile-start media under the exact job fence in one RPC call', async () => {
        const mock = client(true);
        const store = createAnalysisV2ProgressStore(mock);

        await expect(store.heartbeatActiveProfile!({
            requestId,
            jobKey: 'track:profile-ai:batch:3',
            claimToken,
            jobInputHash: inputHash,
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            maskedUsername: 'c************e',
            candidateKey,
            imageUrl: '/api/image-proxy?token=profile',
            feedImageUrls: [
                '/api/image-proxy?token=feed-1',
                '/api/image-proxy?token=feed-2',
            ],
        })).resolves.toBe(true);

        expect(mock.rpc).toHaveBeenCalledWith(
            'checkpoint_analysis_v2_active_profile_heartbeat',
            {
                p_request_id: requestId,
                p_job_key: 'track:profile-ai:batch:3',
                p_claim_token: claimToken,
                p_job_input_hash: inputHash,
                p_started_at: '2026-07-14T02:00:00.000Z',
                p_total_count: 30,
                p_masked_username: 'c************e',
                p_candidate_key: candidateKey,
                p_image_url: '/api/image-proxy?token=profile',
                p_feed_image_urls: [
                    '/api/image-proxy?token=feed-1',
                    '/api/image-proxy?token=feed-2',
                ],
                p_current_ordinal: 0,
                p_call_phase: 'fetching',
            }
        );
        expect(mock.rpc).toHaveBeenCalledOnce();
        expect(JSON.stringify(mock.rpc.mock.calls)).not.toContain('Candidate.Name');
    });

    it('rejects raw, duplicate, excess, and unknown heartbeat media before its RPC call', async () => {
        const mock = client(true);
        const store = createAnalysisV2ProgressStore(mock);
        const heartbeat = {
            requestId,
            jobKey: 'track:profile-ai:batch:3',
            claimToken,
            jobInputHash: inputHash,
            startedAt: '2026-07-14T02:00:00.000Z',
            totalCount: 30,
            maskedUsername: 'c************e',
            candidateKey,
            imageUrl: null,
            feedImageUrls: [] as string[],
        };

        await expect(store.heartbeatActiveProfile!({
            ...heartbeat,
            candidateKey: 'B'.repeat(64),
        })).rejects.toThrow();
        await expect(store.heartbeatActiveProfile!({
            ...heartbeat,
            feedImageUrls: ['https://raw.example/feed.jpg'],
        })).rejects.toThrow();
        await expect(store.heartbeatActiveProfile!({
            ...heartbeat,
            feedImageUrls: ['/api/image-proxy?token=one', '/api/image-proxy?token=one'],
        })).rejects.toThrow();
        await expect(store.heartbeatActiveProfile!({
            ...heartbeat,
            feedImageUrls: Array.from({ length: 4 }, (_, index) => (
                `/api/image-proxy?token=${index}`
            )),
        })).rejects.toThrow();
        await expect(store.heartbeatActiveProfile!({
            ...heartbeat,
            totalCount: 1,
            currentOrdinal: 2,
        })).rejects.toThrow();
        await expect(store.heartbeatActiveProfile!({
            ...heartbeat,
            rawUrl: 'https://raw.example/profile.jpg',
        } as typeof heartbeat)).rejects.toThrow();
        expect(mock.rpc).not.toHaveBeenCalled();
    });

    it('uses the same IEEE-754 weighted progress calculation as the database', async () => {
        const tracks = {
            relationshipAi: {
                state: 'running' as const,
                stageCode: 'RELATIONSHIP_RUNNING',
                done: 0,
                total: 1,
            },
            interactions: {
                state: 'running' as const,
                stageCode: 'INTERACTIONS_RUNNING',
                done: 1,
                total: 12,
            },
            finalization: {
                state: 'running' as const,
                stageCode: 'FINALIZATION_RUNNING',
                done: 2,
                total: 3,
            },
        };
        const mock = client({
            snapshot: snapshot({
                progressBp: 874,
                tracks: {
                    relationshipAi: { ...tracks.relationshipAi, progressBp: 0 },
                    interactions: { ...tracks.interactions, progressBp: 833 },
                    finalization: { ...tracks.finalization, progressBp: 6_666 },
                },
                activeProfile: null,
                etaRange: null,
                lastEventSeq: 0,
            }),
            event: null,
            advanced: true,
        });

        await createAnalysisV2ProgressStore(mock).checkpoint(input({
            tracks,
            activeProfile: null,
            etaRange: null,
            event: null,
        }));

        expect(mock.rpc).toHaveBeenCalledWith(
            'checkpoint_analysis_v2_progress',
            expect.objectContaining({ p_progress_bp: 874 })
        );
    });

    it('fails closed when a checkpoint response does not match the persisted payload', async () => {
        const drifted = snapshot({
            activeProfile: { maskedUsername: 'w***g', imageUrl: null },
        });
        await expect(createAnalysisV2ProgressStore(client({
            snapshot: drifted,
            event: event(),
            advanced: true,
        })).checkpoint(input())).rejects.toThrow('checkpoint response drift');
    });

    it('rejects raw active handles and active foreground-only work', async () => {
        const store = createAnalysisV2ProgressStore(client(null));
        await expect(store.checkpoint(input({
            activeProfile: { maskedUsername: 'candidate', imageUrl: null },
        }))).rejects.toThrow();
        await expect(store.checkpoint(input({
            backgroundProcessing: false,
        }))).rejects.toThrow('server-owned');
    });

    it('requires the completed snapshot and event to agree', async () => {
        const completedTracks = {
            relationshipAi: {
                state: 'completed' as const,
                stageCode: 'RELATIONSHIP_AI_COMPLETE',
                done: 4,
                total: 4,
            },
            interactions: {
                state: 'completed' as const,
                stageCode: 'INTERACTIONS_COMPLETE',
                done: 2,
                total: 2,
            },
            finalization: {
                state: 'completed' as const,
                stageCode: 'ANALYSIS_COMPLETE',
                done: 1,
                total: 1,
            },
        };
        const store = createAnalysisV2ProgressStore(client(null));
        await expect(store.checkpoint(input({
            status: 'completed',
            backgroundProcessing: false,
            tracks: completedTracks,
            activeProfile: null,
            etaRange: null,
            event: null,
        }))).rejects.toThrow('terminal event');
        await expect(store.checkpoint(input({
            event: {
                state: 'confirmed',
                eventCode: 'ANALYSIS_COMPLETED',
                copyCode: 'ANALYSIS_COMPLETED',
                aggregateCount: null,
            },
        }))).rejects.toThrow('requires completed progress');
        await expect(store.checkpoint(input({
            status: 'failed',
            backgroundProcessing: false,
            activeProfile: null,
            etaRange: null,
        }))).rejects.toThrow('cannot append a finding event');
    });

    it('enforces provisional, corrected, and confirmed event semantics before persistence', async () => {
        const store = createAnalysisV2ProgressStore(client(null));
        await expect(store.checkpoint(input({
            event: {
                state: 'confirmed',
                eventCode: 'POTENTIAL_HIGH_RISK_FOUND',
                copyCode: 'POTENTIAL_HIGH_RISK_FOUND',
                aggregateCount: 1,
            },
        }))).rejects.toThrow('requires the provisional state');
        await expect(store.checkpoint(input({
            event: {
                state: 'provisional',
                eventCode: 'FINDING_CORRECTED',
                copyCode: 'FINDING_CORRECTED',
                aggregateCount: 1,
            },
        }))).rejects.toThrow('requires the corrected state');
        await expect(store.checkpoint(input({
            event: {
                state: 'corrected',
                eventCode: 'FINDING_CONFIRMED',
                copyCode: 'FINDING_CONFIRMED',
                aggregateCount: 1,
            },
        }))).rejects.toThrow('requires the confirmed state');
    });

    it('maps fenced and regressive database writes to bounded errors', async () => {
        await expect(createAnalysisV2ProgressStore(client(null, {
            message: 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH',
        })).checkpoint(input())).rejects.toBeInstanceOf(AnalysisV2ProgressFenceError);
        await expect(createAnalysisV2ProgressStore(client(null, {
            message: 'ANALYSIS_V2_PROGRESS_REGRESSION',
        })).checkpoint(input())).rejects.toBeInstanceOf(AnalysisV2ProgressConflictError);
    });

    it('loads an owner snapshot and a contiguous recovery page', async () => {
        const mock = client({
            snapshot: snapshot({ revision: 4, lastEventSeq: 3 }),
            events: [event(2), event(3, 4)],
        });
        const result = await createAnalysisV2ProgressStore(mock).loadForOwner({
            requestId,
            userId,
            afterSequence: 1,
            eventLimit: 50,
        });

        expect(result?.events.map(item => item.seq)).toEqual([2, 3]);
        expect(mock.rpc).toHaveBeenCalledWith('load_analysis_v2_progress', {
            p_request_id: requestId,
            p_user_id: userId,
            p_after_sequence: 1,
            p_event_limit: 50,
        });
    });

    it('masks and freshly signs bounded profile-outcome history on owner reads', async () => {
        const mock = client({
            snapshot: snapshot({
                candidateMediaRaw: [{
                    username: 'candidate.name',
                    profile: {
                        username: 'candidate.name',
                        fullName: 'Candidate Name',
                        bio: 'bio',
                        profilePicUrl: 'https://cdn.example/profile.jpg',
                        followersCount: 10,
                        followingCount: 8,
                        postsCount: 1,
                        isPrivate: false,
                        isVerified: false,
                        latestPosts: [{
                            id: 'post-1',
                            shortCode: 'post-1',
                            imageUrl: 'https://cdn.example/post.jpg',
                            type: 'image',
                            likesCount: 1,
                            commentsCount: 0,
                            timestamp: '2026-07-13T10:00:00.000Z',
                            taggedUsers: [],
                            mentionedUsers: [],
                        }],
                    },
                }],
            }),
            events: [],
        });
        const sign = vi.fn((raw: string) => `/api/image-proxy?token=${raw === 'https://cdn.example/profile.jpg' ? 'profile' : 'feed'}`);
        const store = createAnalysisV2ProgressStore(mock, {
            imageProxySigner: sign,
            candidateKeyDeriver: () => candidateKey,
        });

        const result = await store.loadForOwner({ requestId, userId });

        expect(result?.snapshot.candidateMedia).toEqual([{
            maskedUsername: 'c************e',
            imageUrl: '/api/image-proxy?token=profile',
            feedImageUrls: ['/api/image-proxy?token=feed'],
            candidateKey,
        }]);
        expect(JSON.stringify(result)).not.toContain('candidate.name');
        expect(sign).toHaveBeenCalledTimes(2);
    });

    it('fails closed on event gaps and future revisions', async () => {
        const storeWithGap = createAnalysisV2ProgressStore(client({
            snapshot: snapshot(),
            events: [event(2), event(4)],
        }));
        await expect(storeWithGap.loadForOwner({ requestId, userId }))
            .rejects.toThrow('invalid owner load response');

        const storeWithFuture = createAnalysisV2ProgressStore(client({
            snapshot: snapshot({ revision: 2 }),
            events: [event(2, 3)],
        }));
        await expect(storeWithFuture.loadForOwner({ requestId, userId }))
            .rejects.toThrow('invalid owner load response');
    });

    it('fails closed if an owner load retains transient profile data after termination', async () => {
        const store = createAnalysisV2ProgressStore(client({
            snapshot: snapshot({
                status: 'failed',
                backgroundProcessing: false,
                etaRange: null,
            }),
            events: [],
        }));

        await expect(store.loadForOwner({ requestId, userId }))
            .rejects.toThrow('invalid owner load response');
    });
});
