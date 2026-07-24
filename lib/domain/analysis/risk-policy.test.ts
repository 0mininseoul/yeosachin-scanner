import { describe, expect, it } from 'vitest';
import {
    APPEARANCE_EXPOSURE_NORMALIZER,
    APPEARANCE_GRADE_POINTS,
    FEATURED_RISK_LIMITS,
    PRE_SCORE_MAX,
    RAW_SCORE_MAX,
    RECENT_FEMALE_MUTUAL_POINTS,
    RISK_BANDS,
    RISK_COMPONENT_WEIGHTS,
    RISK_POLICY_VERSION,
    STRONG_PARTNER_PUBLIC_SCORE_CAP,
    VERIFICATION_SHORTLIST_LIMIT,
    WEAK_PARTNER_RAW_ADJUSTMENT,
    assignFeaturedRiskRanks,
    assignVerificationShortlist,
    calculateRiskPolicy,
    classifyRiskBandFromRawScore,
    isRiskBandCompatibleWithDisplayScore,
    rawScoreToDisplayScore,
    scoreAppearanceExposure,
    scoreRecentFemaleMutual,
} from './risk-policy';

const maximumInput = {
    uniqueTargetPostsLikedByCandidate: 4,
    boundedCandidateCommentsOnTarget: 12,
    reverseLikeStatus: 'observed' as const,
    hasTagOrCaptionMention: true,
    recentFemaleMutualRank: 1,
    appearanceGrade: 5 as const,
    exposureScore: 5,
    accountContext: 'personal' as const,
    hasWeakPartnerEvidence: false,
    hasStrongPartnerEvidence: false,
};

describe('risk policy components', () => {
    it('keeps the final component weights at exactly 100 points', () => {
        expect(RISK_POLICY_VERSION).toBe('risk-policy-v2.3');
        expect(RISK_BANDS).toEqual(['normal', 'caution', 'high_risk']);
        expect(RISK_COMPONENT_WEIGHTS).toEqual({
            candidateToTargetLikes: 20,
            candidateToTargetComments: 26,
            targetToCandidateLike: 3,
            tagOrCaptionMention: 14,
            recentMutual: 17,
            appearanceExposure: 20,
        });
        expect(Object.values(RISK_COMPONENT_WEIGHTS).reduce((sum, value) => sum + value, 0))
            .toBe(RAW_SCORE_MAX);
    });

    it('normalizes appearance grade plus exposure from 18 raw points to 20', () => {
        expect(Object.values(APPEARANCE_GRADE_POINTS)).toEqual([0, 3, 7, 10, 13]);
        expect(APPEARANCE_EXPOSURE_NORMALIZER).toBe(20 / 18);
        expect(scoreAppearanceExposure(1, 0)).toBe(0);
        expect(scoreAppearanceExposure(3, 2)).toBeCloseTo(9 * (20 / 18));
        expect(scoreAppearanceExposure(5, 5)).toBe(20);
    });

    it('uses the final recent-woman rank table and scores later ranks as zero', () => {
        expect(RECENT_FEMALE_MUTUAL_POINTS).toEqual([17, 16, 15, 14, 13, 12, 10, 8, 6, 4]);
        for (const [index, points] of RECENT_FEMALE_MUTUAL_POINTS.entries()) {
            expect(scoreRecentFemaleMutual(index + 1)).toBe(points);
        }
        expect(scoreRecentFemaleMutual(11)).toBe(0);
        expect(scoreRecentFemaleMutual(null)).toBe(0);
    });

    it.each([
        ['personal', 1],
        ['individual_creator', 0.5],
        ['official_group_or_brand', 0],
        ['uncertain', 1],
    ] as const)(
        'applies the %s multiplier only to recent and appearance context',
        (accountContext, multiplier) => {
            const regular = calculateRiskPolicy(maximumInput);
            const adjusted = calculateRiskPolicy({ ...maximumInput, accountContext });

            expect(adjusted.components.candidateToTargetLikes)
                .toBe(regular.components.candidateToTargetLikes);
            expect(adjusted.components.candidateToTargetComments)
                .toBe(regular.components.candidateToTargetComments);
            expect(adjusted.components.targetToCandidateLike)
                .toBe(regular.components.targetToCandidateLike);
            expect(adjusted.components.tagOrCaptionMention)
                .toBe(regular.components.tagOrCaptionMention);
            expect(adjusted.components.recentMutual)
                .toBe(regular.components.recentMutual * multiplier);
            expect(adjusted.components.appearanceExposure)
                .toBe(regular.components.appearanceExposure * multiplier);
            expect(adjusted.softContextMultiplier).toBe(multiplier);
        }
    );

    it('caps pre-score at 97 and reserves three points for reverse-like evidence', () => {
        const notCollected = calculateRiskPolicy({
            ...maximumInput,
            reverseLikeStatus: 'not_collected',
        });
        const observed = calculateRiskPolicy(maximumInput);
        const notObserved = calculateRiskPolicy({
            ...maximumInput,
            reverseLikeStatus: 'not_observed',
        });

        expect(notCollected.preScore).toBe(PRE_SCORE_MAX);
        expect(notCollected.rawScore).toBe(PRE_SCORE_MAX);
        expect(notCollected.possibleUpperBound).toBe(RAW_SCORE_MAX);
        expect(observed.rawScore).toBe(RAW_SCORE_MAX);
        expect(observed.possibleUpperBound).toBe(RAW_SCORE_MAX);
        expect(notObserved.rawScore).toBe(PRE_SCORE_MAX);
        expect(notObserved.possibleUpperBound).toBe(PRE_SCORE_MAX);
    });

    it('applies one bounded weak-partner adjustment without mixing it into evidence components', () => {
        const baseline = calculateRiskPolicy({
            ...maximumInput,
            uniqueTargetPostsLikedByCandidate: 0,
        });
        const weak = calculateRiskPolicy({
            ...maximumInput,
            uniqueTargetPostsLikedByCandidate: 0,
            hasWeakPartnerEvidence: true,
        });

        expect(weak.weakPartnerAdjustment).toBe(WEAK_PARTNER_RAW_ADJUSTMENT);
        expect(weak.preScore).toBe(baseline.preScore + WEAK_PARTNER_RAW_ADJUSTMENT);
        expect(weak.components).toEqual(baseline.components);
        expect(() => calculateRiskPolicy({
            ...maximumInput,
            hasWeakPartnerEvidence: true,
            hasStrongPartnerEvidence: true,
        })).toThrow('mutually exclusive');
    });

    it('rejects malformed component inputs instead of silently changing evidence', () => {
        expect(() => calculateRiskPolicy({
            ...maximumInput,
            uniqueTargetPostsLikedByCandidate: -1,
        })).toThrow(RangeError);
        expect(() => scoreAppearanceExposure(5, 5.1)).toThrow(RangeError);
        expect(() => scoreAppearanceExposure(0 as 1, 0)).toThrow(RangeError);
        expect(() => scoreRecentFemaleMutual(0)).toThrow(RangeError);
    });
});

describe('public score and absolute risk bands', () => {
    const cautionBoundaryRaw = ((4.2 - 1) * 100) / 9;
    const highBoundaryRaw = ((6.8 - 1) * 100) / 9;

    it('maps the raw range to a one-decimal public range from 1 through 10', () => {
        expect(rawScoreToDisplayScore(0)).toBe(1);
        expect(rawScoreToDisplayScore(100)).toBe(10);
        expect(rawScoreToDisplayScore(-1)).toBe(1);
        expect(rawScoreToDisplayScore(101)).toBe(10);
    });

    it('classifies on unrounded values at the 4.2 and 6.8 boundaries', () => {
        expect(classifyRiskBandFromRawScore(cautionBoundaryRaw - 1e-9)).toBe('normal');
        expect(classifyRiskBandFromRawScore(cautionBoundaryRaw)).toBe('caution');
        expect(classifyRiskBandFromRawScore(highBoundaryRaw - 1e-9)).toBe('caution');
        expect(classifyRiskBandFromRawScore(highBoundaryRaw)).toBe('high_risk');

        expect(rawScoreToDisplayScore(cautionBoundaryRaw - 0.01)).toBe(4.2);
        expect(classifyRiskBandFromRawScore(cautionBoundaryRaw - 0.01)).toBe('normal');
    });

    it('caps only the public score for strong partner evidence and keeps it normal', () => {
        const result = calculateRiskPolicy({
            ...maximumInput,
            hasStrongPartnerEvidence: true,
        });

        expect(result.rawScore).toBe(100);
        expect(result.publicScore).toBe(STRONG_PARTNER_PUBLIC_SCORE_CAP);
        expect(result.displayScore).toBe(STRONG_PARTNER_PUBLIC_SCORE_CAP);
        expect(result.possibleUpperPublicScore).toBe(STRONG_PARTNER_PUBLIC_SCORE_CAP);
        expect(result.riskBand).toBe('normal');
        expect(result.partnerCapApplied).toBe(true);
    });

    it('rejects impossible public score and band combinations after rounding', () => {
        expect(isRiskBandCompatibleWithDisplayScore(3.4, 'normal')).toBe(true);
        expect(isRiskBandCompatibleWithDisplayScore(3.4, 'high_risk')).toBe(false);
        expect(isRiskBandCompatibleWithDisplayScore(4.2, 'normal')).toBe(true);
        expect(isRiskBandCompatibleWithDisplayScore(4.2, 'caution')).toBe(true);
        expect(isRiskBandCompatibleWithDisplayScore(6.8, 'caution')).toBe(true);
        expect(isRiskBandCompatibleWithDisplayScore(6.8, 'high_risk')).toBe(true);
        expect(isRiskBandCompatibleWithDisplayScore(6.9, 'caution')).toBe(false);
    });
});

describe('featured risk ranks', () => {
    it('features at most three high and fifteen caution rows without changing any band', () => {
        const high = Array.from({ length: 5 }, (_, index) => ({
            candidateId: `high-${index}`,
            publicScore: 9 - index * 0.1,
            riskBand: 'high_risk' as const,
        }));
        const caution = Array.from({ length: 17 }, (_, index) => ({
            candidateId: `caution-${index}`,
            publicScore: 6.7 - index * 0.1,
            riskBand: 'caution' as const,
        }));
        const normal = {
            candidateId: 'normal-0',
            publicScore: 3.4,
            riskBand: 'normal' as const,
        };
        const ranked = assignFeaturedRiskRanks([normal, ...caution.reverse(), ...high.reverse()]);

        const featuredHigh = ranked.filter(row => (
            row.riskBand === 'high_risk' && row.featuredRank !== null
        ));
        const featuredCaution = ranked.filter(row => (
            row.riskBand === 'caution' && row.featuredRank !== null
        ));

        expect(featuredHigh).toHaveLength(FEATURED_RISK_LIMITS.high_risk);
        expect(featuredCaution).toHaveLength(FEATURED_RISK_LIMITS.caution);
        expect(featuredHigh.map(row => row.candidateId)).toEqual(['high-2', 'high-1', 'high-0']);
        expect(featuredHigh.map(row => row.featuredRank)).toEqual([3, 2, 1]);
        expect(ranked.filter(row => row.riskBand === 'high_risk')).toHaveLength(5);
        expect(ranked.find(row => row.candidateId === 'normal-0')?.featuredRank).toBeNull();
    });

    it('uses candidate ID as a deterministic tie-break and rejects duplicate IDs', () => {
        const tied = assignFeaturedRiskRanks([
            { candidateId: 'beta', publicScore: 7, riskBand: 'high_risk' },
            { candidateId: 'alpha', publicScore: 7, riskBand: 'high_risk' },
        ]);

        expect(tied.find(row => row.candidateId === 'alpha')?.featuredRank).toBe(1);
        expect(tied.find(row => row.candidateId === 'beta')?.featuredRank).toBe(2);
        expect(() => assignFeaturedRiskRanks([
            { candidateId: 'same', publicScore: 8, riskBand: 'high_risk' },
            { candidateId: 'same', publicScore: 7, riskBand: 'high_risk' },
        ])).toThrow('candidateId must be non-empty and unique');
    });

    it('fails closed on impossible score-band pairs and non-display precision', () => {
        expect(() => assignFeaturedRiskRanks([
            { candidateId: 'impossible', publicScore: 3.4, riskBand: 'high_risk' },
        ])).toThrow('publicScore and riskBand are incompatible');
        expect(() => assignFeaturedRiskRanks([
            { candidateId: 'over-precise', publicScore: 7.21, riskBand: 'high_risk' },
        ])).toThrow('publicScore must have at most one decimal place');

        expect(assignFeaturedRiskRanks([
            { candidateId: 'rounded-normal', publicScore: 4.2, riskBand: 'normal' },
            { candidateId: 'rounded-caution', publicScore: 6.8, riskBand: 'caution' },
        ])).toMatchObject([
            { candidateId: 'rounded-normal', featuredRank: null },
            { candidateId: 'rounded-caution', featuredRank: 1 },
        ]);
    });
});

describe('reverse-like verification shortlist', () => {
    it('freezes exactly the global preliminary top ten with deterministic ties', () => {
        const candidates = Array.from({ length: 12 }, (_, index) => ({
            candidateId: `candidate-${String(12 - index).padStart(2, '0')}`,
            preScore: index < 4 ? 90 : 80 - index,
        }));
        const assigned = assignVerificationShortlist(candidates);
        const shortlisted = assigned
            .filter(candidate => candidate.verificationShortlistRank !== null)
            .sort((left, right) => (
                left.verificationShortlistRank! - right.verificationShortlistRank!
            ));

        expect(shortlisted).toHaveLength(VERIFICATION_SHORTLIST_LIMIT);
        expect(shortlisted.slice(0, 4).map(candidate => candidate.candidateId)).toEqual([
            'candidate-09',
            'candidate-10',
            'candidate-11',
            'candidate-12',
        ]);
        expect(assigned.filter(candidate => candidate.verificationShortlistRank === null))
            .toHaveLength(2);
    });

    it('rejects duplicate IDs and scores outside the 97-point preliminary range', () => {
        expect(() => assignVerificationShortlist([
            { candidateId: 'same', preScore: 10 },
            { candidateId: 'same', preScore: 9 },
        ])).toThrow('candidateId must be non-empty and unique');
        expect(() => assignVerificationShortlist([
            { candidateId: 'candidate', preScore: PRE_SCORE_MAX + 0.1 },
        ])).toThrow(RangeError);
    });
});
