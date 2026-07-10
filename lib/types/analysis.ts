// 분석 관련 타입 정의

import type { AnalysisResult } from './database';

// AI 성별 판단 응답
export interface GenderAnalysisResponse {
    gender: 'male' | 'female' | 'unknown';
    confidence: number;
    reasoning: string;
}

// AI Photogenic Quality 분석 응답
export interface PhotogenicAnalysisResponse {
    ownerIdentified: boolean;
    photogenicGrade: 1 | 2 | 3 | 4 | 5;
    confidence: number;
    reasoning: string;
    // 커플 사진 감지 (남자친구 있는 계정 필터링용)
    hasCouplePhoto?: boolean;
    couplePhotoConfidence?: number;
}

// AI 노출 정도 분석 응답
export interface ExposureAnalysisResponse {
    ownerIdentified: boolean;
    skinVisibility: 'high' | 'low';
    confidence: number;
    reasoning: string;
}

// AI 댓글 친밀도 분석 응답
export interface IntimacyAnalysisResponse {
    intimacyLevel: 'intimate' | 'normal';
    confidence: number;
    indicators: string[];
    reasoning: string;
}

// AI 통합 분석 응답 (성별 + 여성인 경우 외모/노출/기혼/해외 여부)
export interface CombinedAnalysisResponse {
    // 성별 분석 (항상 포함)
    gender: 'male' | 'female' | 'unknown';
    genderConfidence: number;
    genderReasoning: string;

    // 외모/노출 분석 (여성인 경우에만 포함)
    photogenicGrade?: 1 | 2 | 3 | 4 | 5;
    photogenicConfidence?: number;
    skinVisibility?: 'high' | 'low';
    exposureConfidence?: number;
    ownerIdentified?: boolean;

    // 기혼 여부 (여성인 경우에만 포함)
    isMarried?: boolean;
    marriedConfidence?: number;

    // 해외 계정 여부 (여성인 경우에만 포함)
    isForeigner?: boolean;
    foreignerConfidence?: number;

    featureReasoning?: string;
}

// 분석된 계정 데이터
export interface AnalyzedAccount {
    username: string;
    fullName?: string;
    profilePicUrl?: string;
    bio?: string;
    isPrivate: boolean;

    // 성별 분석
    gender: 'male' | 'female' | 'unknown';
    genderConfidence: number;
    genderStatus: 'confirmed' | 'suspected' | 'unknown';

    // Photogenic 분석
    photogenicGrade: number;

    // 노출 분석
    exposureLevel: 'high' | 'low';

    // 태그 여부
    isTagged: boolean;

    // 점수
    totalScore: number;
    interactionScore?: number;
    interactionCoverage?: number;
    interactionCoverageStatus?: 'high' | 'medium' | 'low';
    femaleToTargetLikesCount?: number;
    femaleToTargetCommentsCount?: number;
    targetToFemaleLikesCount?: number;
    recencyBonus?: number;
    riskAnalysis?: [string, string] | string[];

    // 위험순위
    riskGrade?: 'high_risk' | 'caution' | 'normal';
    rank?: number;
}

// 분석 요약 (프론트엔드용)
export interface AnalysisSummary {
    targetInstagramId: string;
    targetProfileImage?: string;
    mutualFollows: number;
    genderRatio: {
        male: { count: number; percentage: number };
        female: { count: number; percentage: number };
        unknown: { count: number; percentage: number };
    };
}

// 결과 페이지용 여성 계정 데이터
export interface FemaleAccountResult {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl: string;
    riskGrade: 'high_risk' | 'caution' | 'normal';
    bio?: string;
    recentMutualRank?: 1 | 2 | 3 | 4 | 5;
    riskAnalysis: string[];
}

// 결과 페이지용 비공개 계정 데이터
export interface PrivateAccountResult {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl: string;
}

// 결과 리포트 (프론트엔드용) - 새 버전
export interface AnalysisReportV2 {
    requestId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    summary: AnalysisSummary;
    femaleAccounts: FemaleAccountResult[];
    privateAccounts: PrivateAccountResult[];
}

// 분석 진행 상태
export interface AnalysisProgress {
    requestId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    backgroundProcessing: boolean;
    createdAt: string;
    completedAt: string | null;
    estimatedCompletionTime: string | null;
}

// 기존 호환성 유지 (deprecated)
export interface AppearanceAnalysisResponse {
    ownerIdentified: boolean;
    attractivenessLevel: 'high' | 'medium' | 'low';
    confidence: number;
    reasoning: string;
}

export interface ScoreCalculationInput {
    likesCount: number;
    normalCommentsCount: number;
    intimateCommentsCount: number;
    repliesCount: number;
    postTagsCount: number;
    captionMentionsCount: number;
    attractivenessLevel: 'high' | 'medium' | 'low' | null;
    durationMonths: number;
    isRecentSurge: boolean;
}

export interface ScoreCalculationResult {
    baseScore: number;
    weightedScore: number;
    finalScore: number;
    breakdown: {
        likes: number;
        normalComments: number;
        intimateComments: number;
        replies: number;
        postTags: number;
        captionMentions: number;
        attractiveness: number;
        durationMultiplier: number;
        surgeMultiplier: number;
    };
}

export interface AnalysisReport {
    requestId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    summary: {
        targetInstagramId: string;
        totalFollowers: number;
        mutualFollows: number;
        oppositeGenderCount: number;
        privateAccountsCount: number;
        confidenceScore: number;
    };
    topResult: AnalysisResult | null;
    lockedResults: {
        rank: number;
        riskScore: number;
        isUnlocked: boolean;
        unlockPrice: number;
    }[];
    privateAccounts: {
        instagramId: string;
        profileImage?: string;
    }[];
}
