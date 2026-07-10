// 점수 계산 상수

// 성별 판단 신뢰도 임계값
export const GENDER_CONFIDENCE = {
    CONFIRMED: 0.80,  // ≥ 0.80 → 확정 여성
    SUSPECTED: 0.60,  // 0.60 ~ 0.80 → 의심 여성
} as const;

// Photogenic Quality 점수 (Grade 1~5)
export const PHOTOGENIC_SCORES = [20, 40, 60, 80, 100] as const;

// 노출 점수
export const EXPOSURE_SCORES = {
    HIGH: 40,
    LOW: 0,
} as const;

// 태그 점수
export const TAG_SCORE = 30;

// 특징 점수 상한
export const BASE_FEATURE_SCORE_MAX = 170; // Photogenic 100 + Exposure 40 + Tag 30
export const RECENT_MUTUAL_BONUS_MAX = 20;
export const MAX_SCORE = BASE_FEATURE_SCORE_MAX + RECENT_MUTUAL_BONUS_MAX;

/**
 * Photogenic Grade에 따른 점수 반환
 */
export function getPhotogenicScore(grade: number): number {
    if (grade < 1 || grade > 5) {
        return PHOTOGENIC_SCORES[0]; // Grade 1 (20점)
    }
    return PHOTOGENIC_SCORES[grade - 1];
}

/**
 * 노출 레벨에 따른 점수 반환
 */
export function getExposureScore(level: 'high' | 'low'): number {
    return level === 'high' ? EXPOSURE_SCORES.HIGH : EXPOSURE_SCORES.LOW;
}

/**
 * 성별 신뢰도에 따른 상태 분류
 */
export function classifyGenderStatus(
    gender: 'male' | 'female' | 'unknown',
    confidence: number
): { status: 'confirmed' | 'suspected' | 'unknown'; include: boolean } {
    if (gender !== 'female') {
        return { status: 'unknown', include: false };
    }

    if (confidence >= GENDER_CONFIDENCE.CONFIRMED) {
        return { status: 'confirmed', include: true };
    }

    if (confidence >= GENDER_CONFIDENCE.SUSPECTED) {
        return { status: 'suspected', include: true };
    }

    return { status: 'unknown', include: false };
}

/**
 * 고위험군 인원수 산출
 * - 30명 이하: 1명
 * - 31~70명: 2명
 * - 71명 이상: 3명
 */
export function getHighRiskCount(totalCount: number): number {
    if (totalCount <= 30) return 1;
    if (totalCount <= 70) return 2;
    return 3;
}

/**
 * 위험순위 분류
 */
export function classifyRiskGrade(
    rank: number,
    totalCount: number
): 'high_risk' | 'caution' | 'normal' {
    const highRiskCount = getHighRiskCount(totalCount);

    if (rank <= highRiskCount) {
        return 'high_risk';
    }

    // 나머지 중 주의: 20%
    const remaining = totalCount - highRiskCount;
    const cautionCount = Math.ceil(remaining * 0.2);

    if (rank <= highRiskCount + cautionCount) {
        return 'caution';
    }

    return 'normal';
}

// 기존 코드 호환성을 위해 유지 (deprecated)
export const GENDER_CONFIDENCE_THRESHOLD = 0.6;

export const INTERACTION_SCORES = {
    LIKE: 1,
    NORMAL_COMMENT: 3,
    INTIMATE_COMMENT: 10,
    REPLY: 5,
    POST_TAG: 3,
    CAPTION_MENTION: 5,
} as const;

export const ATTRACTIVENESS_SCORES = {
    HIGH: 70,
    MEDIUM: 10,
    LOW: 0,
} as const;

export const DURATION_WEIGHTS = {
    LESS_THAN_6_MONTHS: 1.0,
    SIX_TO_12_MONTHS: 1.3,
    MORE_THAN_12_MONTHS: 1.5,
} as const;

export const SURGE_BONUS = 1.5;
export const SURGE_THRESHOLD = 2;

export function getDurationWeight(months: number): number {
    if (months >= 12) return DURATION_WEIGHTS.MORE_THAN_12_MONTHS;
    if (months >= 6) return DURATION_WEIGHTS.SIX_TO_12_MONTHS;
    return DURATION_WEIGHTS.LESS_THAN_6_MONTHS;
}

export function getAttractivenessScore(level: 'high' | 'medium' | 'low' | null): number {
    switch (level) {
        case 'high': return ATTRACTIVENESS_SCORES.HIGH;
        case 'medium': return ATTRACTIVENESS_SCORES.MEDIUM;
        default: return ATTRACTIVENESS_SCORES.LOW;
    }
}
