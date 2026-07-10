import { INSTAGRAM_MEDIA_HOST_SUFFIXES } from '@/lib/services/media/secure-image-fetch';
import { parseSafePublicRiskNarrative } from './narrative-privacy';

export interface ResultInteractionSummary {
    riskAnalysis: string[];
}

const MAX_IMAGE_URL_LENGTH = 8_192;

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

export function toResultInteractionSummary(
    row: Record<string, unknown>
): ResultInteractionSummary {
    return {
        riskAnalysis: row.risk_grade === 'high_risk'
            ? toSafeRiskAnalysis(row.risk_analysis)
            : [],
    };
}
