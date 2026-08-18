import { INSTAGRAM_MEDIA_HOST_SUFFIXES } from '@/lib/services/media/secure-image-fetch';
import {
    isSafePublicRiskNarrativeLine,
    parseSafePublicRiskNarrative,
    sanitizePublicRiskNarrativeLine,
} from './narrative-privacy';

export interface ResultInteractionSummary {
    riskAnalysis: string[];
}

export interface OwnerResultInteractionSummary extends ResultInteractionSummary {
    oneLineOverview?: string;
}

const MAX_IMAGE_URL_LENGTH = 8_192;
const MAX_TARGET_FULL_NAME_LENGTH = 200;

export function toSafeRiskAnalysis(value: unknown): string[] {
    return parseSafePublicRiskNarrative(value) ?? [];
}

function matchesAllowedImageHost(hostname: string): boolean {
    return INSTAGRAM_MEDIA_HOST_SUFFIXES.some(suffix => (
        hostname === suffix || hostname.endsWith(`.${suffix}`)
    ));
}

export function targetProfileImageFromStepData(stepData: unknown): string | undefined {
    if (!stepData || typeof stepData !== 'object' || Array.isArray(stepData)) return undefined;

    const value = (stepData as Record<string, unknown>).targetProfileImage;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IMAGE_URL_LENGTH) {
        return undefined;
    }

    try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        if (
            parsed.protocol !== 'https:'
            || parsed.username
            || parsed.password
            || (parsed.port && parsed.port !== '443')
            || !matchesAllowedImageHost(hostname)
        ) {
            return undefined;
        }

        parsed.hostname = hostname;
        parsed.hash = '';
        return parsed.href;
    } catch {
        return undefined;
    }
}

export function targetProfileFullNameFromStepData(stepData: unknown): string | undefined {
    if (!stepData || typeof stepData !== 'object' || Array.isArray(stepData)) return undefined;

    const root = stepData as Record<string, unknown>;
    const publication = root.conciergeBatchPublication;
    const publicationRecord = publication && typeof publication === 'object' && !Array.isArray(publication)
        ? publication as Record<string, unknown>
        : null;
    for (const value of [publicationRecord?.targetFullName, root.targetFullName]) {
        if (typeof value !== 'string') continue;
        const name = value.trim().replace(/\s+/gu, ' ');
        if (name.length === 0 || name.length > MAX_TARGET_FULL_NAME_LENGTH
            || /[\u0000-\u001f\u007f]/u.test(name)) continue;
        return name;
    }
    return undefined;
}

export function toResultInteractionSummary(
    row: Record<string, unknown>
): ResultInteractionSummary {
    return {
        riskAnalysis: row.risk_grade === 'high_risk'
            ? toSafeRiskAnalysis(row.risk_analysis)
            : [],
    };
}

/**
 * Legacy owner results now carry an additive bounded overview column. Keep it
 * out of the shared adapter so legacy share payloads retain their historical
 * high-risk narrative contract.
 */
export function toOwnerResultInteractionSummary(
    row: Record<string, unknown>
): OwnerResultInteractionSummary {
    if (
        row.risk_grade !== 'normal'
        && row.risk_grade !== 'caution'
        && row.risk_grade !== 'high_risk'
    ) {
        return { riskAnalysis: [] };
    }
    const riskAnalysis = row.risk_grade === 'high_risk'
        ? toSafeRiskAnalysis(row.risk_analysis)
        : [];
    const overview = sanitizePublicRiskNarrativeLine(row.one_line_overview);
    if (!overview || !isSafePublicRiskNarrativeLine(overview)) {
        // The additive overview is optional for historical rows. Never let a
        // missing or malformed overview erase a complete legacy high-risk
        // narrative that already satisfies the public contract.
        return { riskAnalysis };
    }
    return { oneLineOverview: overview, riskAnalysis };
}
