import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { buildCorrectionPayload, summarizeCorrectionQuality } from './correct-concierge-basic-copy';

const syllables = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하', '도', '루'];

describe('first published concierge copy correction', () => {
    it('replaces every one-line overview and carries an evidence-grounded semantic review for all sixteen rows', () => {
        const rows = Array.from({ length: 16 }, (_, index) => ({
            rank: index + 1,
            suspect_instagram_id: `candidate.${syllables[index]}`,
            suspect_full_name: `박${syllables[index]}민`,
            risk_grade: index < 2 ? 'high_risk' as const : 'normal' as const,
            one_line_overview: `기존 문구 ${syllables[index]}는 이번 전체 검토에서 새로 작성합니다.`,
            risk_analysis: index < 2 ? ['기존 고위험 문장 첫 줄', '기존 고위험 문장 둘째 줄'] : [],
            likes_count: index === 0 ? 1 : 0,
            intimate_comments_count: index === 1 ? 1 : 0,
            normal_comments_count: 0,
            post_tags_count: index === 0 ? 1 : 0,
            caption_mentions_count: 0,
            comment_mentions_count: 0,
            female_to_target_likes_count: index === 0 ? 1 : 0,
            female_to_target_comments_count: index === 1 ? 1 : 0,
            target_to_female_likes_count: 0,
            photogenic_grade: index === 0 ? 5 : 1,
            is_tagged: index === 0,
        }));
        const profiles = new Map(rows.map((row, index) => [row.suspect_instagram_id, {
            fullName: row.suspect_full_name,
            bio: `${['도자기', '러닝', '독서', '베이킹'][index % 4]} 기록`,
            profilePicUrl: index === 0 ? 'https://example.com/one.jpg' : undefined,
            latestPosts: [{
                caption: `${['성수', '한강', '연희', '망원'][index % 4]}의 ${['전시', '산책', '커피', '공연'][index % 4]} 장면`,
                imageUrl: 'https://example.com/post.jpg',
            }],
        }]));
        const payload = buildCorrectionPayload({
            targetUsername: 'target.user',
            targetFullName: '김준호',
            rows,
            profiles,
            targetEvidence: [
                { actorUsername: 'candidate.가', postId: 'target-post-1', signal: 'target_post_like', sourceInteractionId: 'like-1' },
                { actorUsername: 'candidate.나', postId: 'target-post-2', signal: 'target_post_comment', sourceInteractionId: 'comment-1' },
            ],
            reverseInteractions: {
                version: 'concierge-reverse-interactions-v1',
                orderId: '11111111-1111-4111-8111-111111111111',
                resultRequestId: '22222222-2222-4222-8222-222222222222',
                targetToCandidateCoverage: 'bounded_apify_likers_v1',
                candidateCount: 16,
                collectedCount: 16,
                unavailable: [],
                observations: rows.map(row => ({
                    rank: row.rank,
                    username: row.suspect_instagram_id,
                    postUrl: `https://example.com/${row.suspect_instagram_id}`,
                    targetLikedCandidate: false,
                    returnedLikerCount: 0,
                })),
                artifactHash: 'a'.repeat(64),
            },
        });

        expect(payload.qualityVersion).toBe('v213-full-evidence-review-v1');
        expect(payload.rows).toHaveLength(16);
        expect(new Set(payload.rows.map(row => row.oneLineOverview)).size).toBe(16);
        expect(payload.rows.every(row => row.review.overviewChanged)).toBe(true);
        expect(payload.rows.every(row => row.review.previousOverview !== row.oneLineOverview)).toBe(true);
        expect(payload.rows.map(row => row.review.overviewForm)).toHaveLength(16);
        expect(summarizeCorrectionQuality(payload)).toEqual({
            resultRows: 16,
            distinctOverviews: 16,
            reviewedRows: 16,
            changedOverviewRows: 16,
            uniqueOverviewForms: 16,
            nearDuplicateOverviewPairs: 0,
            forbiddenCopyRows: 0,
            highRiskRows: 2,
            highRiskDirectionRows: 2,
            retainedNarrativeSentences: 0,
        });
        const [highRisk] = payload.rows;
        expect(highRisk?.riskAnalysis.join(' ')).toContain('박가민님이 김준호님 게시물에 좋아요를 남긴 흐름');
        expect(highRisk?.riskAnalysis.join(' ')).toContain('사진이 관계 설명서를 써주지는 않습니다');
        expect(highRisk?.riskAnalysis.join(' ')).not.toMatch(/(?:대상\s*계정|후보\s*계정|위장여사친)/u);
    });
});
