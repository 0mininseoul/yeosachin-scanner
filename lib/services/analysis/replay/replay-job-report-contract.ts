import { z } from 'zod';

export const REPLAY_STAGE_FAILURE_DISPOSITIONS = Object.freeze([
    'success',
    'rate_limited',
    'ambiguous',
    'rejected',
    'response_rejected',
    'retry_exhausted',
    'failed',
    'capacity_skipped',
    'cutoff',
    'backoff_cutoff',
] as const);

export type ReplayStageFailureDisposition =
    typeof REPLAY_STAGE_FAILURE_DISPOSITIONS[number];
export type ReplayStageFailureDispositionCounts =
    Partial<Record<ReplayStageFailureDisposition, number>>;

const replayStageFailureDispositionSet = new Set<string>(
    REPLAY_STAGE_FAILURE_DISPOSITIONS,
);
const aggregateCount = z.number().int().min(0).max(100_000_000);
const aggregateRate = z.number().finite().min(0).max(1);
const stageFailureDispositionCounts = z.object(Object.fromEntries(
    REPLAY_STAGE_FAILURE_DISPOSITIONS.map(disposition => [
        disposition,
        aggregateCount.optional(),
    ]),
)).strict();
const replayOutcomeCounts = z.object({
    ok: aggregateCount.optional(),
    rate_limited: aggregateCount.optional(),
    retry_exhausted: aggregateCount.optional(),
    rejected: aggregateCount.optional(),
    failed: aggregateCount.optional(),
    capacity_skipped: aggregateCount.optional(),
}).strict();
const stageFailureKindCounts = z.object({
    http_408: aggregateCount.optional(),
    http_429: aggregateCount.optional(),
    http_4xx: aggregateCount.optional(),
    http_5xx: aggregateCount.optional(),
    transport: aggregateCount.optional(),
    unknown_sdk: aggregateCount.optional(),
}).strict();
const triageSourceCounts = z.object({
    checkpoint: aggregateCount.optional(),
    safe_fallback: aggregateCount.optional(),
    unknown: aggregateCount.optional(),
    non_ok: aggregateCount.optional(),
}).strict();
const genderConfidenceCounts = z.object({
    'female:low': aggregateCount.optional(),
    'female:medium': aggregateCount.optional(),
    'female:high': aggregateCount.optional(),
    'male:low': aggregateCount.optional(),
    'male:medium': aggregateCount.optional(),
    'male:high': aggregateCount.optional(),
    'unknown:low': aggregateCount.optional(),
    'unknown:medium': aggregateCount.optional(),
    'unknown:high': aggregateCount.optional(),
}).strict();
const triageAccountContextCounts = z.object({
    personal: aggregateCount.optional(),
    individual_creator: aggregateCount.optional(),
    official_group_or_brand: aggregateCount.optional(),
    uncertain: aggregateCount.optional(),
    absent: aggregateCount.optional(),
}).strict();
const featureAdmissionCounts = z.object({
    eligible: aggregateCount.optional(),
    nonpersonal_or_official: aggregateCount.optional(),
    unsupported_unknown: aggregateCount.optional(),
}).strict();
const featureFinalDecisionCounts = z.object({
    verified_female: aggregateCount.optional(),
    verified_non_female: aggregateCount.optional(),
    unresolved: aggregateCount.optional(),
    unresolved_stage_conflict: aggregateCount.optional(),
}).strict();
const featureAccountContextCounts = z.object({
    personal: aggregateCount.optional(),
    individual_creator: aggregateCount.optional(),
    official_group_or_brand: aggregateCount.optional(),
    uncertain: aggregateCount.optional(),
}).strict();
const featureRouteTerminalCounts = z.object({
    not_routed_high_male: aggregateCount.optional(),
    excluded_official: aggregateCount.optional(),
    completed: aggregateCount.optional(),
    provider_non_ok: aggregateCount.optional(),
    triage_non_ok: aggregateCount.optional(),
}).strict();
const resolverOutcomeCounts = replayOutcomeCounts.extend({
    official_excluded: aggregateCount.optional(),
    cutoff: aggregateCount.optional(),
}).strict();
const finalClassificationSourceCounts = z.object({
    triage: aggregateCount.optional(),
    feature: aggregateCount.optional(),
    gender_resolution: aggregateCount.optional(),
    unknown: aggregateCount.optional(),
    unavailable: aggregateCount.optional(),
    triage_non_ok: aggregateCount.optional(),
}).strict();
const stageMetricsSchema = z.object({
    calls: aggregateCount,
    rate_limited: aggregateCount,
    retries: aggregateCount,
    mean_latency_ms: z.number().finite().min(0).max(3_600_000),
    p50_latency_ms: z.number().finite().min(0).max(3_600_000),
    p95_latency_ms: z.number().finite().min(0).max(3_600_000),
    failure_disposition: stageFailureDispositionCounts,
    failure_kind: stageFailureKindCounts,
}).strict();

export const replayAnalysisV2JobTerminalSchema = z.object({
    status: z.literal('ok'),
    benchmark_scope: z.literal('ai-only-historical-partial-available'),
    source_plan: z.literal('standard'),
    source_pipeline: z.literal('v2'),
    source_ai_policy: z.literal('ai-stage-policy-v2.7'),
    source_risk_policy: z.literal('risk-policy-v2.3'),
    evaluation_ai_policy: z.literal('ai-stage-policy-v2.12'),
    replay_ai_policy: z.literal('ai-stage-policy-v2.12'),
    full_e2e_evidence: z.literal(false),
    not_exact: z.literal(true),
    no_media_substitution: z.literal(true),
    diagnostic_partial_coverage_override: z.object({
        used: z.literal(true),
        retained_profiles: aggregateCount,
        source_profiles: aggregateCount,
        retained_media: aggregateCount,
        exact_selected_media: aggregateCount,
        profile_retention_bps: z.number().int().min(0).max(10_000),
        media_retention_bps: z.number().int().min(0).max(10_000),
    }).strict(),
    total_elapsed_ms: z.number().finite().min(0).max(86_400_000),
    stages: z.object({
        genderTriage: stageMetricsSchema,
        featureAnalysis: stageMetricsSchema,
        privateAccountName: stageMetricsSchema,
        genderResolution: stageMetricsSchema,
    }).strict(),
    gender: z.object({
        male: aggregateCount,
        female: aggregateCount,
        unknown: aggregateCount,
        unknownRate: aggregateRate,
    }).strict(),
    resolver: z.object({
        ready: aggregateCount,
        applied: aggregateCount,
        inconclusive: aggregateCount,
        cutoff: aggregateCount,
        capacitySkipped: aggregateCount,
        admission: z.object({
            eligible: aggregateCount,
            alreadyVerified: aggregateCount,
            officialOrGroup: aggregateCount,
            uncertainOrAbsent: aggregateCount,
            insufficientMedia: aggregateCount,
        }).strict(),
        outcomes: z.object({
            readyHighConfirmed: aggregateCount,
            evidenceInsufficient: aggregateCount,
            mixed: aggregateCount,
            unknown: aggregateCount,
            reconciliationApplied: aggregateCount,
            reconciliationInconclusive: aggregateCount,
            cutoff: aggregateCount,
            capacitySkipped: aggregateCount,
        }).strict(),
    }).strict(),
    gender_quality: z.object({
        triage: z.object({
            nonOk: aggregateCount,
            capacity: aggregateCount,
            outcome: replayOutcomeCounts,
            source: triageSourceCounts,
            genderConfidence: genderConfidenceCounts,
            accountContext: triageAccountContextCounts,
        }).strict(),
        feature: z.object({
            admission: featureAdmissionCounts,
            finalDecision: featureFinalDecisionCounts,
            accountContext: featureAccountContextCounts,
            routeTerminal: featureRouteTerminalCounts,
        }).strict(),
        resolver: z.object({
            earlyAdmission: aggregateCount,
            lateAdmission: aggregateCount,
            outcome: resolverOutcomeCounts,
        }).strict(),
        finalClassificationSource: finalClassificationSourceCounts,
        qualityGate: z.object({
            observedUnknownRate: aggregateRate,
            worstCaseUnknownRate: aggregateRate,
            observedPass: z.boolean(),
            worstCasePass: z.boolean(),
        }).strict(),
    }).strict(),
}).strict();

export function replayStageFailureDispositionEntries(
    value: unknown,
): Array<[ReplayStageFailureDisposition, number]> {
    if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_FAILURE_DISPOSITION_INVALID',
        );
    }
    const entries = Object.entries(value);
    if (entries.some(([disposition, count]) => (
        !replayStageFailureDispositionSet.has(disposition)
        || !Number.isInteger(count)
        || (count as number) < 0
    ))) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_FAILURE_DISPOSITION_INVALID',
        );
    }
    return entries as Array<[ReplayStageFailureDisposition, number]>;
}

export function validateReplayAnalysisV2JobTerminalLine(
    raw: string | undefined,
): string {
    if (!raw) throw new Error('ANALYSIS_V2_REPLAY_JOB_REPORT_MISSING');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    if (!replayAnalysisV2JobTerminalSchema.safeParse(parsed).success) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    return raw;
}
