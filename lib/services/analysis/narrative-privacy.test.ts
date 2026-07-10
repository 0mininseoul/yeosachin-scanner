import { describe, expect, it } from 'vitest';
import {
    buildSafeFallbackRiskNarrative,
    containsExposedInteractionMetric,
    parseSafePublicRiskNarrative,
} from './narrative-privacy';

describe('public risk narrative privacy', () => {
    it('blocks Arabic and Korean interaction quantities', () => {
        expect(containsExposedInteractionMetric('좋아요 3건이 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('3번의 좋아요가 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요를 세 번 확인했습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('댓글은 두 개 보였습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 일 회가 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 수십 건이 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('댓글 스무 개가 보였습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 이십여 회가 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 백여 건이 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('댓글 서너 개가 보였습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 두어 번 확인했습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 three times가 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('댓글이 twice 확인됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('좋아요 ３건이 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric('댓글 ٣건이 관측됐습니다.')).toBe(true);
        expect(containsExposedInteractionMetric(
            '좋아요 흔적은 보입니다. 관측치는 세 번이며 표본 밖 누락은 가능합니다.'
        )).toBe(true);
        expect(containsExposedInteractionMetric('댓글 흔적은 제법 선명합니다.')).toBe(false);
    });

    it('requires exactly two safe, cynical lines with interactions and a sampling caveat', () => {
        expect(parseSafePublicRiskNarrative([
            '프로필과 피드는 꽤 눈에 띕니다.',
            '댓글 내용은 제법 친절하지만 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([
            '프로필과 피드는 꽤 눈에 띕니다.',
            '댓글 내용은 제법 친절하지만 수집 표본 밖 누락은 가능합니다.',
        ]);
        expect(parseSafePublicRiskNarrative([
            '프로필과 피드를 요약했습니다.',
            '수집 표본 밖 누락은 가능합니다.',
        ])).toBeNull();
        expect(parseSafePublicRiskNarrative([
            '프로필은 꽤 활발합니다.',
            '댓글 흔적은 확인되지만 수집 표본 밖 누락은 가능합니다.',
        ])).toBeNull();
        expect(parseSafePublicRiskNarrative([
            '프로필과 피드는 굳이 눈에 띕니다.',
            '좋아요 three times가 관측됐지만, 수집 표본 밖 누락 가능성은 남습니다.',
        ])).toBeNull();
        expect(parseSafePublicRiskNarrative([
            '프로필과 피드는 굳이 눈에 띕니다.',
            '좋아요 흔적은 보입니다. 관측치는 세 번이며 수집 표본 밖 누락은 가능합니다.',
        ])).toBeNull();
    });

    it('keeps fallback like directions accurate and never copies raw comment text', () => {
        const candidateOnly = buildSafeFallbackRiskNarrative({
            candidateLikedTarget: true,
            candidateCommentedOnTarget: true,
            targetLikedCandidate: false,
            commentText: '반가워 또 보자',
        });
        expect(candidateOnly[1]).toContain('후보가 대상 게시물에 남긴 좋아요 흔적');
        expect(candidateOnly[1]).not.toContain('서로 남긴 좋아요');
        expect(candidateOnly[1]).toContain('댓글의 “반가워” 표현');

        const targetOnly = buildSafeFallbackRiskNarrative({
            candidateLikedTarget: false,
            candidateCommentedOnTarget: false,
            targetLikedCandidate: true,
        });
        expect(targetOnly[1]).toContain('대상 계정이 후보 피드에 남긴 좋아요 흔적');

        const both = buildSafeFallbackRiskNarrative({
            candidateLikedTarget: true,
            candidateCommentedOnTarget: false,
            targetLikedCandidate: true,
        });
        expect(both[1]).toContain('서로 남긴 좋아요 흔적');
    });
});
