import { isInstagramUsername } from '@/lib/services/instagram/username';

interface ResultPageTargetSummary {
    targetFullName?: string | null;
    targetInstagramId?: string | null;
}

export interface ResultPageHeader {
    displayName: string;
    username: string | null;
    instagramUrl: string | null;
}

function normalizedTargetUsername(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^@+/, '').toLowerCase();
    if (
        !isInstagramUsername(normalized)
        || normalized.startsWith('.')
        || normalized.endsWith('.')
        || normalized.includes('..')
    ) {
        return null;
    }
    return normalized;
}

/**
 * Projects the stored target summary for the owner-only report header. Result
 * rows intentionally do not participate, so a candidate can never become the
 * subject of the report or the target of its Instagram link.
 */
export function resultPageHeader(summary: ResultPageTargetSummary): ResultPageHeader {
    const username = normalizedTargetUsername(summary.targetInstagramId);
    const displayName = summary.targetFullName?.trim() || username || '분석 대상';

    return {
        displayName,
        username,
        instagramUrl: username ? `https://www.instagram.com/${username}/` : null,
    };
}
