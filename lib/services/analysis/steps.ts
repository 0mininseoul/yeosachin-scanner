// 분석 단계 정의 및 유틸리티

import type { ScraperProviderSelection } from '@/lib/services/instagram/providers/types';
import { INSTAGRAM_USERNAME_PATTERN } from '@/lib/services/instagram/username';
import type { RelationshipCheckpoint } from './relationship-checkpoint';

export type AnalysisStep =
    | 'pending'
    | 'collect'      // 프로필 + 팔로워/팔로잉 수집 + 맞팔 추출
    | 'profiles'     // 공개 계정 프로필 배치 수집
    | 'analyze'      // 통합 분석 (성별 + 여성인 경우 외모/노출)
    | 'interactions' // 대상 계정과 관측된 여성 계정 상호작용 수집
    | 'deep_analysis' // 고위험군 후보의 다면 근거 분석
    | 'finalize'     // 점수 계산 + 결과 저장
    | 'completed'
    | 'failed'
    // 하위 호환성을 위한 레거시 단계 (새 요청에서는 사용 안 함)
    | 'gender'
    | 'features';

// 단계별 진행률 범위
export const STEP_PROGRESS: Record<AnalysisStep, { min: number; max: number; label: string }> = {
    pending: { min: 0, max: 0, label: '분석 대기 중...' },
    collect: { min: 5, max: 30, label: '팔로워/팔로잉 수집 중...' },
    profiles: { min: 30, max: 50, label: '공개 계정 프로필 수집 중...' },
    analyze: { min: 50, max: 82, label: 'AI 분석 중...' },
    interactions: { min: 82, max: 92, label: '상호작용 분석 중...' },
    deep_analysis: { min: 92, max: 97, label: '위험 계정 심층 분석 중...' },
    finalize: { min: 97, max: 100, label: '결과 저장 중...' },
    completed: { min: 100, max: 100, label: '분석 완료!' },
    failed: { min: 0, max: 0, label: '분석 실패' },
    // 레거시 단계 (하위 호환성)
    gender: { min: 50, max: 70, label: '성별 분석 중...' },
    features: { min: 70, max: 90, label: '계정 분석 중...' },
};

// 다음 단계 결정
export function getNextStep(currentStep: AnalysisStep): AnalysisStep {
    const order: AnalysisStep[] = [
        'pending',
        'collect',
        'profiles',
        'analyze',
        'interactions',
        'deep_analysis',
        'finalize',
        'completed',
    ];
    const currentIndex = order.indexOf(currentStep);
    if (currentIndex === -1 || currentIndex >= order.length - 1) {
        return 'completed';
    }
    return order[currentIndex + 1];
}

// 배치 처리용 인덱스 계산
export const BATCH_SIZE = 50; // 각 배치당 처리할 계정 수

export function calculateBatchProgress(
    step: AnalysisStep,
    batchIndex: number,
    totalBatches: number
): number {
    const stepProgress = STEP_PROGRESS[step];
    const range = stepProgress.max - stepProgress.min;
    const batchProgress = totalBatches > 0 ? (batchIndex / totalBatches) * range : 0;
    return Math.round(stepProgress.min + batchProgress);
}

// step_data 타입 정의
export interface StepData {
    scraperOptions?: ScraperProviderSelection;
    geminiGenerationIntent?: {
        kind: 'private_names' | 'combined' | 'deep_risk';
        operationKey: string;
        inputIds: string[];
        createdAt: string;
    };

    // collect 단계 결과
    mutualFollows?: string[];
    targetProfileImage?: string;
    // Durable collect checkpoint. It lets a retry reuse a paid profile Actor result
    // after the run checkpoint has been cleared.
    targetProfileCheckpoint?: {
        profilePicUrl?: string;
        followersCount: number;
        followingCount: number;
        isPrivate: boolean;
        targetPosts: NonNullable<StepData['targetPosts']>;
    };
    relationshipCheckpoint?: RelationshipCheckpoint;
    privateNameResults?: Array<{
        id: string;
        femaleScore: number;
        isName: boolean;
        confidence: number;
    }>;
    publicAccounts?: Array<{
        username: string;
        profilePicUrl?: string;
        isPrivate: boolean;
    }>;
    targetPosts?: Array<{
        id: string;
        shortCode: string;
        type: 'image' | 'video' | 'carousel' | 'reel';
        likesCount: number;
        commentsCount: number;
        timestamp: string;
    }>;

    // profiles 단계 결과
    profileProviderBatchCheckpoint?: {
        batchIndex: number;
        usernames: string[];
    };
    accountsWithPosts?: Array<{
        profileSource?: 'cache' | 'provider';
        profile: {
            username: string;
            profilePicUrl?: string;
            fullName?: string;
            bio?: string;
            isPrivate: boolean;
        };
        recentPosts: Array<{
            id: string;
            shortCode: string;
            caption?: string;
            hashtags?: string[];
            imageUrl?: string;
            type: 'image' | 'video' | 'carousel' | 'reel';
            likesCount: number;
            commentsCount: number;
            timestamp: string;
            taggedUsers?: string[];
            mentionedUsers?: string[];
        }>;
    }>;

    // interactions 단계 진행 상태. 원본 liker/commenter 목록은 step_data에 저장하지 않는다.
    interactionStage?: 'target' | 'candidates' | 'scoring' | 'complete';
    interactionCandidateUsernames?: string[];
    interactionCandidateBatchIndex?: number;
    deepAnalysisStage?: 'pending' | 'complete';
    profileBatchIndex?: number;

    // analyze 단계 결과 (통합 분석)
    analyzeBatchIndex?: number;
    combinedResults?: Record<string, {
        gender: 'male' | 'female' | 'unknown';
        genderConfidence: number;
        // 여성인 경우에만 포함
        photogenicGrade?: number;
        photogenicConfidence?: number;
        skinVisibility?: 'high' | 'low';
        exposureConfidence?: number;
        ownerIdentified?: boolean;
        isMarried?: boolean;
        marriedConfidence?: number;
        isForeigner?: boolean;
        foreignerConfidence?: number;
    }>;

    // 레거시 필드 (하위 호환성)
    genderResults?: Record<string, {
        gender: 'male' | 'female' | 'unknown';
        confidence: number;
        reasoning?: string;
    }>;
    femaleAccounts?: Array<{
        profile: {
            username: string;
            profilePicUrl?: string;
            fullName?: string;
            bio?: string;
            isPrivate: boolean;
        };
        recentPosts: Array<{
            imageUrl?: string;
            taggedUsers?: string[];
            mentionedUsers?: string[];
        }>;
    }>;
    genderBatchIndex?: number;
    photogenicResults?: Record<string, {
        photogenicGrade: number;
        confidence: number;
    }>;
    exposureResults?: Record<string, {
        skinVisibility: 'high' | 'low';
        confidence: number;
    }>;
    featureBatchIndex?: number;
}

export function resolveProfileProviderBatchUsernames(
    checkpoint: StepData['profileProviderBatchCheckpoint'],
    expectedBatchIndex: number,
    batchUsernames: readonly string[],
    currentCacheMissUsernames: readonly string[]
): string[] {
    if (!checkpoint) return [...currentCacheMissUsernames];
    const normalizedBatch = new Set(
        batchUsernames.map(username => username.trim().toLowerCase())
    );
    const normalizedCheckpoint = checkpoint.usernames.map(
        username => username.trim().toLowerCase()
    );
    if (
        checkpoint.batchIndex !== expectedBatchIndex
        || checkpoint.usernames.length === 0
        || checkpoint.usernames.length > PROFILE_BATCH_SIZE
        || new Set(normalizedCheckpoint).size !== checkpoint.usernames.length
        || normalizedCheckpoint.some(username => !normalizedBatch.has(username))
    ) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: frozen profile batch input is invalid.');
    }
    return [...checkpoint.usernames];
}

export function compactCompletedStepData(stepData: StepData): StepData {
    const mutualFollows: string[] = [];
    const seen = new Set<string>();
    for (const value of stepData.mutualFollows ?? []) {
        if (typeof value !== 'string') continue;
        const username = value.trim().toLowerCase();
        if (!INSTAGRAM_USERNAME_PATTERN.test(username) || seen.has(username)) continue;
        seen.add(username);
        mutualFollows.push(username);
        if (mutualFollows.length === 10) break;
    }
    return {
        ...(mutualFollows.length > 0 ? { mutualFollows } : {}),
        ...(typeof stepData.targetProfileImage === 'string' && stepData.targetProfileImage
            ? { targetProfileImage: stepData.targetProfileImage }
            : {}),
    };
}

// profiles 단계 배치 크기 (더 작게 설정하여 타임아웃 방지)
export const PROFILE_BATCH_SIZE = 30;
