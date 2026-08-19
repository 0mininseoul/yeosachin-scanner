import { describe, expect, it } from 'vitest';
import {
    buildSafeFallbackRiskNarrative,
    containsExposedInteractionMetric,
    isSafePublicRiskNarrativeLine,
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

    it('allows an ordinary time expression when it does not expose an interaction count', () => {
        expect(containsExposedInteractionMetric(
            '한 번 본 뒤에도 은근히 기억에 남습니다.'
        )).toBe(false);
    });

    it('blocks a quantity moved into a neighboring interaction sentence', () => {
        expect(containsExposedInteractionMetric(
            '좋아요 흔적은 보입니다. 세 번 확인했습니다. 수집 표본 밖 누락은 가능합니다.'
        )).toBe(true);
        expect(containsExposedInteractionMetric(
            '댓글 흔적은 보입니다. three times 확인했습니다. 수집 표본 밖 누락은 가능합니다.'
        )).toBe(true);
    });

    it('requires exactly two safe, evidence-calibrated lines with interactions and a sampling caveat', () => {
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
        ])).toEqual([
            '프로필은 꽤 활발합니다.',
            '댓글 흔적은 확인되지만 수집 표본 밖 누락은 가능합니다.',
        ]);
        expect(parseSafePublicRiskNarrative([
            '프로필과 피드는 굳이 눈에 띕니다.',
            '좋아요 three times가 관측됐지만, 수집 표본 밖 누락 가능성은 남습니다.',
        ])).toBeNull();
        expect(parseSafePublicRiskNarrative([
            '프로필과 피드는 굳이 눈에 띕니다.',
            '좋아요 흔적은 보입니다. 관측치는 세 번이며 수집 표본 밖 누락은 가능합니다.',
        ])).toBeNull();
    });

    it('allows the candidate and target handles as digit exceptions without loosening other digit blocks', () => {
        // The approved exception: the row's own handle and the target's handle
        // may contain digits and still pass, once explicitly allow-listed.
        expect(containsExposedInteractionMetric(
            '채은님은 일본 여행의 추억을 공유하며 9ad8fa.01의 게시물에 좋아요를 눌렀습니다.',
            ['chan__0.o', '9ad8fa.01']
        )).toBe(false);
        expect(containsExposedInteractionMetric(
            '2ynbiu는 9ad8fa.01의 게시물에 좋아요를 눌러 관심을 표현했습니다.',
            ['2ynbiu', '9ad8fa.01']
        )).toBe(false);
        expect(containsExposedInteractionMetric(
            'asuka1200cc는 서브컬처 아이템과 파격적인 의상을 즐깁니다.',
            ['asuka1200cc', '9ad8fa.01']
        )).toBe(false);

        // Unrelated digits are still blocked even when identifiers are supplied.
        expect(containsExposedInteractionMetric(
            '좋아요 3건을 남겼고 9ad8fa.01의 게시물에도 반응했습니다.',
            ['chan__0.o', '9ad8fa.01']
        )).toBe(true);
        expect(containsExposedInteractionMetric(
            '댓글 5개가 확인됐습니다.',
            ['chan__0.o', '9ad8fa.01']
        )).toBe(true);
        expect(containsExposedInteractionMetric(
            '좋아요를 세 번 남겼습니다.',
            ['chan__0.o', '9ad8fa.01']
        )).toBe(true);

        // Matching ignores case and normalizes width variants (NFKC) before comparing.
        expect(containsExposedInteractionMetric(
            'CHAN__0.O는 9AD8FA.01의 게시물에 좋아요를 눌렀습니다.',
            ['chan__0.o', '9ad8fa.01']
        )).toBe(false);

        // A single-argument call must behave exactly as before the exception was added.
        expect(containsExposedInteractionMetric(
            '채은님은 일본 여행의 추억을 공유하며 9ad8fa.01의 게시물에 좋아요를 눌렀습니다.'
        )).toBe(true);
    });

    it('threads the identifier exception through isSafePublicRiskNarrativeLine', () => {
        const line = '채은님은 일본 여행의 추억을 공유하며 9ad8fa.01의 게시물에 좋아요를 눌렀습니다.';
        expect(isSafePublicRiskNarrativeLine(line, ['chan__0.o', '9ad8fa.01'])).toBe(true);
        expect(isSafePublicRiskNarrativeLine(line)).toBe(false);
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
