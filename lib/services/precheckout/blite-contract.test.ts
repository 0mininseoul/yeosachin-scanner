import { describe, expect, it } from 'vitest';
import {
    PRECHECKOUT_BLITE_EVIDENCE_FIELDS,
    PRECHECKOUT_BLITE_SCHEMA_VERSION,
    derivePrecheckoutBliteSignalBand,
    precheckoutBliteV1Schema,
} from './blite-contract';

function signal(overrides: Partial<{
    claim: string;
    category: string;
    confidence: number;
    band: 'high' | 'medium' | 'low';
}> = {}) {
    return {
        claim: '최근 게시물에서 관계를 자주 태그하는 경향이 보여요.',
        category: '관계 노출 성향',
        confidence: 0.62,
        band: 'medium' as const,
        ...overrides,
    };
}

function validDto() {
    return {
        schemaVersion: PRECHECKOUT_BLITE_SCHEMA_VERSION,
        persona: {
            headline: '관계를 자주 드러내는 활발한 소통형 계정',
            summary: '최근 게시물 패턴을 보면 태그와 멘션을 통해 주변 관계를 자주 드러내는 편이에요. 이는 참고용 페르소나이며 확정적인 결론은 아니에요.',
        },
        signals: [
            signal({ claim: '태그된 사람과의 관계를 자주 드러내는 편이에요.', confidence: 0.82, band: 'high' as const }),
            signal({ claim: '캐러셀 게시물을 자주 활용해요.', category: '게시 습관', confidence: 0.62, band: 'medium' as const }),
            signal({ claim: '해시태그 사용이 적은 편이에요.', category: '게시 습관', confidence: 0.35, band: 'low' as const }),
            signal({ claim: '댓글 반응을 활발히 유도하는 캡션을 써요.', category: '소통 성향', confidence: 0.71, band: 'high' as const }),
        ],
        candidateRange: { min: 3, max: 9 },
        genderRead: {
            likelyFemale: true,
            confidence: 0.81,
            reasons: [
                '캡션 어투가 여성형 표현에 가까워요.',
                '태그된 계정 구성이 여성형 이름에 가까워요.',
                '게시물 주제가 여성형 관심사에 가까워요.',
            ],
        },
        postCount: 8,
        evidenceFields: ['post.caption', 'post.hashtags', 'post.taggedUsers'],
    };
}

describe('precheckoutBliteV1Schema', () => {
    it('accepts a well-formed DTO', () => {
        const parsed = precheckoutBliteV1Schema.safeParse(validDto());
        expect(parsed.success).toBe(true);
    });

    it('rejects when signals.length is not exactly 4', () => {
        const dto = validDto();
        dto.signals = dto.signals.slice(0, 3);
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a fifth signal', () => {
        const dto = validDto();
        dto.signals = [...dto.signals, signal()];
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects when genderRead.reasons.length is not exactly 3', () => {
        const dto = validDto();
        dto.genderRead.reasons = dto.genderRead.reasons.slice(0, 2);
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a band that disagrees with its confidence', () => {
        const dto = validDto();
        dto.signals[0] = signal({ confidence: 0.9, band: 'medium' });
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects confidence with more than two decimal places', () => {
        const dto = validDto();
        dto.signals[0] = signal({ confidence: 0.823, band: 'high' });
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects confidence outside 0..1', () => {
        const dto = validDto();
        dto.genderRead.confidence = 1.2;
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects when all four signals are high (calibration must stay honest)', () => {
        const dto = validDto();
        dto.signals = [
            signal({ confidence: 0.9, band: 'high' }),
            signal({ confidence: 0.85, band: 'high' }),
            signal({ confidence: 0.8, band: 'high' }),
            signal({ confidence: 0.75, band: 'high' }),
        ];
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('accepts three highs and one medium/low', () => {
        const dto = validDto();
        dto.signals = [
            signal({ confidence: 0.9, band: 'high' }),
            signal({ confidence: 0.85, band: 'high' }),
            signal({ confidence: 0.8, band: 'high' }),
            signal({ confidence: 0.5, band: 'medium' }),
        ];
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(true);
    });

    it('rejects candidateRange.min >= max', () => {
        const dto = validDto();
        dto.candidateRange = { min: 5, max: 5 };
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);

        const dtoDescending = validDto();
        dtoDescending.candidateRange = { min: 6, max: 5 };
        expect(precheckoutBliteV1Schema.safeParse(dtoDescending).success).toBe(false);
    });

    it('rejects a negative or non-integer candidateRange', () => {
        const dto = validDto();
        dto.candidateRange = { min: -1, max: 5 };
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);

        const dtoFraction = validDto();
        dtoFraction.candidateRange = { min: 1.5, max: 5 };
        expect(precheckoutBliteV1Schema.safeParse(dtoFraction).success).toBe(false);
    });

    it('rejects a persona.headline over 80 chars', () => {
        const dto = validDto();
        dto.persona.headline = '가'.repeat(81);
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a persona.summary over 400 chars', () => {
        const dto = validDto();
        dto.persona.summary = '가'.repeat(401);
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a signal claim over 120 chars', () => {
        const dto = validDto();
        dto.signals[0] = signal({ claim: '가'.repeat(121), confidence: 0.9, band: 'high' });
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a signal category over 24 chars', () => {
        const dto = validDto();
        dto.signals[0] = signal({ category: '가'.repeat(25), confidence: 0.9, band: 'high' });
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a genderRead reason over 90 chars', () => {
        const dto = validDto();
        dto.genderRead.reasons[0] = '가'.repeat(91);
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects text without Korean characters', () => {
        const dto = validDto();
        dto.persona.headline = 'English only headline text here';
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects text containing a URL or @ mention', () => {
        const dtoUrl = validDto();
        dtoUrl.persona.summary = '자세히는 https://example.com 에서 확인하세요 한글포함';
        expect(precheckoutBliteV1Schema.safeParse(dtoUrl).success).toBe(false);

        const dtoMention = validDto();
        dtoMention.persona.summary = '@someone 을 자주 태그해요 한글포함 텍스트입니다 그렇습니다';
        expect(precheckoutBliteV1Schema.safeParse(dtoMention).success).toBe(false);
    });

    it('rejects an evidenceFields entry outside the allowlist', () => {
        const dto = validDto();
        dto.evidenceFields = ['post.caption', 'profile.followersCount'];
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects duplicate evidenceFields entries', () => {
        const dto = validDto();
        dto.evidenceFields = ['post.caption', 'post.caption'];
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects unknown top-level keys (strict)', () => {
        const dto: Record<string, unknown> = validDto();
        dto.username = 'someone';
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('rejects a wrong schemaVersion', () => {
        const dto = validDto();
        // @ts-expect-error deliberately wrong literal for the test
        dto.schemaVersion = 2;
        expect(precheckoutBliteV1Schema.safeParse(dto).success).toBe(false);
    });

    it('does not expose any evidence field outside the documented allowlist', () => {
        for (const field of PRECHECKOUT_BLITE_EVIDENCE_FIELDS) {
            expect(field.startsWith('post.') || field.startsWith('profile.')).toBe(true);
            expect(field.includes('follow')).toBe(false);
            expect(field.includes('username')).toBe(false);
            expect(field).not.toBe('profile.externalUrl');
        }
    });

    it('includes the widened gender-read-only evidence fields (name, bio, images)', () => {
        expect(PRECHECKOUT_BLITE_EVIDENCE_FIELDS).toContain('profile.fullName');
        expect(PRECHECKOUT_BLITE_EVIDENCE_FIELDS).toContain('profile.bio');
        expect(PRECHECKOUT_BLITE_EVIDENCE_FIELDS).toContain('profile.profilePicUrl');
        expect(PRECHECKOUT_BLITE_EVIDENCE_FIELDS).toContain('post.imageUrl');
    });
});

describe('derivePrecheckoutBliteSignalBand', () => {
    it('maps confidence to band using the documented thresholds', () => {
        expect(derivePrecheckoutBliteSignalBand(1)).toBe('high');
        expect(derivePrecheckoutBliteSignalBand(0.7)).toBe('high');
        expect(derivePrecheckoutBliteSignalBand(0.69)).toBe('medium');
        expect(derivePrecheckoutBliteSignalBand(0.5)).toBe('medium');
        expect(derivePrecheckoutBliteSignalBand(0.49)).toBe('low');
        expect(derivePrecheckoutBliteSignalBand(0)).toBe('low');
    });
});
