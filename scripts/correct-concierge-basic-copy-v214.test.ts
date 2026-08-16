import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const v214TestMocks = vi.hoisted(() => ({
    analyzeWithGemini: vi.fn(),
    strictHighRiskNarrative: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/services/ai/gemini', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/ai/gemini')>(),
    analyzeWithGemini: v214TestMocks.analyzeWithGemini,
}));
vi.mock('@/lib/services/ai/v2-staged-analysis', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/ai/v2-staged-analysis')>(),
    highRiskNarrative: v214TestMocks.strictHighRiskNarrative,
}));

import {
    buildV214NarrativeInput,
    buildV214GeminiCopyPayload,
    generateV214RelaxedNarrative,
    generateV214GeminiCopyWithSchemaRetry,
    type V214FrozenResultRow,
} from './correct-concierge-basic-copy-v214';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';

const syllables = [
    '가', '나', '다', '라', '마', '바', '사', '아',
    '자', '차', '카', '타', '파', '하', '도', '루',
];

function frozenRows(): V214FrozenResultRow[] {
    return syllables.map((syllable, index) => ({
        rank: index + 1,
        suspect_instagram_id: `candidate.${syllable}`,
        suspect_full_name: `박${syllable}민`,
        risk_grade: index < 2 ? 'high_risk' : 'normal',
        one_line_overview: `v2.13 기존 문구 ${syllable}는 이번 Gemini 전용 재작성 전에 게시된 문장입니다.`,
        risk_analysis: index < 2
            ? [`기존 고위험 ${syllable} 첫 줄`, `기존 고위험 ${syllable} 둘째 줄`]
            : [],
        risk_score: 91 - index,
        gender_status: 'confirmed',
        gender_confidence: 0.99,
        likes_count: index === 0 ? 3 : 0,
        intimate_comments_count: index === 1 ? 1 : 0,
        profile_data: { immutable: syllable },
    }));
}

function geminiRows(rows: readonly V214FrozenResultRow[]) {
    const evidenceTerms = [
        '독립영화', '새벽러닝', '손빚도자기', '사워도우',
        '재즈공연', '해안트레킹', '빈티지카메라', '수채화드로잉',
        '북토크', '클라이밍', '식물가꾸기', '야간자전거',
        '플라워클래스', '다큐멘터리', '쿠킹워크숍', '오디오북',
    ];
    return rows.map((row, index) => ({
        rank: row.rank,
        source: 'gemini' as const,
        oneLineOverview: `Gemini가 ${evidenceTerms[index]} 기록을 근거로 새로 작성한 ${syllables[index]} 계정의 공개 소개 문장입니다.`,
        riskAnalysis: row.risk_grade === 'high_risk'
            ? [
                `박${syllables[index]}민님은 피드와 소개에 남은 전시 기록을 바탕으로 확인했습니다.`,
                `박${syllables[index]}민님이 김준호님 게시물에 좋아요를 남긴 관찰 근거를 함께 확인했습니다.`,
            ]
            : [],
        evidence: row.risk_grade === 'high_risk'
            ? { candidateFullName: `박${syllables[index]}민`, targetFullName: '김준호', observedInteraction: 'like' as const }
            : null,
    }));
}

describe('v2.14 first-payment Gemini copy correction', () => {
    it('retries schema-rejected Gemini copy generation up to three total attempts', async () => {
        const generate = vi.fn()
            .mockRejectedValueOnce(new Error('AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'))
            .mockRejectedValueOnce(new Error('AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'))
            .mockResolvedValueOnce('valid-copy');

        await expect(generateV214GeminiCopyWithSchemaRetry(generate)).resolves.toBe('valid-copy');
        expect(generate).toHaveBeenCalledTimes(3);
    });

    it('fails closed after the third schema-rejected generation attempt', async () => {
        const rejection = new Error('AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.');
        const generate = vi.fn().mockRejectedValue(rejection);

        await expect(generateV214GeminiCopyWithSchemaRetry(generate)).rejects.toBe(rejection);
        expect(generate).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-schema generation errors', async () => {
        const failure = new Error('AI_RATE_LIMIT_ERROR: quota unavailable.');
        const generate = vi.fn().mockRejectedValue(failure);

        await expect(generateV214GeminiCopyWithSchemaRetry(generate)).rejects.toBe(failure);
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('retries only a repaired feature overview Zod rejection', async () => {
        const failure = new z.ZodError([{
            code: 'custom',
            path: ['oneLineOverview'],
            message: 'overview repair rejected',
        }]);
        const generate = vi.fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce('valid-copy');

        await expect(generateV214GeminiCopyWithSchemaRetry(generate)).resolves.toBe('valid-copy');
        expect(generate).toHaveBeenCalledTimes(2);
    });

    it('retries only the scoped narrative privacy rejection', async () => {
        const failure = new Error('CONCIERGE_COPY_V214_NARRATIVE_PRIVACY_INVALID');
        const generate = vi.fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce('valid-copy');

        await expect(generateV214GeminiCopyWithSchemaRetry(generate)).resolves.toBe('valid-copy');
        expect(generate).toHaveBeenCalledTimes(2);
    });

    it('binds the first-result adapter to retained bidirectional evidence without reverse comments', () => {
        const target = {
            username: 'target.user', fullName: '김준호', followersCount: 1,
            followingCount: 1, postsCount: 1, isPrivate: false, isVerified: false,
            latestPosts: [],
        };
        const candidate = {
            username: 'candidate.user', fullName: '박민지', bio: '여행 기록',
            followersCount: 1, followingCount: 1, postsCount: 1,
            isPrivate: false, isVerified: false,
            latestPosts: [{
                id: 'candidate-post', shortCode: 'candidate', imageUrl: 'https://example.com/post.jpg',
                type: 'image' as const, likesCount: 1, commentsCount: 1,
                timestamp: '2026-01-01T00:00:00.000Z', taggedUsers: ['target.user'],
                mentionedUsers: ['target.user'],
            }],
        };
        const capturedProfile = {
            ordinal: 1, isPrivate: false, username: 'candidate.user', fullName: '박민지',
            hasProfileImage: true, bio: '여행 기록',
            media: [{ selectionId: 'post:candidate:1', kind: 'feed' as const, postId: 'candidate-post', jpegBase64: 'aGVsbG8=' }],
            triageSelectionIds: ['post:candidate:1'], featureSelectionIds: ['post:candidate:1'],
            resolverSelectionIds: ['post:candidate:1'], captions: [],
            coverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
        } as Parameters<typeof buildV214NarrativeInput>[0]['capturedProfile'];
        const feature = {
            features: {
                gender: 'female', genderConfidence: 'high', ownerConsistency: 'same_person',
                appearanceGrade: 4, exposureScore: 2, businessClassification: 'personal',
                businessConfidence: 'high', accountContext: 'personal', marriageEvidence: 'none',
                partnerEvidence: 'none', partnerExclusionContext: 'none',
                evidenceSelectionIds: { gender: [], appearance: ['post:candidate:1'], exposure: [], business: [], accountContext: [], marriagePartner: [] },
                oneLineOverview: '여행 기록이 또렷하게 남는 계정입니다.',
            },
            finalGenderDecision: 'verified_female', analyzedSelectionIds: ['post:candidate:1'],
        } as FeatureAnalysisResult;
        const input = buildV214NarrativeInput({
            targetProfile: target, candidateProfile: candidate, capturedProfile, feature,
            interactions: [{
                candidateUsername: 'candidate.user', postId: 'target-post',
                signal: 'female_target_like', sourceInteractionId: 'like:1',
            }, {
                candidateUsername: 'candidate.user', postId: 'target-post',
                signal: 'female_target_comment', sourceInteractionId: 'comment:1', content: '좋은 기록이에요',
            }],
            targetToCandidateLike: { status: 'observed', evidenceRefIds: ['retained:reverse-like:test'] },
            targetSelectedPostEvidence: [{
                postId: 'target-post', selectionId: 'retained:target-post-selection:test',
                taggedUsers: ['candidate.user'], mentionedUsers: ['candidate.user'],
            }],
        });
        expect(input.interactions.candidateToTargetLike.status).toBe('observed');
        expect(input.interactions.candidateToTargetComment.status).toBe('observed');
        expect(input.interactions.targetToCandidateLike).toEqual({
            status: 'observed', evidenceRefIds: ['retained:reverse-like:test'],
        });
        expect(input.interactions.candidateToTargetTag.status).toBe('observed');
        expect(input.interactions.candidateToTargetMention.status).toBe('observed');
        expect(input.interactions.targetToCandidateTag.status).toBe('observed');
        expect(input.interactions.targetToCandidateMention.status).toBe('observed');
        expect(input.interactions.targetToCandidateComment).toEqual({
            status: 'not_collected', evidenceRefIds: [],
        });
    });

    it('uses the canonical target username when the retained target fullname is absent', () => {
        const target = {
            username: 'target.user', followersCount: 1,
            followingCount: 1, postsCount: 1, isPrivate: false, isVerified: false,
            latestPosts: [],
        };
        const candidate = {
            username: 'candidate.user', fullName: '박민지', bio: '여행 기록',
            followersCount: 1, followingCount: 1, postsCount: 1,
            isPrivate: false, isVerified: false,
            latestPosts: [],
        };
        const capturedProfile = {
            ordinal: 1, isPrivate: false, username: 'candidate.user', fullName: '박민지',
            hasProfileImage: true, bio: '여행 기록',
            media: [{ selectionId: 'post:candidate:1', kind: 'feed' as const, postId: 'candidate-post', jpegBase64: 'aGVsbG8=' }],
            triageSelectionIds: ['post:candidate:1'], featureSelectionIds: ['post:candidate:1'],
            resolverSelectionIds: ['post:candidate:1'], captions: [],
            coverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
        } as Parameters<typeof buildV214NarrativeInput>[0]['capturedProfile'];
        const feature = {
            features: {
                gender: 'female', genderConfidence: 'high', ownerConsistency: 'same_person',
                appearanceGrade: 4, exposureScore: 2, businessClassification: 'personal',
                businessConfidence: 'high', accountContext: 'personal', marriageEvidence: 'none',
                partnerEvidence: 'none', partnerExclusionContext: 'none',
                evidenceSelectionIds: { gender: [], appearance: ['post:candidate:1'], exposure: [], business: [], accountContext: [], marriagePartner: [] },
                oneLineOverview: '여행 기록이 또렷하게 남는 계정입니다.',
            },
            finalGenderDecision: 'verified_female', analyzedSelectionIds: ['post:candidate:1'],
        } as FeatureAnalysisResult;

        const input = buildV214NarrativeInput({
            targetProfile: target, candidateProfile: candidate, capturedProfile, feature,
            interactions: [{
                candidateUsername: 'candidate.user', postId: 'target-post',
                signal: 'female_target_like', sourceInteractionId: 'like:1',
            }],
            targetToCandidateLike: { status: 'observed', evidenceRefIds: ['retained:reverse-like:test'] },
        });

        expect(input.publicSubjects.targetFullName).toBe('target.user');
    });

    it('accepts only Gemini replacement copy and preserves an exact non-copy snapshot for all sixteen v2.13 rows', () => {
        const rows = frozenRows();
        const payload = buildV214GeminiCopyPayload({ rows, generated: geminiRows(rows) });

        expect(payload.qualityVersion).toBe('v214-gemini-first-payment-copy-v1');
        expect(payload.rows).toHaveLength(16);
        expect(new Set(payload.rows.map(row => row.oneLineOverview)).size).toBe(16);
        expect(payload.rows.every((row, index) => row.oneLineOverview !== rows[index]?.one_line_overview))
            .toBe(true);
        const highRiskRows = payload.rows.filter(row => row.riskGrade === 'high_risk');
        expect(highRiskRows).toHaveLength(2);
        highRiskRows.forEach(row => {
            expect(row.evidence).toBeDefined();
            expect(row.riskAnalysis).toHaveLength(2);
            expect(row.riskAnalysis.join(' ')).toContain(row.evidence!.candidateFullName);
            expect(row.riskAnalysis.join(' ')).toContain(row.evidence!.targetFullName);
            expect(row.riskAnalysis.join(' ')).toContain('좋아요');
        });
        expect(payload.factSnapshot).toEqual(rows.map(row => ({
            rank: row.rank,
            suspect_instagram_id: row.suspect_instagram_id,
            suspect_full_name: row.suspect_full_name,
            risk_grade: row.risk_grade,
            risk_score: row.risk_score,
            gender_status: row.gender_status,
            gender_confidence: row.gender_confidence,
            likes_count: row.likes_count,
            intimate_comments_count: row.intimate_comments_count,
            profile_data: row.profile_data,
        })));
    });

    it('rejects fallback copy and high-risk text that lacks current full-name or observed-interaction evidence', () => {
        const rows = frozenRows();
        const fallback = geminiRows(rows);
        fallback[4] = { ...fallback[4]!, source: 'safe_fallback' as never };
        expect(() => buildV214GeminiCopyPayload({ rows, generated: fallback }))
            .toThrow('CONCIERGE_COPY_V214_GEMINI_SOURCE_REQUIRED');

        const incompleteNarrative = geminiRows(rows);
        incompleteNarrative[0] = {
            ...incompleteNarrative[0]!,
            riskAnalysis: ['관계 흐름을 검토했습니다.', '상호작용을 확인했습니다.'],
        };
        expect(() => buildV214GeminiCopyPayload({ rows, generated: incompleteNarrative }))
            .toThrow('CONCIERGE_COPY_V214_HIGH_RISK_EVIDENCE_INVALID');

        const priorRowsWithGeminiNarrative = frozenRows();
        const unchangedNarrative = geminiRows(priorRowsWithGeminiNarrative);
        priorRowsWithGeminiNarrative[0] = {
            ...priorRowsWithGeminiNarrative[0]!,
            risk_analysis: unchangedNarrative[0]!.riskAnalysis,
        };
        expect(() => buildV214GeminiCopyPayload({
            rows: priorRowsWithGeminiNarrative,
            generated: unchangedNarrative,
        }))
            .toThrow('CONCIERGE_COPY_V214_HIGH_RISK_NARRATIVE_UNCHANGED');
    });

    it('uses only the scoped relaxed DTO and never calls the strict global narrative wrapper', async () => {
        const target = {
            username: 'target.user', fullName: '김준호', followersCount: 1,
            followingCount: 1, postsCount: 1, isPrivate: false, isVerified: false,
            latestPosts: [],
        };
        const candidate = {
            username: 'candidate.user', fullName: '박민지',
            bio: '여행 기록 https://private.example @other.user 010-1234-5678',
            followersCount: 1, followingCount: 1, postsCount: 1,
            isPrivate: false, isVerified: false,
            latestPosts: [],
        };
        const capturedProfile = {
            ordinal: 1, isPrivate: false, username: 'candidate.user', fullName: '박민지',
            hasProfileImage: true, bio: '여행 기록',
            media: [{ selectionId: 'post:candidate:1', kind: 'feed' as const, postId: 'candidate-post', jpegBase64: 'aGVsbG8=' }],
            triageSelectionIds: ['post:candidate:1'], featureSelectionIds: ['post:candidate:1'],
            resolverSelectionIds: ['post:candidate:1'], captions: [],
            coverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
        } as Parameters<typeof buildV214NarrativeInput>[0]['capturedProfile'];
        const feature = {
            features: {
                gender: 'female', genderConfidence: 'high', ownerConsistency: 'same_person',
                appearanceGrade: 4, exposureScore: 2, businessClassification: 'personal',
                businessConfidence: 'high', accountContext: 'personal', marriageEvidence: 'none',
                partnerEvidence: 'none', partnerExclusionContext: 'none',
                evidenceSelectionIds: { gender: [], appearance: [], exposure: [], business: [], accountContext: [], marriagePartner: [] },
                oneLineOverview: '여행 기록이 또렷하게 남는 계정입니다.',
            },
            finalGenderDecision: 'verified_female', analyzedSelectionIds: ['post:candidate:1'],
        } as FeatureAnalysisResult;
        const narrativeInput = buildV214NarrativeInput({
            targetProfile: target, candidateProfile: candidate, capturedProfile, feature,
            interactions: [{
                candidateUsername: 'candidate.user', postId: 'target-post',
                signal: 'female_target_like', sourceInteractionId: 'like:1',
            }],
            targetToCandidateLike: { status: 'not_observed', evidenceRefIds: [] },
        });
        const likeRef = narrativeInput.interactions.candidateToTargetLike.evidenceRefIds[0]!;
        const coverageRef = narrativeInput.interactions.coverage.evidenceRefId;
        v214TestMocks.strictHighRiskNarrative.mockImplementation(() => {
            throw new Error('STRICT_WRAPPER_MUST_NOT_BE_CALLED');
        });
        let capturedPrompt = '';
        v214TestMocks.analyzeWithGemini.mockImplementationOnce(async (
            prompt: string,
            _images: readonly string[],
            options: { schema: { parse(value: unknown): unknown } },
        ) => {
            capturedPrompt = prompt;
            return options.schema.parse({
                lines: [{
                    text: '박민지님의 여행 기록은 연애 맥락으로도 읽힙니다.',
                    evidenceRefs: ['profile:bio'],
                }, {
                    text: '박민지님이 김준호님에게 좋아요를 남긴 흐름은 연애 중으로 보입니다.',
                    evidenceRefs: [likeRef, coverageRef],
                }],
            });
        });

        const result = await generateV214RelaxedNarrative({
            narrativeInput,
            candidateFullName: '박민지',
            targetFullName: '김준호',
            requestId: '11111111-1111-4111-8111-111111111111',
            replayCapability: issueReplayStatelessCapability(),
        });

        expect(v214TestMocks.strictHighRiskNarrative).not.toHaveBeenCalled();
        expect(v214TestMocks.analyzeWithGemini).toHaveBeenCalledOnce();
        expect(result.lines).toHaveLength(2);
        expect(result.lines[0]?.text).toContain('연애 맥락');
        expect(result.lines[1]?.text).toContain('연애 중');
        expect(result.lines[1]?.evidenceRefs).toEqual([likeRef, coverageRef]);
        expect(capturedPrompt).not.toContain('private.example');
        expect(capturedPrompt).not.toContain('@other.user');
        expect(capturedPrompt).not.toContain('010-1234-5678');
        expect(capturedPrompt).toContain('[링크 제거]');
        expect(capturedPrompt).toContain('[계정명 제거]');
        expect(capturedPrompt).toContain('[연락처 제거]');

        v214TestMocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: readonly string[],
            options: { schema: { parse(value: unknown): unknown } },
        ) => options.schema.parse({
            lines: [{
                text: '박민지님의 여행 기록은 2026년에도 이어집니다.',
                evidenceRefs: ['profile:bio'],
            }, {
                text: '박민지님이 김준호님에게 좋아요를 남긴 흐름은 확인됩니다.',
                evidenceRefs: [likeRef, coverageRef],
            }],
        }));
        await expect(generateV214RelaxedNarrative({
            narrativeInput,
            candidateFullName: '박민지',
            targetFullName: '김준호',
            requestId: '11111111-1111-4111-8111-111111111111',
            replayCapability: issueReplayStatelessCapability(),
        })).rejects.toThrow('CONCIERGE_COPY_V214_NARRATIVE_PRIVACY_INVALID');
    });
});
