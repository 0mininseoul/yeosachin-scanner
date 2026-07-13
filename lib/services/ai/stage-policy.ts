export const AI_STAGE_NAMES = [
    'genderTriage',
    'featureAnalysis',
    'partnerSafety',
    'highRiskNarrative',
    'privateAccountName',
] as const;

export type AiStageName = typeof AI_STAGE_NAMES[number];
export type AiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
export type AiMediaResolution = 'LOW' | 'MEDIUM' | 'HIGH';

export interface AiStagePolicy {
    model: 'gemini-3.1-flash-lite' | 'gemini-3-flash-preview';
    thinkingLevel: AiThinkingLevel;
    mediaResolution: AiMediaResolution;
    profileImageLimit: 0 | 1;
    feedImageLimit: number;
    maxOutputTokens: number;
    concurrency: number;
    promptVersion: string;
    schemaVersion: number;
}

export const AI_STAGE_POLICY_VERSION = 'ai-stage-policy-v2.2';
/**
 * This limit is enforced only inside one server process. Deployment-wide Vertex AI quota and
 * admission control remain an external pre-open gate for the V2 worker fleet.
 */
export const AI_CONCURRENCY_ENFORCEMENT_SCOPE = 'process' as const;
export const AI_SHARED_CONCURRENCY_LIMIT = 10;

export const AI_STAGE_POLICIES = Object.freeze({
    genderTriage: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        profileImageLimit: 1,
        feedImageLimit: 4,
        maxOutputTokens: 512,
        concurrency: 10,
        promptVersion: 'gender-triage-v1',
        schemaVersion: 1,
    }),
    featureAnalysis: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MEDIUM',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 10,
        maxOutputTokens: 2_048,
        concurrency: 8,
        promptVersion: 'feature-analysis-v1',
        schemaVersion: 1,
    }),
    partnerSafety: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MEDIUM',
        mediaResolution: 'LOW',
        profileImageLimit: 0,
        feedImageLimit: 1,
        maxOutputTokens: 768,
        concurrency: 5,
        promptVersion: 'partner-safety-v1',
        schemaVersion: 1,
    }),
    highRiskNarrative: Object.freeze({
        model: 'gemini-3-flash-preview',
        thinkingLevel: 'HIGH',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 10,
        maxOutputTokens: 4_096,
        concurrency: 3,
        promptVersion: 'high-risk-narrative-v1',
        schemaVersion: 1,
    }),
    privateAccountName: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        profileImageLimit: 0,
        feedImageLimit: 0,
        // One response can contain 100 ordered JSON rows and needs headroom above small defaults.
        maxOutputTokens: 8_192,
        concurrency: 4,
        promptVersion: 'private-account-name-v1',
        schemaVersion: 1,
    }),
} satisfies Record<AiStageName, Readonly<AiStagePolicy>>);

export function getAiStagePolicy(stage: AiStageName): Readonly<AiStagePolicy> {
    return AI_STAGE_POLICIES[stage];
}

export function isAiStageName(value: unknown): value is AiStageName {
    return typeof value === 'string' && AI_STAGE_NAMES.includes(value as AiStageName);
}
