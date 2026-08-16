import { describe, expect, it } from 'vitest';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    buildConciergeManualPublication,
    CONCIERGE_BATCH_PUBLICATION_RPC,
    ConciergePublicationError,
    createConciergePublicationStore,
    createSupabaseConciergePublicationStore,
    publishConciergeManualOverride,
    type ConciergeManualPublicationInput,
    type ConciergePublicationStore,
} from './concierge-batch-publication';
import {
    parseConciergeClassificationCsv,
    type ConciergeClassificationLedger,
} from './concierge-classification-import';
import type { ReplayAccountAiDetail } from './replay/replay-runner';

const HASH = 'a'.repeat(64);

function reverseObjectKeys<T>(value: T): T {
    if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
    ) as T;
}

function makeFeature() {
    return {
        features: {
            appearanceGrade: 3,
            exposureScore: 2,
            accountContext: 'personal',
            partnerExclusionContext: 'none',
            marriageEvidence: 'none',
            partnerEvidence: 'none',
            oneLineOverview: '공개 프로필과 피드에서 확인된 특징을 중심으로 정리한 계정입니다.',
        },
    } as unknown as FeatureAnalysisResult;
}

function makeLedger(): ConciergeClassificationLedger {
    const pass = { status: 'collected' as const, fullNamePresent: true, profilePicPresent: true, feedDeclared: 1, feedCollected: 1, completeMedia: true, evidenceHash: HASH };
    const coverage = { declared: 1, collected: 1, selected: 1, complete: true, basisPoints: 10_000, hash: HASH };
    return {
        revision: 1, relationshipResultHash: HASH, partitionHash: 'b'.repeat(64), mutualCount: 3,
        hydratedPublicCount: 2, hydratedPrivateCount: 1, unresolvedCount: 0,
        records: [
            { candidateId: 'candidate:one', instagramId: 'one', mutualOrdinal: 1, partition: 'public', profileFetchStatus: 'success', firstPass: pass, secondPass: pass, originalAiClassification: 'unknown', effectiveClassification: 'unknown', confidence: 'low', evidenceCoverage: coverage, classifier: 'replay', modelName: 'model', promptVersion: 'prompt', schemaVersion: 'schema', classificationOperationKey: 'op', classificationResultHash: HASH, classificationSource: 'ai', manualOverride: null, sourceSnapshot: { instagramUrl: 'https://instagram.com/one', originalAiClassification: 'unknown', confidenceEvidence: 'confidence=low;evidence=model_ambiguous', operatorNote: '' } },
            { candidateId: 'candidate:two', instagramId: 'two', mutualOrdinal: 2, partition: 'public', profileFetchStatus: 'success', firstPass: pass, secondPass: pass, originalAiClassification: 'female', effectiveClassification: 'female', confidence: 'high', evidenceCoverage: coverage, classifier: 'replay', modelName: 'model', promptVersion: 'prompt', schemaVersion: 'schema', classificationOperationKey: 'op', classificationResultHash: HASH, classificationSource: 'ai', manualOverride: null, sourceSnapshot: { instagramUrl: 'https://instagram.com/two', originalAiClassification: 'female', confidenceEvidence: 'confidence=high;evidence=model_ambiguous', operatorNote: '' } },
            { candidateId: 'candidate:private', instagramId: 'private', mutualOrdinal: 3, partition: 'private', profileFetchStatus: 'success', firstPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null }, secondPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null }, originalAiClassification: null, effectiveClassification: null, confidence: null, evidenceCoverage: null, classifier: null, modelName: null, promptVersion: null, schemaVersion: null, classificationOperationKey: null, classificationResultHash: null, classificationSource: 'not_applicable', manualOverride: null },
        ],
    };
}

function makeEvidenceInput(permuted = false): ConciergeManualPublicationInput {
    const input = makeInput();
    const targetPosts = [
        { id: 'target-post-1', shortCode: 'target-1', type: 'image', likesCount: 1, commentsCount: 0, timestamp: '2026-01-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: ['one'] },
        { id: 'target-post-2', shortCode: 'target-2', type: 'image', likesCount: 2, commentsCount: 0, timestamp: '2026-01-02T00:00:00.000Z', taggedUsers: [], mentionedUsers: ['two'] },
    ];
    const candidatePostsByUsername = new Map([
        ['one', [
            { id: 'candidate-post-1', shortCode: 'candidate-1', type: 'image', likesCount: 1, commentsCount: 0, timestamp: '2026-01-01T00:00:00.000Z', taggedUsers: ['target'], mentionedUsers: [] },
            { id: 'candidate-post-2', shortCode: 'candidate-2', type: 'image', likesCount: 2, commentsCount: 0, timestamp: '2026-01-02T00:00:00.000Z', taggedUsers: [], mentionedUsers: [] },
        ]],
        ['two', [{ id: 'candidate-post-3', shortCode: 'candidate-3', type: 'image', likesCount: 3, commentsCount: 0, timestamp: '2026-01-03T00:00:00.000Z', taggedUsers: [], mentionedUsers: [] }]],
    ]);
    const targetToCandidate = {
        status: 'collected' as const,
        evidence: [
            { actorUsername: 'one', postId: 'target-post-1', signal: 'target_post_like' as const, sourceInteractionId: 'target-like-1' },
            { actorUsername: 'two', postId: 'target-post-2', signal: 'target_post_like' as const, sourceInteractionId: 'target-like-2' },
        ],
        observedUsernames: ['one', 'two'], likerCoverage: [], commentCoverage: [],
    };
    const candidateToTarget = {
        status: 'collected' as const,
        evidence: [
            { candidateUsername: 'one', postId: 'candidate-post-1', signal: 'target_female_like' as const, sourceInteractionId: 'reverse-like-1' },
            { candidateUsername: 'two', postId: 'candidate-post-3', signal: 'target_female_like' as const, sourceInteractionId: 'reverse-like-2' },
        ],
        coverage: [],
    };
    const replay = {
        ...input.replay,
        bidirectionalInteractions: {
            targetToCandidate: permuted ? { ...targetToCandidate, evidence: [...targetToCandidate.evidence].reverse(), observedUsernames: ['two', 'one'] } : targetToCandidate,
            candidateToTarget: permuted ? { ...candidateToTarget, evidence: [...candidateToTarget.evidence].reverse() } : candidateToTarget,
            targetPosts: permuted ? [...targetPosts].reverse() : targetPosts,
            candidatePostsByUsername: permuted
                ? new Map([...candidatePostsByUsername.entries()].reverse().map(([name, posts]) => [name, [...posts].reverse()]))
                : candidatePostsByUsername,
            reverseLikeStatusByUsername: permuted
                ? new Map([['two', 'not_observed' as const], ['one', 'observed' as const]])
                : new Map([['one', 'observed' as const], ['two', 'not_observed' as const]]),
            targetInputHash: HASH, candidateInputHash: 'b'.repeat(64), reverseLikeInputHash: 'c'.repeat(64), coverageHash: 'd'.repeat(64),
        },
    };
    return { ...input, replay: replay as unknown as ConciergeManualPublicationInput['replay'] };
}

function makeInput(): ConciergeManualPublicationInput {
    const csv = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,female,\n';
    const manualImport = parseConciergeClassificationCsv(csv, 'order', 'request', HASH, 'b'.repeat(64), '2026-08-14T00:00:00.000Z');
    return {
        orderId: 'order', requestId: 'request', resultRequestId: 'request', ownerId: 'owner',
        targetUsername: 'target', targetInputHash: 'c'.repeat(64), sourceRequestId: 'source',
        replayLineageHash: 'd'.repeat(64), relationshipManifestHash: HASH,
        expectedMutualCount: 3, expectedHydratedCount: 3,
        expectedVersion: 7, expectedResultHash: 'e'.repeat(64),
        currentPublication: { version: 7, resultHash: 'e'.repeat(64), resultUrl: '/result/request' },
        ledger: makeLedger(), manualImport,
        replay: {
            profilesByOrdinal: new Map([
                [1, { username: 'one', isPrivate: false, profilePicUrl: null, fullName: null, bio: '드로잉 작업실', followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
                [2, { username: 'two', isPrivate: false, profilePicUrl: null, fullName: null, bio: '필름 사진 기록', followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
            ]),
            details: [
                { ordinal: 1, finalClassification: 'unresolved', classificationSource: 'unknown', featureOverview: null, triage: null, feature: makeFeature() },
                { ordinal: 2, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'x', triage: null, feature: makeFeature() },
            ] as unknown as readonly ReplayAccountAiDetail[],
            orderedMutualUsernames: ['one', 'two', 'private'], targetInteractions: [],
            bidirectionalInteractions: {
                targetToCandidate: { status: 'not_collected', evidence: [], observedUsernames: [], likerCoverage: [], commentCoverage: [] },
                candidateToTarget: { status: 'not_collected', evidence: [], coverage: [] },
                targetPosts: [], candidatePostsByUsername: new Map(), reverseLikeStatusByUsername: new Map(),
                targetInputHash: HASH, candidateInputHash: 'b'.repeat(64), reverseLikeInputHash: 'c'.repeat(64), coverageHash: 'd'.repeat(64),
            },
            classificationByOrdinal: new Map([
                [1, { originalAiClassification: 'unknown', confidence: 'low', classifier: 'replay', modelName: 'model', promptVersion: 'prompt', schemaVersion: 'schema', classificationOperationKey: 'op', classificationResultHash: HASH, secondPassStatus: 'collected', secondPassCompleteMedia: true }],
                [2, { originalAiClassification: 'female', confidence: 'high', classifier: 'replay', modelName: 'model', promptVersion: 'prompt', schemaVersion: 'schema', classificationOperationKey: 'op', classificationResultHash: HASH, secondPassStatus: 'collected', secondPassCompleteMedia: true }],
            ]),
            privateProfiles: [{ username: 'private', isPrivate: true, profilePicUrl: null, fullName: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
            privateNameResults: [{ id: 'private', femaleScore: 0.5, isName: false, confidence: 0 }],
            fetchedCount: 3, hydratedPublicCount: 2, hydratedPrivateCount: 1, analyzedPublicCount: 2, unresolvedCount: 0,
        },
    };
}

describe('concierge manual publication', () => {
    it('recomputes canonical candidates while preserving the existing result URL', () => {
        const publication = buildConciergeManualPublication(makeInput());
        expect(publication.resultUrl).toBe('/result/request');
        expect(publication.rows).toHaveLength(2);
        expect(publication.counts).toMatchObject({ male: 0, female: 2, unknown: 0, public: 2, private: 1, mutual: 3, authoritativeMutual: 3, hydrated: 3, analyzed: 2 });
        expect(publication.resultHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('carries text-only private-name likelihoods through the atomic publication payload in display order', async () => {
        const input = makeInput();
        const privateProfiles = [
            { username: 'zulu', isPrivate: true, profilePicUrl: 'https://images.example/zulu.jpg', fullName: '줄리', followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] },
            { username: 'beta', isPrivate: true, profilePicUrl: 'https://images.example/beta.jpg', fullName: '베타', followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] },
            { username: 'alpha', isPrivate: true, profilePicUrl: 'https://images.example/alpha.jpg', fullName: '알파', followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] },
        ] as unknown as InstagramProfile[];
        const privateTemplate = input.ledger.records.find(record => record.instagramId === 'private')!;
        const privateRecords = privateProfiles.map((profile, index) => ({
            ...privateTemplate,
            candidateId: `candidate:${profile.username}`,
            instagramId: profile.username,
            mutualOrdinal: index + 3,
        }));
        const replay = {
            ...input.replay,
            orderedMutualUsernames: ['one', 'two', 'zulu', 'beta', 'alpha'],
            privateProfiles,
            privateNameResults: [
                { id: 'zulu', femaleScore: 0.7, isName: true, confidence: 0.2 },
                { id: 'beta', femaleScore: 0.9, isName: true, confidence: 0.6 },
                { id: 'alpha', femaleScore: 0.9, isName: true, confidence: 0.6 },
            ],
            fetchedCount: 5,
            hydratedPrivateCount: 3,
        } as unknown as ConciergeManualPublicationInput['replay'];
        const publicationInput = {
            ...input,
            expectedMutualCount: 5,
            expectedHydratedCount: 5,
            ledger: {
                ...input.ledger,
                mutualCount: 5,
                hydratedPrivateCount: 3,
                records: [
                    ...input.ledger.records.filter(record => record.instagramId !== 'private'),
                    ...privateRecords,
                ],
            },
            replay,
        };

        const publication = buildConciergeManualPublication(publicationInput);

        expect(publication.privateRows).toEqual([
            { sort_ordinal: 1, instagram_id: 'alpha', profile_image: 'https://images.example/alpha.jpg', full_name: '알파', name_female_score: Math.fround(0.9), name_is_name: true, name_confidence: Math.fround(0.6) },
            { sort_ordinal: 2, instagram_id: 'beta', profile_image: 'https://images.example/beta.jpg', full_name: '베타', name_female_score: Math.fround(0.9), name_is_name: true, name_confidence: Math.fround(0.6) },
            { sort_ordinal: 3, instagram_id: 'zulu', profile_image: 'https://images.example/zulu.jpg', full_name: '줄리', name_female_score: Math.fround(0.7), name_is_name: true, name_confidence: Math.fround(0.2) },
        ]);
        expect(publication.counts).toMatchObject({ male: 0, female: 2, unknown: 0, public: 2, private: 3 });
        expect(publication.rows.every(row => row.gender_status === 'confirmed')).toBe(true);

        let forwarded: Readonly<Record<string, unknown>> | null = null;
        const store = createConciergePublicationStore(async args => {
            forwarded = args;
            return {
                data: {
                    published: true,
                    idempotent: false,
                    ownerReadContractVerified: true,
                    adminReadContractVerified: true,
                    resultHash: publication.resultHash,
                    resultUrl: publication.resultUrl,
                    requestId: publication.requestId,
                    version: publicationInput.expectedVersion + 1,
                    counts: publication.counts,
                    privateRows: publication.privateRows.map(row => ({
                        sortOrdinal: row.sort_ordinal,
                        instagramId: row.instagram_id,
                        profileImage: row.profile_image,
                        fullName: row.full_name,
                        nameFemaleScore: row.name_female_score,
                        nameIsName: row.name_is_name,
                        nameConfidence: row.name_confidence,
                    })),
                },
                error: null,
            };
        });

        await expect(store.publishAtomic({
            publication,
            expectedVersion: publicationInput.expectedVersion,
            expectedResultHash: publicationInput.expectedResultHash,
            orderId: publicationInput.orderId,
            requestId: publicationInput.requestId,
            ownerId: publicationInput.ownerId,
            targetUsername: publicationInput.targetUsername,
            classificationLedger: publicationInput.ledger,
            manualImport: publicationInput.manualImport,
        })).resolves.toEqual({ published: true, idempotent: false });
        expect(forwarded).toMatchObject({
            publication: {
                privateRows: publication.privateRows,
            },
        });
    });

    it('does not admit a manual female without complete collected second-pass media', () => {
        const input = makeInput();
        const records = input.ledger.records.map(record => record.instagramId === 'one'
            ? {
                ...record,
                secondPass: { ...record.secondPass, status: 'not_collected' as const, completeMedia: false },
            }
            : record);
        const classificationByOrdinal = new Map(input.replay.classificationByOrdinal);
        classificationByOrdinal.set(1, {
            ...classificationByOrdinal.get(1)!, secondPassStatus: 'not_collected', secondPassCompleteMedia: false,
        });
        expect(() => buildConciergeManualPublication({
            ...input, ledger: { ...input.ledger, records }, replay: { ...input.replay, classificationByOrdinal },
        })).toThrow('CONCIERGE_PUBLICATION_SECOND_PASS_INCOMPLETE');
    });

    it('recomputes from exact bidirectional evidence, coverage status, and per-account overview', () => {
        const input = makeInput();
        const replay = {
            ...input.replay,
            bidirectionalInteractions: {
                targetToCandidate: {
                    status: 'collected',
                    evidence: [{ actorUsername: 'one', postId: 'target-post', signal: 'target_post_like', sourceInteractionId: 'target-like' }],
                    observedUsernames: ['one'], likerCoverage: [], commentCoverage: [],
                },
                candidateToTarget: {
                    status: 'collected',
                    evidence: [{ candidateUsername: 'one', postId: 'candidate-post', signal: 'target_female_like', sourceInteractionId: 'reverse-like' }],
                    coverage: [],
                },
                targetPosts: [{ id: 'target-post', shortCode: 'target', type: 'image', likesCount: 1, commentsCount: 0, timestamp: '2026-01-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: ['one'] }],
                candidatePostsByUsername: new Map([
                    ['one', [{ id: 'candidate-post', shortCode: 'candidate', type: 'image', likesCount: 1, commentsCount: 0, timestamp: '2026-01-01T00:00:00.000Z', taggedUsers: ['target'], mentionedUsers: [] }]],
                    ['two', []],
                ]),
                reverseLikeStatusByUsername: new Map([['one', 'observed']]),
                targetInputHash: HASH,
                candidateInputHash: 'b'.repeat(64),
                reverseLikeInputHash: 'c'.repeat(64),
                coverageHash: 'd'.repeat(64),
            },
        } as unknown as ConciergeManualPublicationInput['replay'];
        const publication = buildConciergeManualPublication({ ...input, replay });
        const row = publication.rows[0] as unknown as Record<string, unknown>;
        expect(row.one_line_overview).toContain('드로잉');
        expect(row.likes_count).toBe(1);
        expect(row.is_tagged).toBe(true);
        expect(publication.interactionLineageHash).toMatch(/^[a-f0-9]{64}$/);
        const changed = buildConciergeManualPublication({
            ...input,
            replay: {
                ...replay,
                bidirectionalInteractions: {
                    ...replay.bidirectionalInteractions,
                    reverseLikeStatusByUsername: new Map([['one', 'not_observed']]),
                },
            },
        });
        expect(changed.resultHash).not.toBe(publication.resultHash);
    });

    it('produces permutation-stable interaction lineage and result hashes', () => {
        const first = buildConciergeManualPublication(makeEvidenceInput());
        const retry = buildConciergeManualPublication(makeEvidenceInput(true));
        expect(retry.interactionLineageHash).toBe(first.interactionLineageHash);
        expect(retry.resultHash).toBe(first.resultHash);
    });

    it('keeps result hashes stable when ledger object key insertion order changes', () => {
        const input = makeInput();
        const first = buildConciergeManualPublication(input);
        const retry = buildConciergeManualPublication({
            ...input,
            ledger: reverseObjectKeys(input.ledger),
        });
        expect(retry.ledgerHash).toBe(first.ledgerHash);
        expect(retry.resultHash).toBe(first.resultHash);
    });

    it('deeply freezes hashed rows and interaction evidence before forwarding', () => {
        const input = makeEvidenceInput();
        const publication = buildConciergeManualPublication(input);
        const originalHash = publication.resultHash;
        (input.replay.bidirectionalInteractions.targetPosts[0] as { likesCount: number }).likesCount = 999;
        expect(publication.resultHash).toBe(originalHash);
        expect(Object.isFrozen(publication)).toBe(true);
        expect(Object.isFrozen(publication.rows)).toBe(true);
        expect(Object.isFrozen(publication.rows[0])).toBe(true);
        expect(Object.isFrozen(publication.interactionLineage)).toBe(true);
        expect(() => (((publication.rows as unknown as Array<Record<string, unknown>>)[0]!.risk_analysis) as string[]).push('mutation')).toThrow();
    });

    it('rejects evidence whose post snapshot is stale or points in the wrong direction', () => {
        const stale = makeEvidenceInput();
        stale.replay.bidirectionalInteractions.targetToCandidate.evidence = [{
            actorUsername: 'one', postId: 'missing-post', signal: 'target_post_like', sourceInteractionId: 'stale',
        }];
        expect(() => buildConciergeManualPublication(stale)).toThrow('CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH');
        const wrongDirection = makeEvidenceInput();
        wrongDirection.replay.bidirectionalInteractions.candidateToTarget.evidence = [{
            candidateUsername: 'one', postId: 'candidate-post-1', signal: 'target_post_like', sourceInteractionId: 'wrong-direction',
        } as never];
        expect(() => buildConciergeManualPublication(wrongDirection)).toThrow('CONCIERGE_PUBLICATION_INTERACTION_DIRECTION_MISMATCH');
    });

    it('rejects a stale version or changed expected publication hash before the write', () => {
        const input = makeInput();
        expect(() => buildConciergeManualPublication({ ...input, expectedVersion: 6 })).toThrow('CONCIERGE_PUBLICATION_STALE_VERSION');
        expect(() => buildConciergeManualPublication({ ...input, expectedResultHash: 'f'.repeat(64) })).toThrow('CONCIERGE_PUBLICATION_STALE_VERSION');
        expect(() => buildConciergeManualPublication({ ...input, expectedMutualCount: 134 })).toThrow('CONCIERGE_PUBLICATION_PARTITION_COUNT_MISMATCH');
        expect(() => buildConciergeManualPublication({
            ...input,
            manualImport: { ...input.manualImport, requestId: 'other-request' },
        })).toThrow('CONCIERGE_PUBLICATION_SCOPE_CONFLICT');
    });

    it('rolls back when the atomic store rejects the guarded write', async () => {
        const input = makeInput();
        const state = { committed: false };
        const store: ConciergePublicationStore = {
            async publishAtomic() {
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_ROLLBACK');
            },
        };
        await expect(publishConciergeManualOverride(input, store)).rejects.toThrow('CONCIERGE_PUBLICATION_ROLLBACK');
        expect(state.committed).toBe(false);
    });

    it('rejects a replay whose private projection is not the frozen private partition', () => {
        const input = makeInput();
        expect(() => buildConciergeManualPublication({
            ...input,
            replay: {
                ...input.replay,
                privateProfiles: [{
                    ...input.replay.privateProfiles[0]!, isPrivate: false,
                }],
            },
        })).toThrow('CONCIERGE_PUBLICATION_PRIVATE_PARTITION_MISMATCH');
    });

    it('does not treat failed interaction collection as observed evidence', () => {
        const input = makeInput();
        expect(() => buildConciergeManualPublication({
            ...input,
            replay: {
                ...input.replay,
                bidirectionalInteractions: {
                    ...input.replay.bidirectionalInteractions,
                    targetToCandidate: {
                        ...input.replay.bidirectionalInteractions.targetToCandidate,
                        status: 'failed', evidence: [{
                            actorUsername: 'one', postId: 'target-post', signal: 'target_post_like', sourceInteractionId: 'stale',
                        }],
                    },
                },
            },
        })).toThrow('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    });

    it('returns an idempotent result for an already published hash without a second write', async () => {
        const input = makeInput();
        const first = buildConciergeManualPublication(input);
        let writes = 0;
        const store: ConciergePublicationStore = { async publishAtomic() { writes += 1; return { published: true, idempotent: writes > 1 }; } };
        const firstInput = {
            ...input,
            expectedResultHash: null,
            currentPublication: { ...input.currentPublication, resultHash: null },
        };
        const published = await publishConciergeManualOverride(firstInput, store);
        expect(published.resultHash).toBe(first.resultHash);
        const retry = await publishConciergeManualOverride({ ...input, currentPublication: { ...input.currentPublication, resultHash: first.resultHash } }, store);
        expect(retry.idempotent).toBe(true);
        expect(writes).toBe(2);
    });

    it('consults the guarded store even when the caller snapshot already has the result hash', async () => {
        const input = makeInput();
        const publication = buildConciergeManualPublication(input);
        let calls = 0;
        const store: ConciergePublicationStore = {
            async publishAtomic() {
                calls += 1;
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_STALE_VERSION');
            },
        };
        await expect(publishConciergeManualOverride({
            ...input, currentPublication: { ...input.currentPublication, resultHash: publication.resultHash },
        }, store)).rejects.toThrow('CONCIERGE_PUBLICATION_STALE_VERSION');
        expect(calls).toBe(1);
    });

    it('binds result URL to request identity and includes it in the result hash', () => {
        const input = makeInput();
        expect(() => buildConciergeManualPublication({
            ...input, currentPublication: { ...input.currentPublication, resultUrl: '/result/other-request' },
        })).toThrow('CONCIERGE_PUBLICATION_RESULT_URL_MISMATCH');
        const other = buildConciergeManualPublication({
            ...input, currentPublication: { ...input.currentPublication, resultUrl: '/result/request' },
        });
        expect(other.resultHash).toBe(buildConciergeManualPublication(input).resultHash);
    });

    it('rejects a replay whose original AI operation, result hash, or versions drift from the ledger', () => {
        const input = makeInput();
        const classificationByOrdinal = new Map([[1, {
            originalAiClassification: 'male', confidence: 'low', classifier: 'replay', modelName: 'model',
            promptVersion: 'prompt', schemaVersion: 'schema', classificationOperationKey: 'op',
            classificationResultHash: HASH, secondPassStatus: 'collected', secondPassCompleteMedia: true,
        }]]);
        expect(() => buildConciergeManualPublication({
            ...input,
            replay: { ...input.replay, classificationByOrdinal } as unknown as ConciergeManualPublicationInput['replay'],
        })).toThrow('CONCIERGE_PUBLICATION_REPLAY_AI_BINDING_MISMATCH');
    });

    it('maps only the guarded RPC contract and rejects malformed RPC responses', async () => {
        const publication = buildConciergeManualPublication(makeInput());
        let forwarded: Readonly<Record<string, unknown>> | null = null;
        const store = createConciergePublicationStore(async args => {
            forwarded = args;
            return {
                data: {
                    published: true, idempotent: false,
                    ownerReadContractVerified: true, adminReadContractVerified: true,
                    resultHash: publication.resultHash, resultUrl: publication.resultUrl,
                    requestId: publication.requestId, version: 8, counts: publication.counts,
                    privateRows: publication.privateRows.map(row => ({
                        sortOrdinal: row.sort_ordinal,
                        instagramId: row.instagram_id,
                        profileImage: row.profile_image,
                        fullName: row.full_name,
                        nameFemaleScore: row.name_female_score,
                        nameIsName: row.name_is_name,
                        nameConfidence: row.name_confidence,
                    })),
                },
                error: null,
            };
        });
        const result = await store.publishAtomic({
            publication,
            expectedVersion: 7,
            expectedResultHash: 'e'.repeat(64),
            orderId: 'order', requestId: 'request', ownerId: 'owner', targetUsername: 'target',
            classificationLedger: makeLedger(), manualImport: makeInput().manualImport,
        });
        expect(result).toEqual({ published: true, idempotent: false });
        expect(forwarded).toMatchObject({
            order_id: 'order', request_id: 'request', expected_version: 7,
            expected_result_hash: 'e'.repeat(64), result_hash: expect.any(String),
            interaction_lineage_hash: expect.any(String), interaction_lineage: expect.any(Object),
        });
        const lying = createConciergePublicationStore(async () => ({
            data: {
                published: true, idempotent: false,
                ownerReadContractVerified: true, adminReadContractVerified: true,
                resultHash: 'f'.repeat(64), resultUrl: publication.resultUrl,
                requestId: publication.requestId, version: 8, counts: publication.counts,
            }, error: null,
        }));
        await expect(lying.publishAtomic({
            publication, expectedVersion: 7, expectedResultHash: 'e'.repeat(64), orderId: 'order',
            requestId: 'request', ownerId: 'owner', targetUsername: 'target',
            classificationLedger: makeLedger(), manualImport: makeInput().manualImport,
        })).rejects.toThrow('CONCIERGE_PUBLICATION_RPC_ECHO_MISMATCH');
        const invalid = createConciergePublicationStore(async () => ({ data: null, error: null }));
        await expect(invalid.publishAtomic({
            publication: buildConciergeManualPublication(makeInput()),
            expectedVersion: 7, expectedResultHash: 'e'.repeat(64), orderId: 'order',
            requestId: 'request', ownerId: 'owner', targetUsername: 'target',
            classificationLedger: makeLedger(), manualImport: makeInput().manualImport,
        })).rejects.toThrow('CONCIERGE_PUBLICATION_RPC_INVALID_RESPONSE');
    });

    it('binds future batches to the service-role RPC and verifies its ordered private readback', async () => {
        const publication = buildConciergeManualPublication(makeInput());
        const calls: string[] = [];
        const store = createSupabaseConciergePublicationStore({
            async rpc(name, args) {
                calls.push(name);
                expect(args).toMatchObject({
                    request_id: publication.requestId,
                    publication: expect.objectContaining({ privateRows: publication.privateRows }),
                });
                return {
                    data: {
                        published: true, idempotent: false,
                        ownerReadContractVerified: true, adminReadContractVerified: true,
                        resultHash: publication.resultHash, resultUrl: publication.resultUrl,
                        requestId: publication.requestId, version: 8, counts: publication.counts,
                        privateRows: publication.privateRows.map(row => ({
                            sortOrdinal: row.sort_ordinal,
                            instagramId: row.instagram_id,
                            profileImage: row.profile_image,
                            fullName: row.full_name,
                            nameFemaleScore: row.name_female_score,
                            nameIsName: row.name_is_name,
                            nameConfidence: row.name_confidence,
                        })),
                    },
                    error: null,
                };
            },
        });

        await expect(store.publishAtomic({
            publication,
            expectedVersion: 7,
            expectedResultHash: 'e'.repeat(64),
            orderId: 'order', requestId: 'request', ownerId: 'owner', targetUsername: 'target',
            classificationLedger: makeLedger(), manualImport: makeInput().manualImport,
        })).resolves.toEqual({ published: true, idempotent: false });
        expect(calls).toEqual([CONCIERGE_BATCH_PUBLICATION_RPC]);
    });

    it('canonicalizes private-name scores to the existing REAL storage precision before hashing', () => {
        const input = makeInput();
        const preciseFemaleScore = 0.8123456789;
        const preciseConfidence = 0.2345678912;
        const publication = buildConciergeManualPublication({
            ...input,
            replay: {
                ...input.replay,
                privateNameResults: [{
                    id: 'private',
                    femaleScore: preciseFemaleScore,
                    isName: true,
                    confidence: preciseConfidence,
                }],
            },
        });

        expect(publication.privateRows).toEqual([{
            sort_ordinal: 1,
            instagram_id: 'private',
            profile_image: null,
            full_name: null,
            name_female_score: Math.fround(preciseFemaleScore),
            name_is_name: true,
            name_confidence: Math.fround(preciseConfidence),
        }]);
    });
});
