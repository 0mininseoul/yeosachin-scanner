import { describe, expect, it } from 'vitest';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
    hasCandidateTargetMention,
    type V2FemaleCandidateEvidence,
} from './v2-candidate-scoring';

function candidate(index: number, overrides: Partial<V2FemaleCandidateEvidence> = {}):
V2FemaleCandidateEvidence {
    return {
        candidateId: `candidate:${String(index).padStart(2, '0')}`,
        username: `woman.${index}`,
        appearanceGrade: 3,
        exposureScore: 1,
        accountContext: 'personal',
        hasWeakPartnerEvidence: false,
        hasStrongPartnerEvidence: false,
        uniqueTargetPostsLikedByCandidate: 0,
        boundedCandidateCommentsOnTarget: 0,
        hasTagOrCaptionMention: false,
        ...overrides,
    };
}

describe('V2 candidate scoring orchestration', () => {
    it('ranks recent mutuals only after the verified female filter', () => {
        const preliminary = calculateV2PreliminaryScores({
            candidates: [candidate(1), candidate(2)],
            orderedMutualUsernames: ['male.1', 'woman.2', 'male.2', 'woman.1'],
            excludedUsername: null,
        });

        expect(preliminary.find(row => row.username === 'woman.2')).toMatchObject({
            recentFemaleMutualRank: 1,
            recentMutualBadgeRank: 1,
        });
        expect(preliminary.find(row => row.username === 'woman.1')).toMatchObject({
            recentFemaleMutualRank: 2,
            recentMutualBadgeRank: 2,
        });
    });

    it('freezes Top 10 before reverse likes and never collects outside it', () => {
        const candidates = Array.from({ length: 11 }, (_, index) => candidate(index + 1, {
            boundedCandidateCommentsOnTarget: index < 10 ? 10 - index : 0,
        }));
        const preliminary = calculateV2PreliminaryScores({
            candidates,
            orderedMutualUsernames: candidates.map(row => row.username),
            excludedUsername: null,
        });
        const excluded = preliminary.find(row => row.verificationShortlistRank === null);
        expect(excluded).toBeDefined();

        expect(() => calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set([excluded!.candidateId]),
        })).toThrow('outside the frozen shortlist');

        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set([
                preliminary.find(row => row.verificationShortlistRank === 10)!.candidateId,
            ]),
        });
        expect(final.filter(row => row.reverseLikeStatus !== 'not_collected')).toHaveLength(10);
        expect(final.find(row => row.candidateId === excluded!.candidateId)?.reverseLikeStatus)
            .toBe('not_collected');
    });

    it('assigns relative high-risk and caution tiers for larger weak sets', () => {
        const candidates = Array.from({ length: 20 }, (_, index) => candidate(index + 1, {
            appearanceGrade: 1,
            exposureScore: 0,
        }));
        const preliminary = calculateV2PreliminaryScores({
            candidates,
            orderedMutualUsernames: [],
            excludedUsername: null,
        });
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set(),
        });

        expect(final.every(row => row.risk.riskBand === 'normal')).toBe(true);
        expect(final.filter(row => row.riskBand === 'high_risk')).toHaveLength(1);
        expect(final.filter(row => row.riskBand === 'caution')).toHaveLength(2);
        expect(final.filter(row => row.featuredRank !== null)).toHaveLength(3);
        expect(final.filter(row => row.relativeWatchRank !== null)).toHaveLength(2);
    });

    it('does not apply minimum tiers when only two rows remain partner-cap eligible', () => {
        const preliminary = calculateV2PreliminaryScores({
            candidates: [
                candidate(1, { hasStrongPartnerEvidence: true }),
                candidate(2),
                candidate(3),
            ],
            orderedMutualUsernames: [],
            excludedUsername: null,
        });
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set(),
        });

        expect(final.every(row => row.riskBand === row.risk.riskBand)).toBe(true);
        expect(final.every(row => row.relativeTierApplied === false)).toBe(true);
    });

    it('removes official-account soft context without discounting direct interaction', () => {
        const preliminary = calculateV2PreliminaryScores({
            candidates: [
                candidate(1, {
                    accountContext: 'official_group_or_brand',
                    appearanceGrade: 5,
                    exposureScore: 5,
                    uniqueTargetPostsLikedByCandidate: 1,
                }),
                candidate(2, {
                    accountContext: 'personal',
                    appearanceGrade: 1,
                    exposureScore: 0,
                    uniqueTargetPostsLikedByCandidate: 1,
                }),
            ],
            orderedMutualUsernames: ['woman.1'],
            excludedUsername: null,
        });
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set(),
        });
        const official = final.find(row => row.username === 'woman.1')!;
        const personal = final.find(row => row.username === 'woman.2')!;

        expect(official.risk.softContextMultiplier).toBe(0);
        expect(official.risk.components.candidateToTargetLikes)
            .toBe(personal.risk.components.candidateToTargetLikes);
        expect(official.risk.components.recentMutual).toBe(0);
        expect(official.risk.components.appearanceExposure).toBe(0);
    });

    it('detects either-direction target/candidate tags and caption mentions', () => {
        expect(hasCandidateTargetMention({
            targetUsername: 'target',
            candidateUsername: 'candidate',
            targetPosts: [{ taggedUsers: [], mentionedUsers: ['Candidate'] }],
            candidatePosts: [{ taggedUsers: [], mentionedUsers: [] }],
        })).toBe(true);
        expect(hasCandidateTargetMention({
            targetUsername: 'target',
            candidateUsername: 'candidate',
            targetPosts: [{ taggedUsers: [], mentionedUsers: [] }],
            candidatePosts: [{ taggedUsers: ['TARGET'], mentionedUsers: [] }],
        })).toBe(true);
    });
});
