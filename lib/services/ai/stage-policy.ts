export const AI_STAGE_NAMES = [
    'genderTriage',
    'featureAnalysis',
    'partnerSafety',
    'highRiskNarrative',
    'privateAccountName',
] as const;

export const AI_STAGE_NAMES_V27 = [
    ...AI_STAGE_NAMES,
    'genderResolution',
] as const;

export type LegacyAiStageName = typeof AI_STAGE_NAMES[number];
export type AiStageName = typeof AI_STAGE_NAMES_V27[number];
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

export const AI_STAGE_POLICY_VERSION = 'ai-stage-policy-v2.6';
export const AI_STAGE_POLICY_LATEST_VERSION = 'ai-stage-policy-v2.7';
export const SUPPORTED_AI_STAGE_POLICY_VERSIONS = Object.freeze([
    AI_STAGE_POLICY_VERSION,
    AI_STAGE_POLICY_LATEST_VERSION,
] as const);
export type AiStagePolicyVersion = typeof SUPPORTED_AI_STAGE_POLICY_VERSIONS[number];
export const AI_CONCURRENCY_ENFORCEMENT_SCOPE = 'deployment' as const;
export const AI_SHARED_CONCURRENCY_LIMIT = 8;
export const AI_GEMINI_LEASE_SECONDS = 240;
export const AI_GEMINI_MIN_REMAINING_MS = 225_000;
export const AI_GEMINI_SDK_TIMEOUT_MS = 210_000;

export const AI_STAGE_POLICIES = Object.freeze({
    genderTriage: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        profileImageLimit: 1,
        feedImageLimit: 4,
        maxOutputTokens: 512,
        concurrency: 8,
        promptVersion: 'gender-triage-v2',
        schemaVersion: 2,
    }),
    featureAnalysis: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MEDIUM',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 10,
        maxOutputTokens: 2_048,
        concurrency: 8,
        promptVersion: 'feature-analysis-v3',
        schemaVersion: 3,
    }),
    partnerSafety: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MEDIUM',
        mediaResolution: 'LOW',
        profileImageLimit: 0,
        feedImageLimit: 1,
        maxOutputTokens: 768,
        concurrency: 5,
        promptVersion: 'partner-safety-v2',
        schemaVersion: 2,
    }),
    highRiskNarrative: Object.freeze({
        model: 'gemini-3-flash-preview',
        thinkingLevel: 'HIGH',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 10,
        maxOutputTokens: 4_096,
        concurrency: 3,
        promptVersion: 'high-risk-narrative-v2',
        schemaVersion: 2,
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
} satisfies Record<LegacyAiStageName, Readonly<AiStagePolicy>>);

const AI_STAGE_POLICIES_V27 = Object.freeze({
    ...AI_STAGE_POLICIES,
    genderTriage: Object.freeze({
        ...AI_STAGE_POLICIES.genderTriage,
        concurrency: 4,
    }),
    featureAnalysis: Object.freeze({
        ...AI_STAGE_POLICIES.featureAnalysis,
        concurrency: 4,
    }),
    privateAccountName: Object.freeze({
        ...AI_STAGE_POLICIES.privateAccountName,
        concurrency: 2,
    }),
    genderResolution: Object.freeze({
        model: 'gemini-3-flash-preview',
        thinkingLevel: 'LOW',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 4,
        maxOutputTokens: 512,
        concurrency: 2,
        promptVersion: 'gender-resolution-v1',
        schemaVersion: 1,
    }),
} satisfies Record<AiStageName, Readonly<AiStagePolicy>>);

export const AI_STAGE_POLICY_REGISTRY = Object.freeze({
    [AI_STAGE_POLICY_VERSION]: AI_STAGE_POLICIES,
    [AI_STAGE_POLICY_LATEST_VERSION]: AI_STAGE_POLICIES_V27,
});

export function assertSupportedAiStagePolicyVersion(
    value: unknown,
): AiStagePolicyVersion {
    if (
        typeof value !== 'string'
        || !SUPPORTED_AI_STAGE_POLICY_VERSIONS.includes(value as AiStagePolicyVersion)
    ) {
        throw new Error(`Unsupported AI stage policy version: ${String(value)}`);
    }
    return value as AiStagePolicyVersion;
}

export function getAiStagePolicy(stage: LegacyAiStageName): Readonly<AiStagePolicy>;
export function getAiStagePolicy(
    version: AiStagePolicyVersion,
    stage: AiStageName,
): Readonly<AiStagePolicy>;
export function getAiStagePolicy(
    versionOrStage: AiStagePolicyVersion | LegacyAiStageName,
    requestedStage?: AiStageName,
): Readonly<AiStagePolicy> {
    const version = requestedStage === undefined
        ? AI_STAGE_POLICY_VERSION
        : assertSupportedAiStagePolicyVersion(versionOrStage);
    const stage = requestedStage ?? versionOrStage as LegacyAiStageName;
    const policy = AI_STAGE_POLICY_REGISTRY[version][stage as LegacyAiStageName];
    if (!policy) {
        throw new Error(`Unsupported AI stage "${stage}" for policy version "${version}"`);
    }
    return policy;
}

export function isAiStageName(value: unknown): value is AiStageName {
    return typeof value === 'string' && AI_STAGE_NAMES_V27.includes(value as AiStageName);
}

export type AiStagePolicyRolloutMode = 'off' | 'test_entitlement' | 'production';
export type AiStagePolicyAccessMode = 'test_entitlement' | 'production';

export function selectAiStagePolicyVersion({
    rolloutMode,
    accessMode,
}: {
    rolloutMode: string | undefined;
    accessMode: AiStagePolicyAccessMode;
}): AiStagePolicyVersion {
    if (rolloutMode === 'production') {
        return AI_STAGE_POLICY_LATEST_VERSION;
    }
    if (rolloutMode === 'test_entitlement' && accessMode === 'test_entitlement') {
        return AI_STAGE_POLICY_LATEST_VERSION;
    }
    return AI_STAGE_POLICY_VERSION;
}
