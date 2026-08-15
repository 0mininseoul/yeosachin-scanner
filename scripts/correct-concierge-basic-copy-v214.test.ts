import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    buildV214GeminiCopyPayload,
    type V214FrozenResultRow,
} from './correct-concierge-basic-copy-v214';

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
});
