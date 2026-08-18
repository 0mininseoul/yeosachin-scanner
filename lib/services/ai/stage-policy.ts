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
/**
 * v2.8 is intentionally not the implicit latest policy. New requests reach it only through the
 * separately gated tone rollout, so v2.7 remains the stable default for existing rollout paths.
 */
export const AI_STAGE_POLICY_V28_VERSION = 'ai-stage-policy-v2.8';
/**
 * v2.9 is an explicit launch-performance fence. It changed only how small,
 * independently-audited gender-triage requests are packed for Gemini; its
 * historical presentation bytes remain immutable even though v2.10 restores
 * the intended v2.8 public-copy inheritance for new requests.
 */
export const AI_STAGE_POLICY_V29_VERSION = 'ai-stage-policy-v2.9';
/**
 * v2.10 is the immutable successor to the shipped v2.9 microbatch policy. It restores the
 * v2.8 public-presentation guard family without changing v2.9 model, threshold, or scheduler
 * semantics. Historical v2.9 requests deliberately remain on their original bytes.
 */
export const AI_STAGE_POLICY_V210_VERSION = 'ai-stage-policy-v2.10';
/**
 * v2.11 is the forward-only quality successor to v2.10. It preserves the
 * scheduler contract while widening non-official gender follow-up and using
 * decisive, evidence-led public summary copy.
 */
export const AI_STAGE_POLICY_V211_VERSION = 'ai-stage-policy-v2.11';
export const SUPPORTED_AI_STAGE_POLICY_VERSIONS = Object.freeze([
    AI_STAGE_POLICY_VERSION,
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V211_VERSION,
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

/**
 * V2.8 retains its intended copy-prompt updates while keeping the v2.7 policy metadata intact.
 * Its scheduler-managed provider caps match scheduler-v1 exactly, so an admitted operation never
 * waits in a hidden stage queue.
 */
const AI_STAGE_POLICIES_V28 = Object.freeze({
    ...AI_STAGE_POLICIES_V27,
    genderTriage: Object.freeze({
        ...AI_STAGE_POLICIES_V27.genderTriage,
        promptVersion: 'gender-triage-v3',
        concurrency: 6,
    }),
    featureAnalysis: Object.freeze({
        ...AI_STAGE_POLICIES_V27.featureAnalysis,
        concurrency: 3,
        promptVersion: 'feature-analysis-v4',
    }),
    privateAccountName: Object.freeze({
        ...AI_STAGE_POLICIES_V27.privateAccountName,
        concurrency: 2,
    }),
    highRiskNarrative: Object.freeze({
        ...AI_STAGE_POLICIES_V27.highRiskNarrative,
        promptVersion: 'high-risk-narrative-v3',
    }),
} satisfies Record<AiStageName, Readonly<AiStagePolicy>>);

/**
 * The gender stage is deliberately a little larger than one v2.8 response so
 * a bounded two-account response has room for its strict envelope.  The
 * deployment-wide scheduler remains the source of truth for concurrent calls.
 */
const AI_STAGE_POLICIES_V29 = Object.freeze({
    ...AI_STAGE_POLICIES_V28,
    genderTriage: Object.freeze({
        ...AI_STAGE_POLICIES_V28.genderTriage,
        // Scheduler-v1 owns the matching six-call global cap; each call carries <=2 accounts.
        concurrency: 6,
        maxOutputTokens: 1_024,
        promptVersion: 'gender-triage-microbatch-v1',
        schemaVersion: 3,
    }),
} satisfies Record<AiStageName, Readonly<AiStagePolicy>>);

const AI_STAGE_POLICIES_V210 = Object.freeze({
    ...AI_STAGE_POLICIES_V29,
} satisfies Record<AiStageName, Readonly<AiStagePolicy>>);

const AI_STAGE_POLICIES_V211 = Object.freeze({
    ...AI_STAGE_POLICIES_V210,
    genderTriage: Object.freeze({
        ...AI_STAGE_POLICIES_V210.genderTriage,
        promptVersion: 'gender-triage-microbatch-v3',
    }),
    featureAnalysis: Object.freeze({
        ...AI_STAGE_POLICIES_V210.featureAnalysis,
        promptVersion: 'feature-analysis-v5',
    }),
    highRiskNarrative: Object.freeze({
        ...AI_STAGE_POLICIES_V210.highRiskNarrative,
        maxOutputTokens: 8_192,
        promptVersion: 'high-risk-narrative-v4',
    }),
} satisfies Record<AiStageName, Readonly<AiStagePolicy>>);

export const AI_STAGE_POLICY_REGISTRY = Object.freeze({
    [AI_STAGE_POLICY_VERSION]: AI_STAGE_POLICIES,
    [AI_STAGE_POLICY_LATEST_VERSION]: AI_STAGE_POLICIES_V27,
    [AI_STAGE_POLICY_V28_VERSION]: AI_STAGE_POLICIES_V28,
    [AI_STAGE_POLICY_V29_VERSION]: AI_STAGE_POLICIES_V29,
    [AI_STAGE_POLICY_V210_VERSION]: AI_STAGE_POLICIES_V210,
    [AI_STAGE_POLICY_V211_VERSION]: AI_STAGE_POLICIES_V211,
});

export type AiStagePolicyCapability =
    | 'durableGeminiLease'
    | 'genderResolution'
    | 'partialMediaCoverage'
    | 'inputQualityV28'
    | 'genderTriageMicrobatchV29'
    /** Safe v2.8 public-copy contracts, restored for the v2.10 successor only. */
    | 'safePublicPresentationV28'
    | 'genderSummaryQualityV211';

const AI_STAGE_POLICY_CAPABILITIES: Readonly<Record<
    AiStagePolicyVersion,
    ReadonlySet<AiStagePolicyCapability>
>> = Object.freeze({
    [AI_STAGE_POLICY_VERSION]: new Set<AiStagePolicyCapability>(),
    [AI_STAGE_POLICY_LATEST_VERSION]: new Set<AiStagePolicyCapability>([
        'durableGeminiLease',
        'genderResolution',
        'partialMediaCoverage',
    ]),
    [AI_STAGE_POLICY_V28_VERSION]: new Set<AiStagePolicyCapability>([
        'durableGeminiLease',
        'genderResolution',
        'partialMediaCoverage',
        'inputQualityV28',
        'safePublicPresentationV28',
    ]),
    [AI_STAGE_POLICY_V29_VERSION]: new Set<AiStagePolicyCapability>([
        'durableGeminiLease',
        'genderResolution',
        'partialMediaCoverage',
        'inputQualityV28',
        'genderTriageMicrobatchV29',
    ]),
    [AI_STAGE_POLICY_V210_VERSION]: new Set<AiStagePolicyCapability>([
        'durableGeminiLease',
        'genderResolution',
        'partialMediaCoverage',
        'inputQualityV28',
        'genderTriageMicrobatchV29',
        'safePublicPresentationV28',
    ]),
    [AI_STAGE_POLICY_V211_VERSION]: new Set<AiStagePolicyCapability>([
        'durableGeminiLease',
        'genderResolution',
        'partialMediaCoverage',
        'inputQualityV28',
        'genderTriageMicrobatchV29',
        'safePublicPresentationV28',
        'genderSummaryQualityV211',
    ]),
});

export function aiStagePolicySupports(
    version: AiStagePolicyVersion,
    capability: AiStagePolicyCapability,
): boolean {
    return AI_STAGE_POLICY_CAPABILITIES[version].has(capability);
}

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
    narrativeV28RolloutMode,
    microbatchV29RolloutMode,
    genderSummaryQualityV211RolloutMode,
    accessMode,
}: {
    rolloutMode: string | undefined;
    narrativeV28RolloutMode?: string | undefined;
    microbatchV29RolloutMode?: string | undefined;
    genderSummaryQualityV211RolloutMode?: string | undefined;
    accessMode: AiStagePolicyAccessMode;
}): AiStagePolicyVersion {
    const v27Eligible = rolloutMode === 'production'
        || (rolloutMode === 'test_entitlement' && accessMode === 'test_entitlement');
    const v28Eligible = narrativeV28RolloutMode === 'production'
        || (
            narrativeV28RolloutMode === 'test_entitlement'
            && accessMode === 'test_entitlement'
        );
    const v29Eligible = microbatchV29RolloutMode === 'production'
        || (
            microbatchV29RolloutMode === 'test_entitlement'
            && accessMode === 'test_entitlement'
        );
    const v211Eligible = genderSummaryQualityV211RolloutMode === 'production'
        || (
            genderSummaryQualityV211RolloutMode === 'test_entitlement'
            && accessMode === 'test_entitlement'
        );
    if (v27Eligible && v28Eligible && v29Eligible && v211Eligible) {
        return AI_STAGE_POLICY_V211_VERSION;
    }
    if (v27Eligible && v28Eligible && v29Eligible) {
        return AI_STAGE_POLICY_V210_VERSION;
    }
    if (v27Eligible && v28Eligible) {
        return AI_STAGE_POLICY_V28_VERSION;
    }
    if (rolloutMode === 'production') {
        return AI_STAGE_POLICY_LATEST_VERSION;
    }
    if (rolloutMode === 'test_entitlement' && accessMode === 'test_entitlement') {
        return AI_STAGE_POLICY_LATEST_VERSION;
    }
    return AI_STAGE_POLICY_VERSION;
}
