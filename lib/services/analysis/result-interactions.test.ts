import { describe, expect, it } from 'vitest';
import {
    targetProfileImageFromStepData,
    toResultInteractionSummary,
    toSafeRiskAnalysis,
} from './result-interactions';

describe('toResultInteractionSummary', () => {
    it('publishes only the bounded high-risk narrative', () => {
        expect(toResultInteractionSummary({
            risk_grade: 'high_risk',
            interaction_score: 55,
            interaction_coverage: '0.81234',
            interaction_coverage_status: 'high',
            female_to_target_likes_count: 3,
            female_to_target_comments_count: 2,
            target_to_female_likes_count: 1,
            recency_bonus: '6.667',
            risk_analysis: [
                '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
            ],
        })).toEqual({
            riskAnalysis: [
                '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
            ],
        });
    });

    it('fails closed to safe bounds for legacy or malformed rows', () => {
        expect(toResultInteractionSummary({
            risk_grade: 'high_risk',
            interaction_score: 999,
            interaction_coverage: -3,
            female_to_target_likes_count: 'invalid',
            female_to_target_comments_count: 999,
            target_to_female_likes_count: -1,
            recency_bonus: 999,
            risk_analysis: ['한 줄만 제공된 잘못된 값'],
        })).toEqual({
            riskAnalysis: [],
        });
    });

    it('normalizes exactly two distinct safe analysis lines', () => {
        expect(toSafeRiskAnalysis([
            '  <b>프로필은</b>\n꽤 눈에 띕니다.  ',
            '댓글 흔적은 제법 친절하지만\t수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([
            '프로필은 꽤 눈에 띕니다.',
            '댓글 흔적은 제법 친절하지만 수집 표본 밖 누락은 가능합니다.',
        ]);

        expect(toSafeRiskAnalysis(['중복', '중복'])).toEqual([]);
        expect(toSafeRiskAnalysis(['유효', 42])).toEqual([]);
    });

    it('withholds narratives outside the high-risk grade and rejects leaked metrics', () => {
        const lines = [
            '공개 프로필과 피드에서 위험 신호가 관측됐습니다.',
            '댓글 흔적은 보이지만 수집 표본 밖 누락은 가능합니다.',
        ];

        expect(toResultInteractionSummary({
            risk_grade: 'caution',
            risk_analysis: lines,
        })).toEqual({ riskAnalysis: [] });
        expect(toSafeRiskAnalysis([
            '좋아요 3건이 관측됐습니다.',
            '댓글 1개가 보이지만 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([]);
        expect(toSafeRiskAnalysis([
            '프로필은 꽤 눈에 띕니다.',
            '좋아요를 세 번 확인했고 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([]);
        expect(toSafeRiskAnalysis([
            '프로필은 꽤 눈에 띕니다.',
            '댓글은 두 개 보였지만 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([]);
    });

    it('allows only normalized Instagram media URLs from step data', () => {
        expect(targetProfileImageFromStepData({
            targetProfileImage: 'https://scontent.cdninstagram.com/avatar.jpg#fragment',
        })).toBe('https://scontent.cdninstagram.com/avatar.jpg');

        expect(targetProfileImageFromStepData({
            targetProfileImage: 'http://scontent.cdninstagram.com/avatar.jpg',
        })).toBeUndefined();
        expect(targetProfileImageFromStepData({
            targetProfileImage: 'https://example.com/avatar.jpg',
        })).toBeUndefined();
        expect(targetProfileImageFromStepData({ targetProfileImage: 42 })).toBeUndefined();
        expect(targetProfileImageFromStepData(null)).toBeUndefined();
    });
});
