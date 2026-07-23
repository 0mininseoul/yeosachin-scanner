import { PLAN_IDS, type PlanId } from '@/lib/domain/analysis/plan-catalog';

export type OwnerProgressStatus =
    | 'queued'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'upgrade_required';

export interface OwnerProgressPresentationInput {
    status: OwnerProgressStatus;
    tracks: Record<string, { state: string; stageCode: string }>;
    events: Array<{ copyCode: string }>;
    activeProfile: { maskedUsername: string } | null;
}

const V2_PROGRESS_COPY: Readonly<Record<string, string>> = {
    TARGET_PROFILE_READY: '대상 계정 프로필을 확인했습니다.',
    RELATIONSHIPS_COLLECTING: '팔로워와 팔로잉 목록을 수집하고 있습니다.',
    RELATIONSHIPS_COLLECTED: '맞팔 관계를 정리했습니다.',
    PUBLIC_PROFILES_COLLECTING: '공개 프로필을 확인하고 있습니다.',
    PROFILE_SCREENING: '맞팔 계정을 판독하고 있습니다.',
    PROFILES_SCREENED: '계정 특징 판독을 진행했습니다.',
    PRIVATE_NAMES_SCREENING: '비공개 계정의 이름 단서를 확인하고 있습니다.',
    EVIDENCE_JOINING: '수집한 단서를 서로 맞춰보고 있습니다.',
    TARGET_INTERACTIONS_COLLECTING: '대상 계정의 상호작용을 확인하고 있습니다.',
    SHORTLIST_INTERACTIONS_COLLECTING: '주요 후보와의 상호작용을 비교하고 있습니다.',
    PARTNER_CONTEXT_CHECKING: '연애 관계로 보이는 맥락을 확인하고 있습니다.',
    SHORTLIST_READY: '정밀 판독할 후보를 추렸습니다.',
    CANDIDATES_RANKING: '위험도 순위를 계산하고 있습니다.',
    FINAL_SCORE_CALCULATING: '최종 위험도 점수를 계산하고 있습니다.',
    HIGH_RISK_CONFIRMED: '고위험 후보를 확인했습니다.',
    HIGH_RISK_NARRATIVES_WRITING: '고위험 후보의 총평을 정리하고 있습니다.',
    RESULT_FINALIZING: '최종 판독 결과를 정리하고 있습니다.',
    ANALYSIS_COMPLETED: '판독이 완료됐습니다.',
    POTENTIAL_HIGH_RISK_FOUND: '고위험 여성 후보 발견. AI가 단서를 더 맞춰보고 있어요.',
    FINDING_CORRECTED: '의심 신호 하나는 재판독으로 바로잡았어요.',
    FINDING_CONFIRMED: '의심 신호가 교차 확인됐어요. 증거는 계속 합산 중입니다.',
    RELATIONSHIP_AI_QUEUED: '관계 분석을 준비하고 있습니다.',
    RELATIONSHIP_AI_RUNNING: '맞팔 계정의 특징을 확인하고 있습니다.',
    RELATIONSHIP_AI_COMPLETE: '맞팔 계정 판독을 마쳤습니다.',
    INTERACTIONS_QUEUED: '상호작용 분석을 준비하고 있습니다.',
    INTERACTIONS_RUNNING: '좋아요와 댓글 단서를 확인하고 있습니다.',
    INTERACTIONS_COMPLETE: '상호작용 분석을 마쳤습니다.',
    FINALIZATION_QUEUED: '최종 정리를 준비하고 있습니다.',
    FINALIZATION_RUNNING: '최종 결과를 정리하고 있습니다.',
    FINALIZATION_COMPLETE: '최종 결과 정리를 마쳤습니다.',
};

export function analysisV2EventCopy(copyCode: string): string {
    return V2_PROGRESS_COPY[copyCode] ?? '새로운 판독 단서를 확인하고 있습니다.';
}

export function analysisV2ProgressCopy(input: OwnerProgressPresentationInput): string {
    if (input.status === 'completed') return V2_PROGRESS_COPY.ANALYSIS_COMPLETED;
    if (input.status === 'failed') return '판독 처리 중 오류가 발생했습니다.';
    if (input.status === 'upgrade_required') {
        return '현재 계정 규모에 맞는 플랜을 다시 확인해주세요.';
    }
    const activeStageCode = Object.values(input.tracks)
        .find(track => track.state === 'running')?.stageCode;
    const activeStageCopy = activeStageCode
        ? V2_PROGRESS_COPY[activeStageCode]
        : null;
    if (input.activeProfile) {
        return `@${input.activeProfile.maskedUsername} · ${
            activeStageCopy || '프로필을 확인하고 있습니다.'
        }`;
    }
    if (activeStageCode) {
        return activeStageCopy || '서버에서 판독을 진행하고 있습니다.';
    }

    const latestCopyCode = input.events.at(-1)?.copyCode;
    return (latestCopyCode && analysisV2EventCopy(latestCopyCode))
        || '서버에서 판독을 진행하고 있습니다.';
}

export function paginatedCountLabel(loadedCount: number, hasNextPage: boolean): string {
    if (!Number.isSafeInteger(loadedCount) || loadedCount < 0) return '0';
    return `${loadedCount}${hasNextPage ? '+' : ''}`;
}

export const OWNER_RESULT_PAGE_SIZE = 50;

export function boundedOwnerResultPage<T>(items: readonly T[]): T[] {
    return items.slice(0, OWNER_RESULT_PAGE_SIZE);
}

export function paginatedRangeLabel(
    pageIndex: number,
    visibleCount: number,
    hasNextPage: boolean
): string {
    if (
        !Number.isSafeInteger(pageIndex)
        || pageIndex < 0
        || !Number.isSafeInteger(visibleCount)
        || visibleCount <= 0
        || visibleCount > OWNER_RESULT_PAGE_SIZE
    ) {
        return '0';
    }
    const first = pageIndex * OWNER_RESULT_PAGE_SIZE + 1;
    const last = first + visibleCount - 1;
    return `${first}-${last}${hasNextPage ? '+' : ''}`;
}

type OwnerRiskGrade = 'high_risk' | 'caution' | 'normal';

// The threat meter renders as a fixed 10-segment gauge so that one filled
// segment maps to one point of the rounded 1-10 risk score.
export const DEFAULT_THREAT_METER_SEGMENTS = 10;

const GRADE_FILL_RATIOS: Readonly<Record<OwnerRiskGrade, number>> = {
    high_risk: 9 / 10,
    caution: 6 / 10,
    normal: 3 / 10,
};

export function threatMeterFillCount(input: {
    grade: OwnerRiskGrade;
    displayScore?: number;
    segments: number;
}): number {
    if (!Number.isSafeInteger(input.segments) || input.segments < 1) return 0;
    const ratio = typeof input.displayScore === 'number' && Number.isFinite(input.displayScore)
        ? Math.min(10, Math.max(1, input.displayScore)) / 10
        : GRADE_FILL_RATIOS[input.grade];
    return Math.min(input.segments, Math.max(1, Math.round(ratio * input.segments)));
}

// Owner-facing risk scores are shown without decimals; the same rounded value
// drives the filled segment count so the gauge and the number never disagree.
export function roundedOwnerScore(displayScore: number): number {
    return Math.round(displayScore);
}

export interface GenderBreakdownSlice {
    count: number;
    percentage: number;
}

export interface GenderBreakdown {
    male: GenderBreakdownSlice;
    female: GenderBreakdownSlice;
    unknown: GenderBreakdownSlice;
}

// Converts raw male/female/unknown counts into display slices with integer
// percentages. A zero total is reported as 0% everywhere instead of dividing.
export function genderBreakdownFromStats(stats: {
    male: number;
    female: number;
    unknown: number;
}): GenderBreakdown {
    const total = stats.male + stats.female + stats.unknown;
    const slice = (count: number): GenderBreakdownSlice => ({
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    });
    return {
        male: slice(stats.male),
        female: slice(stats.female),
        unknown: slice(stats.unknown),
    };
}

export interface AnalysisPlanBadgePresentation {
    planId: PlanId;
    label: string;
    className: string;
}

const PLAN_BADGES = {
    basic: {
        planId: 'basic',
        label: 'BASIC',
        className: 'border-line-2 text-fg-mute',
    },
    standard: {
        planId: 'standard',
        label: 'STANDARD',
        className: 'border-blood/40 bg-blood/10 text-blood',
    },
    plus: {
        planId: 'plus',
        label: 'PLUS',
        className: 'border-amber/50 bg-amber/10 text-amber',
    },
} as const satisfies Readonly<Record<PlanId, AnalysisPlanBadgePresentation>>;

export function analysisPlanBadgePresentation(
    rawPlanId: string | null | undefined
): AnalysisPlanBadgePresentation {
    const planId = PLAN_IDS.find(candidate => candidate === rawPlanId) ?? 'basic';
    return PLAN_BADGES[planId];
}

export type V2ResultFailureAction = 'show_error' | 'show_progress';

export function v2ResultFailureAction(input: {
    resultStatus: number;
    progressStatus: OwnerProgressStatus | null;
}): V2ResultFailureAction {
    if (input.resultStatus !== 404) return 'show_error';
    return input.progressStatus !== null && input.progressStatus !== 'completed'
        ? 'show_progress'
        : 'show_error';
}
