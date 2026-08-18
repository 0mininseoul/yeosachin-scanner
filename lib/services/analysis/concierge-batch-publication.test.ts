import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    buildConciergeManualPublication,
    buildConciergeManualPublicationDraft,
    CONCIERGE_BATCH_PUBLICATION_RPC,
    ConciergePublicationError,
    createConciergePublicationStore,
    createSupabaseConciergePublicationStore,
    publishConciergeManualOverride,
    type ConciergeManualPublicationInput,
    type ConciergeBatchCandidateCopy,
    type ConciergePublicationStore,
} from './concierge-batch-publication';
import {
    parseConciergeClassificationCsv,
    type ConciergeClassificationLedger,
} from './concierge-classification-import';
import type { ReplayAccountAiDetail } from './replay/replay-runner';
import {
    runConciergePublicationDryRunCli,
    verifyConciergePublicationInput,
    writeConciergePublicationDryRunDump,
} from '../../../scripts/verify-concierge-publication';

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

function makeNameOnlyPublicationBoundaryInput(): ConciergeManualPublicationInput {
    const base = makeInput();
    const publicUsernames = ['one', 'two', 'male_name', 'unpromoted_female', 'nameless'];
    const noFeaturePass = (fullName: string | null) => ({
        status: 'failed' as const,
        fullNamePresent: Boolean(fullName?.trim()),
        profilePicPresent: false,
        feedDeclared: null,
        feedCollected: null,
        completeMedia: null,
        evidenceHash: HASH,
    });
    const noFeatureSecondPass = (fullName: string | null) => ({
        status: 'not_collected' as const,
        fullNamePresent: Boolean(fullName?.trim()),
        profilePicPresent: false,
        feedDeclared: null,
        feedCollected: null,
        completeMedia: null,
        evidenceHash: null,
    });
    const publicProfiles = new Map<number, InstagramProfile>([
        [1, { username: 'one', isPrivate: false, profilePicUrl: null, fullName: 'Jane One', bio: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
        [2, { username: 'two', isPrivate: false, profilePicUrl: null, fullName: 'Image Female', bio: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
        [3, { username: 'male_name', isPrivate: false, profilePicUrl: null, fullName: 'Male Name', bio: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
        [4, { username: 'unpromoted_female', isPrivate: false, profilePicUrl: null, fullName: 'Unpromoted Female', bio: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
        [5, { username: 'nameless', isPrivate: false, profilePicUrl: null, fullName: null, bio: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
    ]);
    const noFeatureRecord = (ordinal: number, username: string, fullName: string | null, original: 'male' | 'female' | 'unknown', effective: 'male' | 'female' | 'unknown', source: 'ai' | 'name_only') => ({
        candidateId: `candidate:${username}`,
        instagramId: username,
        mutualOrdinal: ordinal,
        partition: 'public' as const,
        profileFetchStatus: 'success' as const,
        firstPass: noFeaturePass(fullName),
        secondPass: noFeatureSecondPass(fullName),
        originalAiClassification: original,
        effectiveClassification: effective,
        confidence: 'high' as const,
        evidenceCoverage: { declared: 0, collected: 0, selected: 0, complete: false, basisPoints: 0, hash: HASH },
        classifier: 'replay',
        modelName: 'model',
        promptVersion: 'prompt',
        schemaVersion: 'schema',
        classificationOperationKey: `op:boundary:${ordinal}`,
        classificationResultHash: HASH,
        classificationSource: source,
        manualOverride: null,
        sourceSnapshot: {
            instagramUrl: `https://instagram.com/${username}`,
            originalAiClassification: original,
            confidenceEvidence: `confidence=high;evidence=${source === 'name_only' ? 'name_only' : 'model_ambiguous'}`,
            operatorNote: '',
        },
    });
    const imageRecord = {
        ...base.ledger.records[1]!,
        candidateId: 'candidate:two',
        instagramId: 'two',
        mutualOrdinal: 2,
        originalAiClassification: 'female' as const,
        effectiveClassification: 'female' as const,
        classificationOperationKey: 'op:boundary:2',
        sourceSnapshot: {
            ...base.ledger.records[1]!.sourceSnapshot!,
            instagramUrl: 'https://instagram.com/two',
            originalAiClassification: 'female' as const,
        },
    };
    const privateRecord = {
        ...base.ledger.records[2]!,
        mutualOrdinal: 6,
    };
    const records = [
        noFeatureRecord(1, 'one', 'Jane One', 'female', 'female', 'name_only'),
        imageRecord,
        noFeatureRecord(3, 'male_name', 'Male Name', 'male', 'male', 'name_only'),
        noFeatureRecord(4, 'unpromoted_female', 'Unpromoted Female', 'female', 'unknown', 'name_only'),
        noFeatureRecord(5, 'nameless', null, 'unknown', 'unknown', 'ai'),
        privateRecord,
    ];
    const triageDetail = (ordinal: number, finalClassification: 'verified_female' | 'verified_non_female' | 'unresolved', inferredGender: 'female' | 'male' | 'unknown') => ({
        ordinal,
        finalClassification,
        classificationSource: finalClassification === 'unresolved' ? 'unknown' : 'triage',
        featureOverview: null,
        triage: { assessment: { inferredGender, confidence: 'high' } },
        feature: null,
    });
    const details = [
        triageDetail(1, 'verified_female', 'female'),
        { ordinal: 2, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'x', triage: null, feature: makeFeature() },
        triageDetail(3, 'verified_non_female', 'male'),
        triageDetail(4, 'verified_female', 'female'),
        triageDetail(5, 'unresolved', 'unknown'),
    ] as unknown as readonly ReplayAccountAiDetail[];
    const classificationByOrdinal = new Map(publicUsernames.map(username => {
        const record = records.find(item => item.instagramId === username)!;
        return [record.mutualOrdinal, {
            originalAiClassification: record.originalAiClassification!,
            classificationSource: record.classificationSource === 'name_only' ? 'name_only' as const : 'ai' as const,
            confidence: record.confidence!,
            classifier: record.classifier!,
            modelName: record.modelName!,
            promptVersion: record.promptVersion!,
            schemaVersion: record.schemaVersion!,
            classificationOperationKey: record.classificationOperationKey!,
            classificationResultHash: record.classificationResultHash!,
            secondPassStatus: record.secondPass.status,
            secondPassCompleteMedia: record.secondPass.completeMedia,
        }] as const;
    }));
    const emptyImport = parseConciergeClassificationCsv(
        'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\n',
        base.orderId,
        base.requestId,
        HASH,
        'b'.repeat(64),
        '2026-08-14T00:00:00.000Z',
    );
    return {
        ...base,
        expectedMutualCount: 6,
        expectedHydratedCount: 6,
        manualImport: emptyImport,
        ledger: {
            ...base.ledger,
            mutualCount: 6,
            hydratedPublicCount: 5,
            hydratedPrivateCount: 1,
            records,
        },
        replay: {
            ...base.replay,
            profilesByOrdinal: publicProfiles,
            details,
            orderedMutualUsernames: [...publicUsernames, 'private'],
            classificationByOrdinal,
            privateProfiles: [{ username: 'private', isPrivate: true, profilePicUrl: null, fullName: null, followersCount: 1, followingCount: 1, postsCount: 0, latestPosts: [] } as unknown as InstagramProfile],
            fetchedCount: 6,
            hydratedPublicCount: 5,
            hydratedPrivateCount: 1,
            analyzedPublicCount: 5,
            unresolvedCount: 0,
        },
        nameOnlyProvenance: {
            promotedUsernames: ['one', 'male_name'],
            achievedUnknownRatio: 0.4,
            targetUnknownRatio: 0.2,
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

    it('keeps unresolved mutuals in the partition counts without promoting them to gender rows', () => {
        const input = makeInput();
        const unresolvedHash = 'c'.repeat(64);
        const unresolvedSource = input.ledger.records[0]!;
        const unresolvedRecord = {
            ...unresolvedSource,
            candidateId: 'candidate:unresolved',
            instagramId: 'unresolved',
            mutualOrdinal: 4,
            partition: 'unresolved' as const,
            profileFetchStatus: 'unavailable' as const,
            originalAiClassification: 'unknown' as const,
            effectiveClassification: 'unknown' as const,
            confidence: 'low' as const,
            classificationOperationKey: 'op:unresolved',
            classificationResultHash: unresolvedHash,
            sourceSnapshot: {
                ...unresolvedSource.sourceSnapshot!,
                instagramUrl: 'https://instagram.com/unresolved',
                originalAiClassification: 'unknown' as const,
                confidenceEvidence: 'confidence=low;evidence=unavailable',
            },
        };
        const classificationByOrdinal = new Map(input.replay.classificationByOrdinal);
        classificationByOrdinal.set(4, {
            ...classificationByOrdinal.get(1)!,
            originalAiClassification: 'unknown',
            confidence: 'low',
            classificationOperationKey: 'op:unresolved',
            classificationResultHash: unresolvedHash,
        });
        const publication = buildConciergeManualPublication({
            ...input,
            expectedMutualCount: 4,
            ledger: {
                ...input.ledger,
                mutualCount: 4,
                unresolvedCount: 1,
                records: [...input.ledger.records, unresolvedRecord],
            },
            replay: {
                ...input.replay,
                orderedMutualUsernames: [...input.replay.orderedMutualUsernames, 'unresolved'],
                classificationByOrdinal,
                fetchedCount: 4,
                unresolvedCount: 1,
            },
        });

        expect(publication.rows).toHaveLength(2);
        expect(publication.counts).toMatchObject({
            public: 2,
            private: 1,
            unresolved: 1,
            mutual: 4,
            authoritativeMutual: 4,
            hydrated: 3,
            analyzed: 2,
            male: 0,
            female: 2,
            unknown: 0,
        });
    });

    it('replaces every displayed candidate overview with the full batch copy contract', () => {
        const input = makeInput();
        const scored = buildConciergeManualPublication(input);
        const batchCandidateCopy: ConciergeBatchCandidateCopy[] = scored.rows.map((row, index) => ({
            candidateUsername: row.suspect_instagram_id,
            oneLineOverview: `${row.suspect_instagram_id}의 보존된 기록이 ${index === 0 ? '여행' : '필름'} 장면마다 다른 결로 이어져 호기심을 남깁니다.`,
            riskAnalysis: [
                `${row.suspect_instagram_id}의 공개 기록에서 실제 장면의 결이 가볍게 이어집니다.`,
                `${row.suspect_instagram_id}의 피드가 남긴 분위기가 시선을 붙잡습니다.`,
            ],
        }));
        const publication = buildConciergeManualPublication({ ...input, batchCandidateCopy });
        expect(publication.rows.map(row => row.one_line_overview)).toEqual(
            batchCandidateCopy.map(copy => copy.oneLineOverview),
        );
        expect(publication.rows.every(row => row.risk_grade === 'high_risk'
            ? row.risk_analysis.length === 2
            : row.risk_analysis.length === 0)).toBe(true);
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
            p_publication: {
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

    it('publishes a name-only female with distinct provenance and no feature media', () => {
        const input = makeInput();
        const emptyManualImport = parseConciergeClassificationCsv(
            'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\n',
            input.orderId,
            input.requestId,
            HASH,
            'b'.repeat(64),
            '2026-08-14T00:00:00.000Z',
        );
        const records = input.ledger.records.map(record => record.instagramId === 'one'
            ? {
                ...record,
                firstPass: { ...record.firstPass, status: 'failed' as const, profilePicPresent: false, completeMedia: null, evidenceHash: HASH },
                secondPass: { ...record.secondPass, status: 'not_collected' as const, completeMedia: null, evidenceHash: null },
                originalAiClassification: 'female' as const,
                effectiveClassification: 'female' as const,
                confidence: 'high' as const,
                evidenceCoverage: { declared: 0, collected: 0, selected: 0, complete: false, basisPoints: 0, hash: HASH },
                classificationSource: 'name_only' as const,
                sourceSnapshot: {
                    ...record.sourceSnapshot!,
                    originalAiClassification: 'female' as const,
                    confidenceEvidence: 'confidence=high;evidence=name_only',
                },
            }
            : record);
        const classificationByOrdinal = new Map(input.replay.classificationByOrdinal);
        classificationByOrdinal.set(1, {
            ...classificationByOrdinal.get(1)!,
            originalAiClassification: 'female', confidence: 'high',
            classificationSource: 'name_only' as const,
            secondPassStatus: 'not_collected', secondPassCompleteMedia: null,
        });
        const publication = buildConciergeManualPublication({
            ...input,
            manualImport: emptyManualImport,
            ledger: { ...input.ledger, records },
            replay: {
                ...input.replay,
                profilesByOrdinal: new Map([
                    ...input.replay.profilesByOrdinal.entries(),
                    [1, { ...input.replay.profilesByOrdinal.get(1)!, fullName: 'Jane Doe' } as unknown as InstagramProfile],
                ]),
                details: input.replay.details.map(detail => detail.ordinal === 1
                    ? { ...detail, finalClassification: 'verified_female', feature: null, triage: { assessment: { inferredGender: 'female', confidence: 'high' } } } as unknown as ReplayAccountAiDetail
                    : detail),
                classificationByOrdinal,
            },
            nameOnlyProvenance: {
                promotedUsernames: ['one'],
                achievedUnknownRatio: 0,
                targetUnknownRatio: 0.2,
                funnel: {
                    totalPublicDetails: 2,
                    droppedNoProfile: 0,
                    droppedNoTriageAssessment: 0,
                    droppedHasFeature: 0,
                    droppedUsableProfileImage: 0,
                    droppedNotUnknown: 0,
                    candidateCount: 1,
                    droppedNoFullName: 0,
                    droppedInferredUnknown: 0,
                    droppedBelowMinConfidence: 0,
                    eligibleCount: 1,
                    eligibleMaleCount: 0,
                    eligibleFemaleCount: 1,
                    promotionBudget: 1,
                    promotedCount: 1,
                },
            },
        });

        expect(publication.rows.map(row => row.suspect_instagram_id)).toEqual(expect.arrayContaining(['one', 'two']));
        expect(publication.counts.nameOnly).toEqual({
            promoted: 1,
            promotedUsernames: ['one'],
            unknownRatio: 0,
            targetUnknownRatio: 0.2,
            totalPublicDetails: 2,
            droppedNoProfile: 0,
            droppedNoTriageAssessment: 0,
            droppedHasFeature: 0,
            droppedUsableProfileImage: 0,
            droppedNotUnknown: 0,
            candidateCount: 1,
            droppedNoFullName: 0,
            droppedInferredUnknown: 0,
            droppedBelowMinConfidence: 0,
            eligibleCount: 1,
            eligibleMaleCount: 0,
            eligibleFemaleCount: 1,
            promotionBudget: 1,
            promotedCount: 1,
        });
    });

    it('crosses the publication boundary with every name-only and image-backed classification shape', () => {
        const publication = buildConciergeManualPublicationDraft(makeNameOnlyPublicationBoundaryInput());

        expect(publication.rows.map(row => row.suspect_instagram_id)).toEqual(
            expect.arrayContaining(['one', 'two']),
        );
        expect(publication.rows.map(row => row.suspect_instagram_id)).not.toEqual(
            expect.arrayContaining(['male_name', 'unpromoted_female', 'nameless']),
        );
        expect(publication.counts).toMatchObject({
            male: 1,
            female: 2,
            unknown: 2,
            public: 5,
            private: 1,
            mutual: 6,
            analyzed: 5,
        });
        expect(publication.counts.nameOnly).toEqual({
            promoted: 2,
            promotedUsernames: ['one', 'male_name'],
            unknownRatio: 0.4,
            targetUnknownRatio: 0.2,
        });
    });

    it('reports the compared values when the dry-run publication boundary finds an AI binding mismatch', () => {
        const input = makeInput();
        const replay = {
            ...input.replay,
            details: input.replay.details.map(detail => detail.ordinal === 1
                ? { ...detail, finalClassification: 'verified_female' }
                : detail.ordinal === 2
                    ? { ...detail, finalClassification: 'verified_non_female' }
                    : detail),
        } as unknown as ConciergeManualPublicationInput['replay'];

        const result = verifyConciergePublicationInput({ ...input, replay });

        expect(result).toMatchObject({
            passed: false,
            code: 'CONCIERGE_PUBLICATION_REPLAY_AI_BINDING_MISMATCH',
            diagnostic: {
                check: 'buildEffectiveDetails.detailAiBinding',
                ordinal: 1,
                username: 'one',
                compared: {
                    detailClassification: 'female',
                    bindingOriginalAiClassification: 'unknown',
                },
            },
        });
        if (result.passed) throw new Error('expected dry-run binding mismatch');
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics[1]).toMatchObject({
            ordinal: 2,
            username: 'two',
            compared: {
                detailClassification: 'male',
                bindingOriginalAiClassification: 'female',
            },
        });
    });

    it('round-trips a dumped input through the CLI without a provider, AI, or publication-store call', () => {
        const base = makeInput();
        const orderId = '123e4567-e89b-42d3-a456-426614174000';
        const requestId = '223e4567-e89b-42d3-a456-426614174000';
        const input: ConciergeManualPublicationInput = {
            ...base,
            orderId,
            requestId,
            resultRequestId: requestId,
            ownerId: '323e4567-e89b-42d3-a456-426614174000',
            sourceRequestId: '423e4567-e89b-42d3-a456-426614174000',
            currentPublication: { ...base.currentPublication, resultUrl: `/result/${requestId}` },
            manualImport: { ...base.manualImport, orderId, requestId },
        };
        const directory = mkdtempSync(join(tmpdir(), 'concierge-publication-dry-run-'));
        try {
            writeConciergePublicationDryRunDump(input, directory);
            expect(runConciergePublicationDryRunCli(['--input', directory])).toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
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
            p_order_id: 'order', p_request_id: 'request', p_expected_version: 7,
            p_expected_result_hash: 'e'.repeat(64), p_result_hash: expect.any(String),
            p_interaction_lineage_hash: expect.any(String), p_interaction_lineage: expect.any(Object),
        });
        expect(forwarded).not.toHaveProperty('order_id');
        expect(forwarded).not.toHaveProperty('request_id');
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

        const guardedFailure = createConciergePublicationStore(async () => ({
            data: null,
            error: { code: 'P0001', message: 'CONCIERGE_PUBLICATION_COUNTS_MISMATCH' },
        }));
        await expect(guardedFailure.publishAtomic({
            publication, expectedVersion: 7, expectedResultHash: 'e'.repeat(64), orderId: 'order',
            requestId: 'request', ownerId: 'owner', targetUsername: 'target',
            classificationLedger: makeLedger(), manualImport: makeInput().manualImport,
        })).rejects.toThrow('CONCIERGE_PUBLICATION_COUNTS_MISMATCH');
    });

    it('sanitizes a publication transport failure without exposing its raw message', async () => {
        const publication = buildConciergeManualPublication(makeInput());
        const store = createConciergePublicationStore(async () => {
            throw new Error('secret transport detail');
        });

        await expect(store.publishAtomic({
            publication,
            expectedVersion: 7,
            expectedResultHash: 'e'.repeat(64),
            orderId: 'order', requestId: 'request', ownerId: 'owner', targetUsername: 'target',
            classificationLedger: makeLedger(), manualImport: makeInput().manualImport,
        })).rejects.toMatchObject({
            name: 'ConciergePublicationError',
            message: 'CONCIERGE_PUBLICATION_RPC_FAILED',
        });
    });

    it('binds future batches to the service-role RPC and verifies its ordered private readback', async () => {
        const publication = buildConciergeManualPublication(makeInput());
        const calls: string[] = [];
        const store = createSupabaseConciergePublicationStore({
            async rpc(name, args) {
                calls.push(name);
                expect(args).toMatchObject({
                    p_request_id: publication.requestId,
                    p_publication: expect.objectContaining({ privateRows: publication.privateRows }),
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
