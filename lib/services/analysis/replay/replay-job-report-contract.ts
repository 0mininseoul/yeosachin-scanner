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
const resolverHeadroomCounts = z.object({
    finalUnknownWithResolverMediaAtLeast2: aggregateCount,
    highBinaryFeatureUnresolvedPersonalOrIndividualCreatorWithResolverMediaAtLeast2: aggregateCount,
    featureUnresolvedWithUncertainAccountContext: aggregateCount,
    capacitySkippedFinalUnknown: aggregateCount,
    earlyResolverReadyFeatureFinalKnown: aggregateCount,
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

const replayAnalysisV2JobTerminalV212Schema = z.object({
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
        headroom: resolverHeadroomCounts,
        qualityGate: z.object({
            observedUnknownRate: aggregateRate,
            worstCaseUnknownRate: aggregateRate,
            observedPass: z.boolean(),
            worstCasePass: z.boolean(),
        }).strict(),
    }).strict(),
}).strict();

const shadowRescueCounts = z.object({
    baselineMale: aggregateCount,
    baselineFemale: aggregateCount,
    baselineUnknown: aggregateCount,
    officialOrGroupExcluded: aggregateCount,
    insufficientMedia: aggregateCount,
    controlUnavailable: aggregateCount,
    eligible: aggregateCount,
    attempted: aggregateCount,
    rescuedMale: aggregateCount,
    rescuedFemale: aggregateCount,
    unresolved: aggregateCount,
    providerNonOk: z.object({
        rateLimited: aggregateCount,
        retryExhausted: aggregateCount,
        rejected: aggregateCount,
        failed: aggregateCount,
        capacitySkipped: aggregateCount,
    }).strict(),
    finalMale: aggregateCount,
    finalFemale: aggregateCount,
    finalUnknown: aggregateCount,
    missingPublic: aggregateCount,
}).strict();

const shadowAdmissionCohortCounts = z.object({
    eligible: aggregateCount,
    attempted: aggregateCount,
    rescuedMale: aggregateCount,
    rescuedFemale: aggregateCount,
    unresolved: aggregateCount,
    providerNonOk: z.object({
        rateLimited: aggregateCount,
        retryExhausted: aggregateCount,
        rejected: aggregateCount,
        failed: aggregateCount,
        capacitySkipped: aggregateCount,
    }).strict(),
}).strict();

const shadowRescueV216Counts = shadowRescueCounts.extend({
    admissionCohorts: z.object({
        resolverMediaAtLeast2: shadowAdmissionCohortCounts,
        singleProfileOnly: shadowAdmissionCohortCounts,
    }).strict(),
}).strict();

function featureShadowTerminalSchema(
    aiStage:
        | 'ai-stage-policy-v2.13'
        | 'ai-stage-policy-v2.14'
        | 'ai-stage-policy-v2.15'
        | 'ai-stage-policy-v2.16',
) {
    return replayAnalysisV2JobTerminalV212Schema.extend({
        evaluation_ai_policy: z.literal(aiStage),
        replay_ai_policy: z.literal(aiStage),
        stages: replayAnalysisV2JobTerminalV212Schema.shape.stages.extend({
            featureAnalysisShadowRescue: stageMetricsSchema,
        }).strict(),
        gender_quality:
            replayAnalysisV2JobTerminalV212Schema.shape.gender_quality.extend({
                shadow_rescue: aiStage === 'ai-stage-policy-v2.16'
                    ? shadowRescueV216Counts
                    : shadowRescueCounts,
            }).strict(),
    }).strict().superRefine((report, context) => {
        const shadow = report.gender_quality.shadow_rescue;
        const publicCount =
            report.gender.male + report.gender.female + report.gender.unknown;
        const coverageMissingPublic =
            report.diagnostic_partial_coverage_override.source_profiles
            - report.diagnostic_partial_coverage_override.retained_profiles;
        const providerNonOk = Object.values(shadow.providerNonOk)
            .reduce((sum, count) => sum + count, 0);
        const expectedUnknownRate = publicCount === 0
            ? 0
            : Number((report.gender.unknown / publicCount).toFixed(4));
        const worstCaseTotal = publicCount + shadow.missingPublic;
        const worstCaseUnknown = report.gender.unknown + shadow.missingPublic;
        const expectedWorstCaseUnknownRate = worstCaseTotal === 0
            ? 0
            : Number((worstCaseUnknown / worstCaseTotal).toFixed(4));
        const admissionCohorts = aiStage === 'ai-stage-policy-v2.16'
            ? (shadow as z.infer<typeof shadowRescueV216Counts>)
                .admissionCohorts
            : null;
        const cohortConservationValid = admissionCohorts
            ? (() => {
                const cohorts = [
                    admissionCohorts.resolverMediaAtLeast2,
                    admissionCohorts.singleProfileOnly,
                ];
                const cohortValid = cohorts.every(cohort => (
                    cohort.eligible === cohort.attempted
                    && cohort.attempted
                        === cohort.rescuedMale
                            + cohort.rescuedFemale
                            + cohort.unresolved
                            + Object.values(cohort.providerNonOk)
                                .reduce((sum, count) => sum + count, 0)
                ));
                const sum = (
                    select: (cohort: typeof cohorts[number]) => number,
                ) => cohorts.reduce(
                    (total, cohort) => total + select(cohort),
                    0,
                );
                return cohortValid
                    && sum(cohort => cohort.eligible) === shadow.eligible
                    && sum(cohort => cohort.attempted) === shadow.attempted
                    && sum(cohort => cohort.rescuedMale)
                        === shadow.rescuedMale
                    && sum(cohort => cohort.rescuedFemale)
                        === shadow.rescuedFemale
                    && sum(cohort => cohort.unresolved) === shadow.unresolved
                    && Object.keys(shadow.providerNonOk).every(key => (
                        sum(cohort => cohort.providerNonOk[
                            key as keyof typeof cohort.providerNonOk
                        ]) === shadow.providerNonOk[
                            key as keyof typeof shadow.providerNonOk
                        ]
                    ));
            })()
            : true;
        const valid =
            shadow.missingPublic === coverageMissingPublic
            && shadow.baselineMale
                + shadow.baselineFemale
                + shadow.baselineUnknown === publicCount
            && shadow.finalMale
                + shadow.finalFemale
                + shadow.finalUnknown === publicCount
            && shadow.baselineUnknown
                === shadow.officialOrGroupExcluded
                    + shadow.insufficientMedia
                    + shadow.controlUnavailable
                    + shadow.eligible
            && shadow.eligible === shadow.attempted
            && shadow.attempted
                === shadow.rescuedMale
                    + shadow.rescuedFemale
                    + shadow.unresolved
                    + providerNonOk
            && shadow.finalMale
                === shadow.baselineMale + shadow.rescuedMale
            && shadow.finalFemale
                === shadow.baselineFemale + shadow.rescuedFemale
            && shadow.finalUnknown
                === shadow.baselineUnknown
                    - shadow.rescuedMale
                    - shadow.rescuedFemale
            && shadow.finalMale === report.gender.male
            && shadow.finalFemale === report.gender.female
            && shadow.finalUnknown === report.gender.unknown
            && report.stages.featureAnalysisShadowRescue.calls
                <= shadow.attempted * 4
            && report.gender.unknownRate === expectedUnknownRate
            && report.gender_quality.qualityGate.observedUnknownRate
                === expectedUnknownRate
            && report.gender_quality.qualityGate.observedPass
                === (report.gender.unknown * 5 <= publicCount)
            && report.gender_quality.qualityGate.worstCaseUnknownRate
                === expectedWorstCaseUnknownRate
            && report.gender_quality.qualityGate.worstCasePass
                === (worstCaseUnknown * 5 <= worstCaseTotal)
            && cohortConservationValid;
        if (!valid) {
            context.addIssue({
                code: 'custom',
                message:
                    aiStage === 'ai-stage-policy-v2.13'
                        ? 'ANALYSIS_V2_REPLAY_V213_SHADOW_CONSERVATION_FAILED'
                        : aiStage === 'ai-stage-policy-v2.14'
                            ? 'ANALYSIS_V2_REPLAY_V214_SHADOW_CONSERVATION_FAILED'
                            : aiStage === 'ai-stage-policy-v2.15'
                                ? 'ANALYSIS_V2_REPLAY_V215_SHADOW_CONSERVATION_FAILED'
                                : 'ANALYSIS_V2_REPLAY_V216_SHADOW_CONSERVATION_FAILED',
            });
        }
    });
}

const replayAnalysisV2JobTerminalV213Schema =
    featureShadowTerminalSchema('ai-stage-policy-v2.13');
/** V2.14 preserves the V2.13 PII-free shadow aggregate contract byte-for-byte. */
const replayAnalysisV2JobTerminalV214Schema =
    featureShadowTerminalSchema('ai-stage-policy-v2.14');
/** V2.15 preserves the same strict PII-free shadow aggregate contract. */
const replayAnalysisV2JobTerminalV215Schema =
    featureShadowTerminalSchema('ai-stage-policy-v2.15');
/** V2.16 requires strict admission-cohort partition conservation. */
const replayAnalysisV2JobTerminalV216Schema =
    featureShadowTerminalSchema('ai-stage-policy-v2.16');

const publicNameFusionSexCalibration = z.object({
    known: aggregateCount,
    predicted: aggregateCount,
    agreed: aggregateCount,
    disagreed: aggregateCount,
}).strict();

const publicNameFusionCounts = z.object({
    publicAnalyzed: aggregateCount,
    providerOk: z.boolean(),
    calibration: publicNameFusionSexCalibration.extend({
        male: publicNameFusionSexCalibration,
        female: publicNameFusionSexCalibration,
    }).strict(),
    officialNegative: z.object({
        known: aggregateCount,
        fusionAccepted: aggregateCount,
    }).strict(),
    unknown: z.object({
        eligible: aggregateCount,
        predicted: aggregateCount,
        rescuedMale: aggregateCount,
        rescuedFemale: aggregateCount,
        unresolved: aggregateCount,
    }).strict(),
    baseline: z.object({
        male: aggregateCount,
        female: aggregateCount,
        unknown: aggregateCount,
    }).strict(),
    final: z.object({
        male: aggregateCount,
        female: aggregateCount,
        unknown: aggregateCount,
    }).strict(),
    missingPublic: aggregateCount,
    gates: z.object({
        calibrationVolumePass: z.boolean(),
        overallAgreementPass: z.boolean(),
        maleVolumePass: z.boolean(),
        maleAgreementPass: z.boolean(),
        femaleVolumePass: z.boolean(),
        femaleAgreementPass: z.boolean(),
        officialNegativePass: z.boolean(),
        observedUnknownRate: aggregateRate,
        observedUnknownPass: z.boolean(),
        worstCaseUnknownRate: aggregateRate,
        worstCaseUnknownPass: z.boolean(),
        adoptionPass: z.boolean(),
    }).strict(),
}).strict();

const replayAnalysisV2JobTerminalV217Schema =
    replayAnalysisV2JobTerminalV212Schema.extend({
        evaluation_ai_policy: z.literal('ai-stage-policy-v2.17'),
        replay_ai_policy: z.literal('ai-stage-policy-v2.17'),
        public_name_fusion: publicNameFusionCounts,
    }).strict().superRefine((report, context) => {
        const fusion = report.public_name_fusion;
        const calibration = fusion.calibration;
        const unknown = fusion.unknown;
        const observedTotal = fusion.baseline.male
            + fusion.baseline.female
            + fusion.baseline.unknown;
        const finalTotal = fusion.final.male
            + fusion.final.female
            + fusion.final.unknown;
        const coverageMissingPublic =
            report.diagnostic_partial_coverage_override.source_profiles
            - report.diagnostic_partial_coverage_override.retained_profiles;
        const observedUnknownRate = observedTotal === 0
            ? 0
            : Number((fusion.final.unknown / observedTotal).toFixed(4));
        const worstCaseTotal = observedTotal + fusion.missingPublic;
        const worstCaseUnknown = fusion.final.unknown + fusion.missingPublic;
        const worstCaseUnknownRate = worstCaseTotal === 0
            ? 0
            : Number((worstCaseUnknown / worstCaseTotal).toFixed(4));
        const calibrationVolumePass = calibration.predicted >= 30;
        const overallAgreementPass = calibration.predicted > 0
            && calibration.agreed * 10_000 >= calibration.predicted * 9_500;
        const maleVolumePass = calibration.male.predicted >= 10;
        const maleAgreementPass = maleVolumePass
            && calibration.male.predicted > 0
            && calibration.male.agreed * 10_000
                >= calibration.male.predicted * 9_500;
        const femaleVolumePass = calibration.female.predicted >= 10;
        const femaleAgreementPass = femaleVolumePass
            && calibration.female.predicted > 0
            && calibration.female.agreed * 10_000
                >= calibration.female.predicted * 9_500;
        const officialNegativePass =
            fusion.officialNegative.fusionAccepted === 0;
        const observedUnknownPass =
            fusion.final.unknown * 5 <= observedTotal;
        const worstCaseUnknownPass =
            worstCaseUnknown * 5 <= worstCaseTotal;
        const adoptionPass = fusion.providerOk
            && calibrationVolumePass
            && overallAgreementPass
            && maleVolumePass
            && maleAgreementPass
            && femaleVolumePass
            && femaleAgreementPass
            && officialNegativePass
            && observedUnknownPass
            && worstCaseUnknownPass;
        const valid =
            fusion.missingPublic === coverageMissingPublic
            && observedTotal === finalTotal
            && fusion.publicAnalyzed
                === (fusion.providerOk ? observedTotal : 0)
            && calibration.known
                === fusion.baseline.male + fusion.baseline.female
            && calibration.known
                === calibration.male.known + calibration.female.known
            && calibration.male.known === fusion.baseline.male
            && calibration.female.known === fusion.baseline.female
            && calibration.predicted
                === calibration.agreed + calibration.disagreed
            && calibration.predicted
                === calibration.male.predicted
                    + calibration.female.predicted
            && calibration.agreed
                === calibration.male.agreed + calibration.female.agreed
            && calibration.disagreed
                === calibration.male.disagreed
                    + calibration.female.disagreed
            && calibration.male.predicted
                === calibration.male.agreed + calibration.male.disagreed
            && calibration.female.predicted
                === calibration.female.agreed + calibration.female.disagreed
            && unknown.predicted
                === unknown.rescuedMale + unknown.rescuedFemale
            && unknown.predicted <= unknown.eligible
            && unknown.eligible <= fusion.baseline.unknown
            && unknown.unresolved
                === fusion.baseline.unknown - unknown.predicted
            && fusion.final.male
                === fusion.baseline.male + unknown.rescuedMale
            && fusion.final.female
                === fusion.baseline.female + unknown.rescuedFemale
            && fusion.final.unknown === unknown.unresolved
            && fusion.officialNegative.known <= observedTotal
            && fusion.officialNegative.fusionAccepted === 0
            && fusion.final.male === report.gender.male
            && fusion.final.female === report.gender.female
            && fusion.final.unknown === report.gender.unknown
            && report.gender.unknownRate === observedUnknownRate
            && fusion.gates.calibrationVolumePass
                === calibrationVolumePass
            && fusion.gates.overallAgreementPass === overallAgreementPass
            && fusion.gates.maleVolumePass === maleVolumePass
            && fusion.gates.maleAgreementPass === maleAgreementPass
            && fusion.gates.femaleVolumePass === femaleVolumePass
            && fusion.gates.femaleAgreementPass === femaleAgreementPass
            && fusion.gates.officialNegativePass === officialNegativePass
            && fusion.gates.observedUnknownRate === observedUnknownRate
            && fusion.gates.observedUnknownPass === observedUnknownPass
            && fusion.gates.worstCaseUnknownRate === worstCaseUnknownRate
            && fusion.gates.worstCaseUnknownPass === worstCaseUnknownPass
            && fusion.gates.adoptionPass === adoptionPass
            && report.gender_quality.qualityGate.observedUnknownRate
                === observedUnknownRate
            && report.gender_quality.qualityGate.observedPass
                === observedUnknownPass
            && report.gender_quality.qualityGate.worstCaseUnknownRate
                === worstCaseUnknownRate
            && report.gender_quality.qualityGate.worstCasePass
                === worstCaseUnknownPass;
        if (!valid) {
            context.addIssue({
                code: 'custom',
                message:
                    'ANALYSIS_V2_REPLAY_V217_NAME_FUSION_CONSERVATION_FAILED',
            });
        }
    });

export const replayAnalysisV2JobTerminalSchema = z.union([
    replayAnalysisV2JobTerminalV212Schema,
    replayAnalysisV2JobTerminalV213Schema,
    replayAnalysisV2JobTerminalV214Schema,
    replayAnalysisV2JobTerminalV215Schema,
    replayAnalysisV2JobTerminalV216Schema,
    replayAnalysisV2JobTerminalV217Schema,
]);

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
