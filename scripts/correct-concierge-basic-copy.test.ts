import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { buildCorrectionPayload } from './correct-concierge-basic-copy';

describe('first published concierge copy correction', () => {
    it('preserves natural grounded overview copy while adding named, non-probative high-risk context', () => {
        const payload = buildCorrectionPayload({
            targetUsername: 'target.user',
            targetFullName: '김준호',
            rows: [
                {
                    rank: 1,
                    suspect_instagram_id: 'candidate.one',
                    suspect_full_name: '박민지',
                    risk_grade: 'high_risk',
                    one_line_overview: '사진과 소개에 드러난 개인 기록의 결이 선명해서, 피드가 보여 준 장면부터 차분히 짚어볼 계정입니다.',
                    risk_analysis: [],
                    likes_count: 1,
                    intimate_comments_count: 0,
                    normal_comments_count: 0,
                    post_tags_count: 0,
                    caption_mentions_count: 0,
                    comment_mentions_count: 0,
                    female_to_target_likes_count: 1,
                    female_to_target_comments_count: 0,
                    target_to_female_likes_count: 0,
                    photogenic_grade: 5,
                    is_tagged: false,
                },
                {
                    rank: 2,
                    suspect_instagram_id: 'candidate.two',
                    suspect_full_name: '최유나',
                    risk_grade: 'normal',
                    one_line_overview: '커피와 독서 기록이 이어져, 조용한 주말 취향이 자연스럽게 드러나는 피드입니다.',
                    risk_analysis: [],
                    likes_count: 0,
                    intimate_comments_count: 0,
                    normal_comments_count: 0,
                    post_tags_count: 0,
                    caption_mentions_count: 0,
                    comment_mentions_count: 0,
                    female_to_target_likes_count: 0,
                    female_to_target_comments_count: 0,
                    target_to_female_likes_count: 0,
                    photogenic_grade: 1,
                    is_tagged: false,
                },
            ],
            profiles: new Map([
                ['candidate.one', {
                    fullName: '박민지', bio: '성수 전시와 커피를 기록합니다',
                    profilePicUrl: 'https://example.com/one.jpg',
                    latestPosts: [{ caption: '전시 관람 후 남긴 기록', imageUrl: 'https://example.com/one-post.jpg' }],
                }],
                ['candidate.two', {
                    fullName: '최유나', bio: '커피와 독서 기록',
                    latestPosts: [{ caption: '주말 독서와 커피', imageUrl: 'https://example.com/two-post.jpg' }],
                }],
            ]),
            targetEvidence: [{
                actorUsername: 'candidate.one', postId: 'target-post-1',
                signal: 'target_post_like', sourceInteractionId: 'like-1',
            }],
            reverseInteractions: {
                version: 'concierge-reverse-interactions-v1',
                orderId: '11111111-1111-4111-8111-111111111111',
                resultRequestId: '22222222-2222-4222-8222-222222222222',
                targetToCandidateCoverage: 'bounded_apify_likers_v1',
                candidateCount: 16,
                collectedCount: 2,
                unavailable: [],
                observations: [
                    { rank: 1, username: 'candidate.one', postUrl: 'https://example.com/one', targetLikedCandidate: false, returnedLikerCount: 0 },
                    { rank: 2, username: 'candidate.two', postUrl: 'https://example.com/two', targetLikedCandidate: false, returnedLikerCount: 0 },
                ],
                artifactHash: 'a'.repeat(64),
            },
        });

        const [highRisk, normal] = payload.rows;
        expect(highRisk?.riskAnalysis.join(' ')).toContain('박민지님이 김준호님 게시물에 남긴 좋아요');
        expect(highRisk?.riskAnalysis.join(' ')).toContain('위장여사친이 아니라고 하기엔 너무 예쁩니다');
        expect(highRisk?.riskAnalysis.join(' ')).toContain('이미지 인상만으로 관계를 판단할 수는 없습니다');
        expect(highRisk?.riskAnalysis.join(' ')).not.toMatch(/(?:대상\s*계정|후보\s*계정)/u);
        expect(normal?.oneLineOverview).toBe(
            '커피와 독서 기록이 이어져, 조용한 주말 취향이 자연스럽게 드러나는 피드입니다.',
        );
    });
});
