import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    AnalysisV2EvidenceConflictError,
    AnalysisV2EvidenceFenceError,
    AnalysisV2RelationshipIncompleteError,
    ANALYSIS_V2_EVIDENCE_DATABASE_NAMES,
    ANALYSIS_V2_EVIDENCE_PURGE_DESIGN,
    canonicalizeAnalysisV2TargetEvidenceRows,
    canonicalizeAnalysisV2TargetEvidenceSource,
    createAnalysisV2EvidenceStore,
    createAnalysisV2RelationshipNotApplicableInputHash,
    createAnalysisV2RelationshipResultHash,
    createAnalysisV2TargetEvidenceResultHash,
    deriveAnalysisV2MutualRows,
    type AnalysisV2EvidenceSupabaseClient,
    type AnalysisV2RelationshipRowInput,
    type AnalysisV2TargetEvidenceSourceInput,
    type AnalysisV2TargetEvidenceRowInput,
} from './v2-evidence-store';

// gitleaks:allow -- deterministic UUID fixtures
const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const relationshipJobKey = 'track:relationships:collect';
const targetJobKey = 'track:target-evidence:collect';
const inputHash = 'a'.repeat(64);
const jobInputHash = 'e'.repeat(64);

function relationshipRows(count: number): AnalysisV2RelationshipRowInput[] {
    return Array.from({ length: count }, (_, index) => ({
        username: `user_${index.toString().padStart(4, '0')}`,
        isPrivate: false,
        isVerified: index % 10 === 0,
    }));
}

function rpcClient() {
    const rpc = vi.fn();
    return {
        rpc,
        client: { rpc } as AnalysisV2EvidenceSupabaseClient,
    };
}

function validOperationKey(side: 'followers' | 'following'): string {
    return `relationship-${side}:${side === 'followers' ? 'b'.repeat(64) : 'c'.repeat(64)}`;
}

function sideResponse(
    side: 'followers' | 'following',
    rows: readonly AnalysisV2RelationshipRowInput[],
    declaredCount = rows.length
) {
    return {
        side,
        sourceStatus: declaredCount === 0 ? 'not_applicable' : 'collected',
        revision: 1,
        declaredCount,
        collectedCount: rows.length,
        coverageBps: declaredCount === 0
            ? 10_000
            : Math.floor(rows.length * 10_000 / declaredCount),
        inputHash: declaredCount === 0
            ? createAnalysisV2RelationshipNotApplicableInputHash(side)
            : inputHash,
        resultHash: createAnalysisV2RelationshipResultHash(side, rows),
    };
}

function targetRows(): AnalysisV2TargetEvidenceRowInput[] {
    return [
        {
            actorUsername: 'candidate.one',
            postId: 'post-1',
            signal: 'target_post_like',
            sourceInteractionId: 'like-1',
        },
        {
            actorUsername: 'candidate.two',
            postId: 'post-2',
            signal: 'target_post_comment',
            sourceInteractionId: 'comment-1',
            occurredAt: '2026-07-13T12:00:00.000Z',
            content: '  <b>hello</b>\u0000   world  ',
        },
    ];
}

function targetSourceInputs(
    rows: readonly AnalysisV2TargetEvidenceRowInput[]
): {
    likerSource: AnalysisV2TargetEvidenceSourceInput;
    commentSource: AnalysisV2TargetEvidenceSourceInput;
} {
    function source(
        signal: 'target_post_like' | 'target_post_comment'
    ): AnalysisV2TargetEvidenceSourceInput {
        const requestedLimit = signal === 'target_post_like' ? 150 : 15;
        const counts = new Map<string, number>();
        rows.filter(row => row.signal === signal).forEach((row) => {
            counts.set(row.postId, (counts.get(row.postId) ?? 0) + 1);
        });
        if (counts.size === 0) return { status: 'not_applicable', inputHash };
        const operationKind = signal === 'target_post_like'
            ? 'target-likers'
            : 'target-comments';
        return {
            status: 'collected',
            inputHash,
            provider: 'apify',
            providerRunId: signal === 'target_post_like' ? 'LikerRun1234' : 'CommentRun12',
            providerOperationKey: `${operationKind}:${signal === 'target_post_like'
                ? '6'.repeat(64)
                : '7'.repeat(64)}`,
            providerCredentialSlot: 'secondary',
            coverage: [...counts].map(([postId, returnedCount]) => ({
                postId,
                declaredCount: returnedCount,
                returnedCount,
                requestedLimit,
            })),
        };
    }
    return {
        likerSource: source('target_post_like'),
        commentSource: source('target_post_comment'),
    };
}

function canonicalTargetSources(rows: readonly AnalysisV2TargetEvidenceRowInput[]) {
    const sources = targetSourceInputs(rows);
    return {
        likerSource: canonicalizeAnalysisV2TargetEvidenceSource(
            'target_post_like', sources.likerSource
        ),
        commentSource: canonicalizeAnalysisV2TargetEvidenceSource(
            'target_post_comment', sources.commentSource
        ),
    };
}

describe('analysis V2 evidence store', () => {
    it('preserves all 1200 mutuals while limiting only detailed public screening to 900', () => {
        const followers = relationshipRows(1_200);
        const following = [...followers].reverse();
        const mutual = deriveAnalysisV2MutualRows({
            followers,
            following,
            excludedUsername: null,
            detailedMutualLimit: 900,
        });

        expect(mutual).toHaveLength(1_200);
        expect(mutual.filter(row => row.detailedOrdinal !== null)).toHaveLength(900);
        expect(mutual[0]).toMatchObject({
            username: 'user_1199',
            mutualOrdinal: 1,
            followingOrdinal: 1,
            detailedOrdinal: 1,
        });
        expect(mutual[899]?.detailedOrdinal).toBe(900);
        expect(mutual[900]?.detailedOrdinal).toBeNull();
        expect(mutual.at(-1)?.username).toBe('user_0000');
    });

    it('applies girlfriend exclusion before freezing ordinals and keeps every private mutual', () => {
        const followers = relationshipRows(1_200);
        const following = followers.map((row, index) => ({
            ...row,
            isPrivate: index < 1_000,
        }));
        const mutual = deriveAnalysisV2MutualRows({
            followers,
            following,
            excludedUsername: 'USER_0500',
            detailedMutualLimit: 900,
        });

        expect(mutual).toHaveLength(1_199);
        expect(mutual.some(row => row.username === 'user_0500')).toBe(false);
        expect(mutual.filter(row => row.isPrivate)).toHaveLength(999);
        expect(mutual.filter(row => row.detailedOrdinal !== null)).toHaveLength(200);
        expect(mutual.every((row, index) => row.mutualOrdinal === index + 1)).toBe(true);
        expect(mutual.filter(row => row.isPrivate)
            .every(row => row.detailedOrdinal === null)).toBe(true);
    });

    it('creates deterministic ordered relationship hashes', () => {
        const rows = relationshipRows(3);
        const original = createAnalysisV2RelationshipResultHash('following', rows);
        const replay = createAnalysisV2RelationshipResultHash('following', rows);
        const reordered = createAnalysisV2RelationshipResultHash(
            'following',
            [...rows].reverse()
        );
        const otherSide = createAnalysisV2RelationshipResultHash('followers', rows);

        expect(original).toMatch(/^[0-9a-f]{64}$/);
        expect(replay).toBe(original);
        expect(reordered).not.toBe(original);
        expect(otherSide).not.toBe(original);
        expect(original).not.toContain('user_0000');
    });

    it('keeps sanitized private names and profile images inside the immutable result', () => {
        const followers: AnalysisV2RelationshipRowInput[] = [{
            username: 'private.friend',
            isPrivate: true,
            isVerified: false,
            fullName: '  Kim\u0000   Mina  ',
            profilePicUrl: 'https://cdn.example.com/private.jpg',
        }];
        const following: AnalysisV2RelationshipRowInput[] = [{
            username: 'private.friend',
            isPrivate: true,
            isVerified: false,
        }];
        const mutual = deriveAnalysisV2MutualRows({
            followers,
            following,
            excludedUsername: null,
            detailedMutualLimit: 300,
        });

        expect(mutual).toEqual([expect.objectContaining({
            username: 'private.friend',
            fullName: 'Kim Mina',
            profilePicUrl: 'https://cdn.example.com/private.jpg',
            isPrivate: true,
            detailedOrdinal: null,
        })]);
        expect(createAnalysisV2RelationshipResultHash('followers', followers)).not.toBe(
            createAnalysisV2RelationshipResultHash('followers', [{
                ...followers[0]!,
                fullName: 'Kim Minji',
            }])
        );
    });

    it('rejects duplicate, overflowing, and below-99-percent relationship sets before RPC', async () => {
        const { rpc, client } = rpcClient();
        const store = createAnalysisV2EvidenceStore(client);
        const base = {
            requestId,
            jobKey: relationshipJobKey,
            claimToken,
            jobInputHash,
            side: 'followers' as const,
            source: {
                status: 'collected' as const,
                inputHash,
                provider: 'apify' as const,
                providerRunId: 'ApifyRun1234',
                providerOperationKey: validOperationKey('followers'),
            },
        };

        await expect(store.checkpointRelationshipSide({
            ...base,
            declaredCount: 100,
            rows: relationshipRows(98),
        })).rejects.toBeInstanceOf(AnalysisV2RelationshipIncompleteError);
        await expect(store.checkpointRelationshipSide({
            ...base,
            declaredCount: 2,
            rows: [relationshipRows(1)[0]!, relationshipRows(1)[0]!],
        })).rejects.toThrow('duplicate relationship username');
        await expect(store.checkpointRelationshipSide({
            ...base,
            declaredCount: 1_200,
            rows: relationshipRows(1_201),
        })).rejects.toThrow();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('checkpoints an exact side identity and verifies the database echo', async () => {
        const rows = relationshipRows(2);
        const { rpc, client } = rpcClient();
        rpc.mockResolvedValueOnce({ data: sideResponse('following', rows), error: null });
        const store = createAnalysisV2EvidenceStore(client);

        await expect(store.checkpointRelationshipSide({
            requestId,
            jobKey: relationshipJobKey,
            claimToken,
            jobInputHash,
            side: 'following',
            declaredCount: 2,
            source: {
                status: 'collected',
                inputHash,
                provider: 'apify',
                providerRunId: 'ApifyRun1234',
                providerOperationKey: validOperationKey('following'),
            },
            rows,
        })).resolves.toEqual(sideResponse('following', rows));

        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.checkpointRelationshipSideRpc,
            expect.objectContaining({
                p_claim_token: claimToken,
                p_job_input_hash: jobInputHash,
                p_side: 'following',
                p_declared_count: 2,
                p_input_hash: inputHash,
                p_result_hash: createAnalysisV2RelationshipResultHash('following', rows),
                p_provider: 'apify',
                p_provider_run_id: 'ApifyRun1234',
                p_provider_operation_key: validOperationKey('following'),
                p_rows: [
                    {
                        username: 'user_0000',
                        is_private: false,
                        is_verified: true,
                        full_name: null,
                        profile_pic_url: null,
                    },
                    {
                        username: 'user_0001',
                        is_private: false,
                        is_verified: false,
                        full_name: null,
                        profile_pic_url: null,
                    },
                ],
            })
        );
    });

    it('checkpoints a deterministic zero side without any provider identity', async () => {
        const { rpc, client } = rpcClient();
        const zeroInputHash = createAnalysisV2RelationshipNotApplicableInputHash('followers');
        rpc.mockResolvedValueOnce({
            data: sideResponse('followers', [], 0),
            error: null,
        });
        const store = createAnalysisV2EvidenceStore(client);

        await expect(store.checkpointRelationshipSide({
            requestId,
            jobKey: relationshipJobKey,
            claimToken,
            jobInputHash,
            side: 'followers',
            declaredCount: 0,
            source: { status: 'not_applicable', inputHash: zeroInputHash },
            rows: [],
        })).resolves.toEqual(sideResponse('followers', [], 0));

        expect(zeroInputHash).toMatch(/^[0-9a-f]{64}$/);
        expect(zeroInputHash).not.toBe(
            createAnalysisV2RelationshipNotApplicableInputHash('following')
        );
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.checkpointRelationshipNotApplicableRpc,
            {
                p_request_id: requestId,
                p_job_key: relationshipJobKey,
                p_claim_token: claimToken,
                p_job_input_hash: jobInputHash,
                p_side: 'followers',
            }
        );
        expect(JSON.stringify(rpc.mock.calls[0])).not.toMatch(
            /provider|operation|run_id|p_rows/i
        );
    });

    it('rejects forged or non-empty not-applicable relationship proofs before RPC', async () => {
        const { rpc, client } = rpcClient();
        const store = createAnalysisV2EvidenceStore(client);
        const common = {
            requestId,
            jobKey: relationshipJobKey,
            claimToken,
            jobInputHash,
            side: 'followers' as const,
            declaredCount: 0,
            rows: [] as AnalysisV2RelationshipRowInput[],
        };

        await expect(store.checkpointRelationshipSide({
            ...common,
            source: { status: 'not_applicable', inputHash },
        })).rejects.toBeInstanceOf(AnalysisV2RelationshipIncompleteError);
        await expect(store.checkpointRelationshipSide({
            ...common,
            source: {
                status: 'not_applicable',
                inputHash: createAnalysisV2RelationshipNotApplicableInputHash('followers'),
            },
            rows: relationshipRows(1),
        })).rejects.toBeInstanceOf(AnalysisV2RelationshipIncompleteError);
        await expect(store.checkpointRelationshipSide({
            ...common,
            source: {
                status: 'not_applicable',
                inputHash: createAnalysisV2RelationshipNotApplicableInputHash('followers'),
                providerRunId: 'ForbiddenRun123',
            } as never,
        })).rejects.toThrow();
        await expect(store.checkpointRelationshipSide({
            ...common,
            source: {
                status: 'collected',
                inputHash,
                provider: 'apify',
                providerRunId: 'ApifyRun1234',
                providerOperationKey: validOperationKey('followers'),
            },
        })).rejects.toBeInstanceOf(AnalysisV2RelationshipIncompleteError);
        expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects the wrong fixed job or missing job input fence before persistence', async () => {
        const rows = relationshipRows(1);
        const { rpc, client } = rpcClient();
        const store = createAnalysisV2EvidenceStore(client);
        const common = {
            requestId,
            claimToken,
            side: 'followers' as const,
            declaredCount: 1,
            source: {
                status: 'collected' as const,
                inputHash,
                provider: 'apify' as const,
                providerRunId: 'ApifyRun1234',
                providerOperationKey: validOperationKey('followers'),
            },
            rows,
        };

        await expect(store.checkpointRelationshipSide({
            ...common,
            jobKey: targetJobKey,
            jobInputHash,
        })).rejects.toBeInstanceOf(AnalysisV2EvidenceFenceError);
        await expect(store.checkpointRelationshipSide({
            ...common,
            jobKey: relationshipJobKey,
            jobInputHash: 'not-a-hash',
        })).rejects.toThrow('invalid job claim');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('fails closed when an RPC replay echoes a different immutable result', async () => {
        const rows = relationshipRows(2);
        const { rpc, client } = rpcClient();
        rpc.mockResolvedValueOnce({
            data: { ...sideResponse('followers', rows), resultHash: 'd'.repeat(64) },
            error: null,
        });
        const store = createAnalysisV2EvidenceStore(client);

        await expect(store.checkpointRelationshipSide({
            requestId,
            jobKey: relationshipJobKey,
            claimToken,
            jobInputHash,
            side: 'followers',
            declaredCount: 2,
            source: {
                status: 'collected',
                inputHash,
                provider: 'apify',
                providerRunId: 'ApifyRun1234',
                providerOperationKey: validOperationKey('followers'),
            },
            rows,
        })).rejects.toThrow('relationship checkpoint drift');
    });

    it('freezes only a catalog detailed limit and returns a PII-free DAG manifest', async () => {
        const { rpc, client } = rpcClient();
        const response = {
            revision: 1,
            resultHash: '1'.repeat(64),
            exclusionDecisionHash: '2'.repeat(64),
            followersResultHash: '3'.repeat(64),
            followingResultHash: '4'.repeat(64),
            mutualCount: 1_200,
            publicCount: 1_000,
            privateCount: 200,
            detailedPublicCount: 900,
            unscreenedPublicCount: 100,
        };
        rpc.mockResolvedValueOnce({ data: response, error: null });
        const store = createAnalysisV2EvidenceStore(client);

        await expect(store.freezeRelationships({
            requestId,
            jobKey: relationshipJobKey,
            claimToken,
            jobInputHash,
            detailedMutualLimit: 900,
        })).resolves.toEqual(response);
        expect(JSON.stringify(response)).not.toMatch(/username|comment|caption/i);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.freezeRelationshipsRpc,
            expect.objectContaining({ p_detailed_mutual_limit: 900 })
        );
    });

    it('filters the target and girlfriend before target evidence is hashed or persisted', () => {
        const canonical = canonicalizeAnalysisV2TargetEvidenceRows({
            targetUsername: 'target.account',
            excludedUsername: 'girlfriend.account',
            rows: [
                ...targetRows(),
                {
                    actorUsername: 'TARGET.ACCOUNT',
                    postId: 'post-1',
                    signal: 'target_post_like',
                    sourceInteractionId: 'target-like',
                },
                {
                    actorUsername: 'girlfriend.account',
                    postId: 'post-1',
                    signal: 'target_post_comment',
                    sourceInteractionId: 'girlfriend-comment',
                    content: 'exclude me',
                },
            ],
        });

        expect(canonical).toHaveLength(2);
        expect(canonical.map(row => row.actorUsername)).toEqual([
            'candidate.one',
            'candidate.two',
        ]);
        expect(canonical[1]?.content).toBe('hello world');
        expect(JSON.stringify(canonical)).not.toContain('girlfriend.account');
    });

    it('accepts the exact 4x150 plus 6x15 ceiling', () => {
        const rows: AnalysisV2TargetEvidenceRowInput[] = [];
        for (let post = 0; post < 4; post += 1) {
            for (let item = 0; item < 150; item += 1) {
                rows.push({
                    actorUsername: `like_${post}_${item}`,
                    postId: `like-post-${post}`,
                    signal: 'target_post_like',
                    sourceInteractionId: `like-${post}-${item}`,
                });
            }
        }
        for (let post = 0; post < 6; post += 1) {
            for (let item = 0; item < 15; item += 1) {
                rows.push({
                    actorUsername: `comment_${post}_${item}`,
                    postId: `comment-post-${post}`,
                    signal: 'target_post_comment',
                    sourceInteractionId: `comment-${post}-${item}`,
                    content: `comment ${item}`,
                });
            }
        }

        const canonical = canonicalizeAnalysisV2TargetEvidenceRows({
            rows,
            targetUsername: 'target',
            excludedUsername: null,
        });
        expect(canonical).toHaveLength(690);
        expect(createAnalysisV2TargetEvidenceResultHash(canonical, canonicalTargetSources(rows)))
            .toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects duplicate source IDs and per-signal post overflow', () => {
        const duplicate = targetRows();
        duplicate.push({ ...duplicate[0]! });
        expect(() => canonicalizeAnalysisV2TargetEvidenceRows({
            rows: duplicate,
            targetUsername: 'target',
            excludedUsername: null,
        })).toThrow('duplicate source interaction');

        const fiveLikerPosts = Array.from({ length: 5 }, (_, index) => ({
            actorUsername: `candidate_${index}`,
            postId: `post-${index}`,
            signal: 'target_post_like' as const,
            sourceInteractionId: `like-${index}`,
        }));
        expect(() => canonicalizeAnalysisV2TargetEvidenceRows({
            rows: fiveLikerPosts,
            targetUsername: 'target',
            excludedUsername: null,
        })).toThrow('target_post_like scope overflow');
    });

    it('does not accept interaction rows without a collected provider coverage source', async () => {
        const { rpc, client } = rpcClient();
        const store = createAnalysisV2EvidenceStore(client);
        await expect(store.checkpointTargetEvidence({
            requestId,
            jobKey: targetJobKey,
            claimToken,
            jobInputHash,
            targetUsername: 'target.account',
            excludedUsername: null,
            inputHash,
            likerSource: { status: 'not_applicable', inputHash },
            commentSource: { status: 'not_applicable', inputHash },
            rows: targetRows(),
        })).rejects.toThrow('evidence has no collected provider source');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('checkpoints only sanitized bounded target evidence and verifies exact hashes', async () => {
        const rawRows = targetRows();
        const canonical = canonicalizeAnalysisV2TargetEvidenceRows({
            rows: rawRows,
            targetUsername: 'target.account',
            excludedUsername: 'girlfriend.account',
        });
        const sources = targetSourceInputs(rawRows);
        const canonicalSources = canonicalTargetSources(rawRows);
        const resultHash = createAnalysisV2TargetEvidenceResultHash(
            canonical,
            canonicalSources
        );
        const { rpc, client } = rpcClient();
        rpc.mockResolvedValueOnce({
            data: {
                revision: 1,
                resultHash,
                inputHash,
                interactorCount: 2,
                likerCount: 1,
                commentCount: 1,
            },
            error: null,
        });
        const store = createAnalysisV2EvidenceStore(client);

        await expect(store.checkpointTargetEvidence({
            requestId,
            jobKey: targetJobKey,
            claimToken,
            jobInputHash,
            targetUsername: 'TARGET.ACCOUNT',
            excludedUsername: 'GIRLFRIEND.ACCOUNT',
            inputHash,
            ...sources,
            rows: rawRows,
        })).resolves.toMatchObject({ interactorCount: 2, resultHash });

        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.checkpointTargetEvidenceRpc,
            expect.objectContaining({
                p_target_username: 'target.account',
                p_excluded_username: 'girlfriend.account',
                p_job_input_hash: jobInputHash,
                p_result_hash: resultHash,
                p_liker_source: expect.objectContaining({
                    status: 'collected',
                    provider_run_id: 'LikerRun1234',
                    provider_credential_slot: 'secondary',
                    coverage: [expect.objectContaining({
                        post_id: 'post-1',
                        requested_limit: 150,
                    })],
                }),
                p_comment_source: expect.objectContaining({
                    status: 'collected',
                    provider_run_id: 'CommentRun12',
                    coverage: [expect.objectContaining({
                        post_id: 'post-2',
                        requested_limit: 15,
                    })],
                }),
                p_rows: [
                    expect.objectContaining({
                        actor_username: 'candidate.one',
                        signal: 'target_post_like',
                        content: null,
                    }),
                    expect.objectContaining({
                        actor_username: 'candidate.two',
                        signal: 'target_post_comment',
                        content: 'hello world',
                    }),
                ],
            })
        );
    });

    it('maps live-claim and immutable replay conflicts to typed errors', async () => {
        const rows = relationshipRows(1);
        const first = rpcClient();
        first.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH' },
        });
        await expect(createAnalysisV2EvidenceStore(first.client)
            .checkpointRelationshipSide({
                requestId,
                jobKey: relationshipJobKey,
                claimToken,
                jobInputHash,
                side: 'followers',
                declaredCount: 1,
                source: {
                    status: 'collected',
                    inputHash,
                    provider: 'apify',
                    providerRunId: 'ApifyRun1234',
                    providerOperationKey: validOperationKey('followers'),
                },
                rows,
            })).rejects.toBeInstanceOf(AnalysisV2EvidenceFenceError);

        const second = rpcClient();
        second.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_RELATIONSHIP_SIDE_CONFLICT' },
        });
        await expect(createAnalysisV2EvidenceStore(second.client)
            .checkpointRelationshipSide({
                requestId,
                jobKey: relationshipJobKey,
                claimToken,
                jobInputHash,
                side: 'followers',
                declaredCount: 1,
                source: {
                    status: 'collected',
                    inputHash,
                    provider: 'apify',
                    providerRunId: 'ApifyRun1234',
                    providerOperationKey: validOperationKey('followers'),
                },
                rows,
            })).rejects.toBeInstanceOf(AnalysisV2EvidenceConflictError);
    });

    it('documents terminal PII cleanup without exposing an ad-hoc purge method', () => {
        expect(ANALYSIS_V2_EVIDENCE_PURGE_DESIGN.piiTables).toContain(
            'analysis_target_interactors'
        );
        expect(ANALYSIS_V2_EVIDENCE_PURGE_DESIGN.retainedLedgers).toEqual([
            'analysis_v2_provider_runs',
            'analysis_v2_ai_attempts',
        ]);
        expect(ANALYSIS_V2_EVIDENCE_DATABASE_NAMES).not.toHaveProperty('purgeRpc');
        expect(createAnalysisV2EvidenceStore({ rpc: vi.fn() })).not.toHaveProperty(
            'purgeTerminal'
        );
    });
});
