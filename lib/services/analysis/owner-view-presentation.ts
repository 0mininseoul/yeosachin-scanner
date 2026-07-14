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
    return (latestCopyCode && V2_PROGRESS_COPY[latestCopyCode])
        || '서버에서 판독을 진행하고 있습니다.';
}

export function paginatedCountLabel(loadedCount: number, hasNextPage: boolean): string {
    if (!Number.isSafeInteger(loadedCount) || loadedCount < 0) return '0';
    return `${loadedCount}${hasNextPage ? '+' : ''}`;
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
