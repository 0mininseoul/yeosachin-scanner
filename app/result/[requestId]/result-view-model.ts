import type { AnalysisResultPageV1 } from '@/lib/contracts/analysis-v2';
import {
    boundedOwnerResultPage,
    genderBreakdownFromStats,
    countHighRiskBands,
} from '@/lib/services/analysis/owner-view-presentation';

export interface GenderRatio {
    male: { count: number; percentage: number };
    female: { count: number; percentage: number };
    unknown: { count: number; percentage: number };
}

export interface FemaleAccount {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl?: string;
    riskGrade: 'high_risk' | 'caution' | 'normal';
    bio: string;
    recentMutualRank?: 1 | 2 | 3 | 4 | 5;
    riskAnalysis: string[];
    oneLineOverview?: string;
    displayScore?: number;
}

export interface PrivateAccount {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl?: string;
    bio?: string;
}

export interface ResultData {
    requestId: string;
    status: string;
    pipelineVersion: 'v1' | 'v2';
    summary: {
        targetInstagramId: string;
        targetFullName?: string;
        targetProfileImage?: string;
        mutualFollows: number;
        analyzedMutuals: number;
        genderRatio: GenderRatio | null;
        v2?: {
            followers: AnalysisResultPageV1['summary']['followers'];
            following: AnalysisResultPageV1['summary']['following'];
            publicMutuals: number;
            privateMutuals: number;
            screenedMutuals: number;
            highRiskCount: number;
        };
    };
    femaleAccounts: FemaleAccount[];
    privateAccounts: PrivateAccount[];
    femaleNextCursor?: string | null;
    privateNextCursor?: string | null;
}

export function mapV2Result(result: AnalysisResultPageV1, externalProfileLinks = true): ResultData {
    // genderStats is an additive summary field; tolerate results produced before
    // the backend contract ships it and fall back to hiding the gender breakdown.
    const genderStats = (result.summary as {
        genderStats?: { male: number; female: number; unknown: number };
    }).genderStats;
    // targetFullName is likewise additive: the headline falls back to the handle
    // until the backend contract carries the Instagram display name.
    const targetFullName = (result.summary as { targetFullName?: string | null }).targetFullName;
    return {
        requestId: result.requestId,
        status: 'completed',
        pipelineVersion: 'v2',
        summary: {
            targetInstagramId: result.summary.targetInstagramId,
            targetFullName: targetFullName || undefined,
            targetProfileImage: result.summary.targetProfileImage || undefined,
            mutualFollows: result.summary.detectedMutuals,
            analyzedMutuals: result.summary.detectedMutuals,
            genderRatio: genderStats ? genderBreakdownFromStats(genderStats) : null,
            v2: {
                followers: result.summary.followers,
                following: result.summary.following,
                publicMutuals: result.summary.publicMutuals,
                privateMutuals: result.summary.privateMutuals,
                screenedMutuals: result.summary.screenedMutuals,
                highRiskCount: countHighRiskBands(result.femaleAccounts),
            },
        },
        femaleAccounts: boundedOwnerResultPage(result.femaleAccounts).map(account => ({
            instagramId: account.instagramId,
            fullName: account.fullName || undefined,
            profileImage: account.profileImage || undefined,
            instagramUrl: externalProfileLinks ? `https://instagram.com/${account.instagramId}` : undefined,
            riskGrade: account.riskBand,
            bio: account.bio || '',
            recentMutualRank: account.recentMutualRank !== null && account.recentMutualRank <= 5
                ? account.recentMutualRank as 1 | 2 | 3 | 4 | 5
                : undefined,
            riskAnalysis: account.highRiskNarrative ? [...account.highRiskNarrative] : [],
            oneLineOverview: account.oneLineOverview,
            displayScore: account.displayScore,
        })),
        privateAccounts: boundedOwnerResultPage(result.privateAccounts).map(account => ({
            instagramId: account.instagramId,
            fullName: account.fullName || undefined,
            profileImage: account.profileImage || undefined,
            instagramUrl: externalProfileLinks ? `https://instagram.com/${account.instagramId}` : undefined,
        })),
        femaleNextCursor: result.femaleNextCursor,
        privateNextCursor: result.privateNextCursor,
    };
}
