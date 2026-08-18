import type {
    FeatureAnalysisResult,
    GenderNameOnlyCandidateInput,
    GenderNameOnlyResult,
    GenderResolutionResult,
    GenderTriageResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { MAX_FEATURE_MEDIA } from '@/lib/domain/analysis/media-policy';
import { applyGenderResolution, type GenderBaselineClassification } from '@/lib/services/ai/gender-resolution-reconciliation';
import { aiStagePolicySupports } from '@/lib/services/ai/stage-policy';
import type { PrivateNameAccountInput } from '@/lib/services/ai/private-name-analysis';
import {
    analysisV2ReplaySemanticInputFingerprint,
    type AnalysisV2ReplayBundle,
} from './replay-bundle';
import {
    BETATEST_FREE_POOL_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
    CURRENT_PRODUCTION_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
    TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY,
    TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY,
    FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
} from './replay-source-lineage';
import { v29FeatureAdmission } from '../v2-v29-feature-admission';
import { v211FeatureAdmission } from '../v2-v211-feature-admission';
import { v29GenderResolverAdmission } from '../v2-v29-gender-resolver-admission';
import { selectAnalysisV2GenderResolverMedia } from '../v2-gender-resolver-media-policy';
import { historicalPartialBundleInvariantIssues, historicalPartialPaidCoverage } from './historical-partial-available-artifact';
import {
    isDiagnosticPartialCoverageCliCapability,
    type DiagnosticPartialCoverageCliCapability,
} from './diagnostic-partial-coverage-capability';
import {
    isFeatureConcurrencyExperimentCliCapability,
    type FeatureConcurrencyExperimentCliCapability,
} from './feature-concurrency-experiment-capability';
import { ANALYSIS_V2_SCHEDULER_V1_POLICY } from '../v2-ai-scheduler-runtime';

export type ReplayMode = 'dry-run' | 'paid-ai';
export type ReplayOutcome = 'ok' | 'rate_limited' | 'retry_exhausted' | 'rejected' | 'failed' | 'capacity_skipped';

export interface ReplayInvocation<T> {
    outcome: ReplayOutcome;
    value?: T;
    calls?: number;
    rateLimited?: number;
    failureDisposition?: Readonly<Record<string, number>>;
    attemptLatenciesMs?: readonly number[];
    attempts: number;
    retries: number;
    elapsedMs: number;
}

export interface ReplayMedia {
    selectionId: string;
    kind: 'profile' | 'feed';
    postId?: string;
    caption?: string | null;
    jpegBase64: string;
}

export interface ReplayTriageInput {
    ordinal: number;
    media: readonly ReplayMedia[];
    accountProfile?: ReplayAccountProfile;
}

export type ReplayNameOnlyInput = GenderNameOnlyCandidateInput;
export type ReplayNameOnlyResult = GenderNameOnlyResult;

export interface ReplayFirstPassInput {
    ordinal: number;
    /** The first pass is never invoked without a non-empty display name. */
    fullName: string;
    /** Exactly one profile image; feed media is admitted by the second stage. */
    media: readonly ReplayMedia[];
}

export interface ReplayAccountProfile {
    fullName: string | null;
    hasProfileImage: boolean;
    bio: string | null;
}

export interface ReplayAiRunner {
    firstPass?(input: ReplayFirstPassInput): Promise<ReplayInvocation<GenderTriageResult>>;
    triage?(input: ReplayTriageInput): Promise<ReplayInvocation<GenderTriageResult>>;
    nameOnly?(input: readonly ReplayNameOnlyInput[]): Promise<ReplayInvocation<readonly ReplayNameOnlyResult[]>>;
    feature?(input: { ordinal: number; bio: string | null; accountProfile?: ReplayAccountProfile; media: readonly ReplayMedia[]; captions: readonly ReplayCaption[]; triage: GenderTriageResult }): Promise<ReplayInvocation<FeatureAnalysisResult>>;
    privateNames?(input: readonly PrivateNameAccountInput[]): Promise<ReplayInvocation<unknown>>;
    resolveGender?(input: {
        ordinal: number;
        media: readonly ReplayMedia[];
        signal: AbortSignal;
        onAttemptStart?: (value: ReplayAttemptStart) => void;
        onAttemptTelemetry?: (value: ReplayAttemptTelemetry) => void;
    }): Promise<ReplayInvocation<GenderResolutionResult>>;
}

async function assertReplayAiRunnerPolicy(
    runner: ReplayAiRunner | undefined,
    expected: ReturnType<typeof resolveReplayAiStagePolicyVersion>,
    expectedFeatureConcurrency: 3 | 4,
): Promise<ReplayAiRunner> {
    const {
        lookupReplayStagedAiAdapterFeatureConcurrency,
        lookupReplayStagedAiAdapterPolicy,
    } = await import(
        './replay-staged-ai-adapter'
    );
    if (
        !runner
        || lookupReplayStagedAiAdapterPolicy(runner) !== expected
        || lookupReplayStagedAiAdapterFeatureConcurrency(runner)
            !== expectedFeatureConcurrency
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
    }
    return runner;
}

export interface ReplayCaption { evidenceRefId: string; selectionId: string; text: string; }
export interface ReplayAttemptStart { attempt: number; retryCount: number; }
export interface ReplayAttemptTelemetry extends ReplayAttemptStart {
    disposition: string;
    latencyMs: number;
}
export interface ReplayStageMetrics {
    calls: number; rateLimited: number; retries: number; meanLatencyMs: number; p50LatencyMs: number; p95LatencyMs: number; failureDisposition: Record<string, number>;
}
export interface AnalysisV2AiReplayReport {
    benchmarkScope: 'ai-only-exact-replay' | 'ai-only-historical-partial-available';
    sourcePlan: 'basic' | 'standard' | 'plus';
    sourcePipeline: 'v2';
    sourceAiPolicy: string;
    sourceRiskPolicy: string;
    evaluationAiPolicy: string | null;
    replayAiPolicy: string;
    semanticInputFingerprint: string;
    fullE2eEvidence: false;
    sourceKind: 'current_paid_production' | 'betatest_free_pool' | 'test_entitlement_v211_legacy_secondary' | 'test_entitlement_v211_legacy_secondary_text_only' | 'first_payment_basic_v211_concierge' | 'historical_or_legacy';
    featureConcurrency: {
        experiment: 'baseline' | 'feature-concurrency-4';
        featureAnalysis: 3 | 4;
        sharedCap: 8;
    };
    notExact?: true;
    noMediaSubstitution?: true;
    diagnosticCoverageOverride?: {
        used: true;
        retainedProfiles: number;
        sourceProfiles: number;
        retainedMedia: number;
        exactSelectedMedia: number;
        profileRetentionBps: number;
        mediaRetentionBps: number;
    };
    stages: Record<'genderTriage' | 'featureAnalysis' | 'privateAccountName' | 'genderResolution', ReplayStageMetrics>;
    gender: { male: number; female: number; unknown: number; unknownRate: number };
    resolver: {
        ready: number;
        applied: number;
        inconclusive: number;
        cutoff: number;
        capacitySkipped: number;
        admission: {
            eligible: number;
            alreadyVerified: number;
            officialOrGroup: number;
            uncertainOrAbsent: number;
            insufficientMedia: number;
        };
        outcomes: {
            readyHighConfirmed: number;
            evidenceInsufficient: number;
            mixed: number;
            unknown: number;
            reconciliationApplied: number;
            reconciliationInconclusive: number;
            cutoff: number;
            capacitySkipped: number;
        };
    };
    totalElapsedMs: number;
    /** Kept out of stdout; a sealed legacy-secondary preview consumes this only in-process. */
    accountOutputs: readonly ReplayAccountAiOutput[];
}

export interface ReplayAccountAiOutput {
    ordinal: number;
    finalClassification: GenderBaselineClassification;
    classificationSource: 'triage' | 'feature' | 'gender_resolution' | 'name_only' | 'unknown' | 'unavailable';
    featureOverview: string | null;
}

export interface ReplayAccountAiDetail extends ReplayAccountAiOutput {
    triage: GenderTriageResult | null;
    feature: FeatureAnalysisResult | null;
}

type ReplayBaselineClassification =
    | 'verified_female'
    | 'verified_non_female'
    | 'unresolved_stage_conflict'
    | 'unresolved'
    | 'analysis_unavailable';

interface TrackedResolver {
    abort: AbortController;
    promise?: Promise<ReplayInvocation<GenderResolutionResult>>;
    settled: boolean;
    value?: ReplayInvocation<GenderResolutionResult>;
    telemetry: {
        calls: number;
        retries: number;
        rateLimited: number;
        attemptLatenciesMs: number[];
        failureDisposition: Record<string, number>;
        pendingAttemptStartedAt?: number;
    };
}

interface PreparedPublicReplay {
    ordinal: number;
    baseline: ReplayBaselineClassification;
    triage: GenderTriageResult;
    feature?: ReplayInvocation<FeatureAnalysisResult>;
    resolver?: TrackedResolver;
}

async function abortAndObserveResolvers(
    resolvers: readonly TrackedResolver[],
    timeoutMs: number,
): Promise<void> {
    resolvers.forEach(resolver => {
        if (!resolver.settled) resolver.abort.abort();
    });
    await Promise.all(resolvers.map(async resolver => {
        if (!resolver.promise) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                resolver.promise.catch(() => undefined),
                new Promise<undefined>(resolve => {
                    timer = setTimeout(() => resolve(undefined), timeoutMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }));
}

function metrics(): ReplayStageMetrics {
    return {
        calls: 0,
        rateLimited: 0,
        retries: 0,
        meanLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        failureDisposition: {},
    };
}

export function analysisV2ReplayResolverReadyOutcome(
    result: GenderResolutionResult,
): 'ready_high_confirmed' | 'evidence_insufficient' | 'mixed' | 'unknown' {
    const assessment = result.assessment;
    if (assessment.ownerConsistency === 'mixed_people') return 'mixed';
    if (
        assessment.inferredGender === 'unknown'
        || assessment.ownerConsistency === 'not_visible'
    ) return 'unknown';
    if (
        assessment.confidence === 'high'
        && assessment.ownerConsistency === 'same_person'
        && new Set(assessment.evidenceSelectionIds).size >= 2
    ) return 'ready_high_confirmed';
    return 'evidence_insufficient';
}

function assertArtifactCapability(bundle: AnalysisV2ReplayBundle): void {
    if (bundle.schemaVersion === 3) {
        throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_CAPABILITY_MISMATCH');
    }
    const capture = bundle.capture as AnalysisV2ReplayBundle['capture'] & {
        evaluationPolicy?: { capability?: string };
        scope?: string; notExact?: boolean; fullE2eEvidence?: boolean;
        noMediaSubstitution?: boolean;
        partial?: {
            sourceUniverseDigest?: string;
            sourceIdentities?: readonly { ordinal: number; username: string; partition: 'private' | 'public' | 'fetch_terminal' }[];
            mediaUnavailable?: readonly { ordinal: number }[];
        };
    };
    const capability = capture.evaluationPolicy?.capability;
    const partialCapability =
        capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY
        || capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY;
    if (
        (bundle.schemaVersion === 1 && partialCapability)
        || (bundle.schemaVersion === 2 && !partialCapability)
    ) throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_CAPABILITY_MISMATCH');
    if (bundle.schemaVersion !== 2) return;
    if (
        capture.scope !== 'ai-only-historical-partial-available'
        || capture.notExact !== true
        || capture.fullE2eEvidence !== false
        || capture.noMediaSubstitution !== true
        || typeof capture.partial?.sourceUniverseDigest !== 'string'
        || !Array.isArray(capture.partial?.sourceIdentities)
        || !Array.isArray(capture.partial?.mediaUnavailable)
    ) throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_CAPABILITY_MISMATCH');
    if (historicalPartialBundleInvariantIssues({
        sourceUniverseDigest: capture.partial.sourceUniverseDigest,
        sourceIdentities: capture.partial.sourceIdentities,
        mediaUnavailable: capture.partial.mediaUnavailable,
        profiles: bundle.profiles,
    }).length) throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
}

function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)] ?? 0;
}

function collect(stage: ReplayStageMetrics, durations: number[], invocation: ReplayInvocation<unknown>): void {
    stage.calls += invocation.calls ?? 1;
    stage.retries += Math.max(0, invocation.retries);
    const attemptLatencies = invocation.attemptLatenciesMs?.filter(value => (
        Number.isFinite(value) && value >= 0
    ));
    if (attemptLatencies?.length) {
        durations.push(...attemptLatencies);
    } else if ((invocation.calls ?? 1) > 0) {
        durations.push(Math.max(0, invocation.elapsedMs));
    }
    stage.rateLimited += invocation.rateLimited
        ?? (invocation.outcome === 'rate_limited' ? 1 : 0);
    const recordedFailureEntries = Object.entries(invocation.failureDisposition ?? {})
        .filter(([, count]) => Number.isInteger(count) && count > 0);
    for (const [disposition, count] of recordedFailureEntries) {
        stage.failureDisposition[disposition] =
            (stage.failureDisposition[disposition] ?? 0) + count;
    }
    if (invocation.outcome !== 'ok' && recordedFailureEntries.length === 0) {
        stage.failureDisposition[invocation.outcome] =
            (stage.failureDisposition[invocation.outcome] ?? 0) + 1;
    }
}

function collectCutoffResolver(
    stage: ReplayStageMetrics,
    durations: number[],
    tracked: TrackedResolver,
): void {
    stage.calls += tracked.telemetry.calls;
    stage.retries += tracked.telemetry.retries;
    stage.rateLimited += tracked.telemetry.rateLimited;
    for (const [disposition, count] of Object.entries(
        tracked.telemetry.failureDisposition,
    )) {
        stage.failureDisposition[disposition] =
            (stage.failureDisposition[disposition] ?? 0) + count;
    }
    durations.push(...tracked.telemetry.attemptLatenciesMs);
    if (tracked.telemetry.pendingAttemptStartedAt !== undefined) {
        stage.failureDisposition.cutoff =
            (stage.failureDisposition.cutoff ?? 0) + 1;
        durations.push(Math.max(1, Math.round(
            performance.now() - tracked.telemetry.pendingAttemptStartedAt,
        )));
    } else {
        stage.failureDisposition.backoff_cutoff =
            (stage.failureDisposition.backoff_cutoff ?? 0) + 1;
    }
}

function finalize(stage: ReplayStageMetrics, durations: number[]): void {
    if (!durations.length) return;
    stage.meanLatencyMs = Math.round(
        durations.reduce((sum, value) => sum + value, 0) / durations.length,
    );
    stage.p50LatencyMs = percentile(durations, 0.5);
    stage.p95LatencyMs = percentile(durations, 0.95);
}

function assertReplayInput(bundle: AnalysisV2ReplayBundle): void {
    const textOnly = bundle.schemaVersion === 1
        && bundle.capture.evaluationPolicy?.capability
            === TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY
        && Boolean(bundle.capture.legacySecondary?.textOnly);
    const conciergeNameOnly = bundle.schemaVersion === 1
        && bundle.capture.evaluationPolicy?.capability
            === FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY;
    const ordinals = new Set<number>();
    const usernames = new Set<string>();
    for (const profile of bundle.profiles) {
        if (ordinals.has(profile.ordinal) || usernames.has(profile.username)) {
            throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
        }
        ordinals.add(profile.ordinal);
        usernames.add(profile.username);
        const ids = new Set<string>();
        for (const media of profile.media) {
            const jpeg = Buffer.from(media.jpegBase64, 'base64');
            if (
                ids.has(media.selectionId)
                || jpeg.length < 4
                || jpeg[0] !== 0xff
                || jpeg[1] !== 0xd8
                || jpeg.at(-2) !== 0xff
                || jpeg.at(-1) !== 0xd9
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
            }
            ids.add(media.selectionId);
        }
        const featureIds = new Set(profile.featureSelectionIds);
        const invalidPublic = !profile.isPrivate && (
            (!textOnly && !conciergeNameOnly && (!profile.media.length || !profile.triageSelectionIds.length))
            || new Set(profile.triageSelectionIds).size !== profile.triageSelectionIds.length
            || featureIds.size !== profile.featureSelectionIds.length
            || new Set(profile.resolverSelectionIds).size !== profile.resolverSelectionIds.length
            || profile.media.some(media => !featureIds.has(media.selectionId))
            || profile.featureSelectionIds.length !== profile.media.length
            || profile.triageSelectionIds.some(id => !ids.has(id))
            || profile.resolverSelectionIds.length !== profile.featureSelectionIds.length
            || profile.resolverSelectionIds.some(id => !featureIds.has(id))
            || profile.captions.some(caption => !featureIds.has(caption.selectionId))
        );
        const invalidPrivate = profile.isPrivate && (
            profile.media.length > 0
            || profile.triageSelectionIds.length > 0
            || profile.featureSelectionIds.length > 0
            || profile.resolverSelectionIds.length > 0
            || profile.captions.length > 0
        );
        const failureIds = new Set(profile.coverage.failures.map(failure => failure.selectionId));
        const invalidCoverage = profile.coverage.selectedCount !== profile.media.length + profile.coverage.failures.length
            || profile.coverage.normalizedCount !== profile.media.length
            || failureIds.size !== profile.coverage.failures.length
            || [...failureIds].some(id => ids.has(id))
            || (!textOnly && !conciergeNameOnly && !profile.isPrivate && (
                profile.coverage.normalizedCount < 1
                || profile.coverage.failures.length * 5 > profile.coverage.selectedCount
            ));
        if (invalidPublic || invalidPrivate || invalidCoverage) {
            throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
        }
    }
}

async function runBounded<T>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (next < values.length) {
                const index = next++;
                await fn(values[index]!);
            }
        },
    ));
}

function mediaFor(
    profile: Pick<AnalysisV2ReplayBundle['profiles'][number], 'media'>,
    ids: readonly string[],
): ReplayMedia[] {
    const allowed = new Set(ids);
    return profile.media.filter(item => allowed.has(item.selectionId));
}

/**
 * Feature analysis always receives the captured profile image when one exists.
 * Keep the feed order from the feature selection while reserving one slot for
 * the profile image so the profile cannot be displaced by a full feed set.
 */
export function selectReplayFeatureMedia(
    profile: Pick<AnalysisV2ReplayBundle['profiles'][number], 'media'>,
    ids: readonly string[],
): ReplayMedia[] {
    const selected = mediaFor(profile, ids);
    const profileMedia = profile.media.find(item => item.kind === 'profile');
    if (!profileMedia) return selected.slice(0, MAX_FEATURE_MEDIA);
    return [
        profileMedia,
        ...selected
            .filter(item => item.kind === 'feed')
            .slice(0, MAX_FEATURE_MEDIA - 1),
    ];
}

function replayNameOnlyTriageResult(
    result: ReplayNameOnlyResult,
): GenderTriageResult {
    return {
        assessment: {
            inferredGender: result.gender,
            confidence: result.confidence,
            ownerConsistency: 'not_visible',
            evidenceSelectionIds: [],
        },
        routingDecision: 'route_to_feature_analysis',
        routingReason: 'conserve_female_recall',
        analyzedSelectionIds: [],
    };
}

function safeLine(report: AnalysisV2AiReplayReport): string {
    return JSON.stringify({
        status: 'ok',
        benchmark_scope: report.benchmarkScope,
        source_plan: report.sourcePlan,
        source_pipeline: report.sourcePipeline,
        source_ai_policy: report.sourceAiPolicy,
        source_risk_policy: report.sourceRiskPolicy,
        evaluation_ai_policy: report.evaluationAiPolicy,
        replay_ai_policy: report.replayAiPolicy,
        semantic_input_fingerprint: report.semanticInputFingerprint,
        full_e2e_evidence: report.fullE2eEvidence,
        source_kind: report.sourceKind,
        feature_concurrency_experiment: report.featureConcurrency.experiment,
        feature_analysis_concurrency: report.featureConcurrency.featureAnalysis,
        shared_concurrency_cap: report.featureConcurrency.sharedCap,
        ...(report.notExact ? { not_exact: true, no_media_substitution: true } : {}),
        ...(report.diagnosticCoverageOverride ? {
            diagnostic_partial_coverage_override: {
                used: true,
                retained_profiles: report.diagnosticCoverageOverride.retainedProfiles,
                source_profiles: report.diagnosticCoverageOverride.sourceProfiles,
                retained_media: report.diagnosticCoverageOverride.retainedMedia,
                exact_selected_media: report.diagnosticCoverageOverride.exactSelectedMedia,
                profile_retention_bps: report.diagnosticCoverageOverride.profileRetentionBps,
                media_retention_bps: report.diagnosticCoverageOverride.mediaRetentionBps,
            },
        } : {}),
        total_elapsed_ms: report.totalElapsedMs,
        stages: Object.fromEntries(Object.entries(report.stages).map(([stage, values]) => [
            stage,
            {
                calls: values.calls,
                rate_limited: values.rateLimited,
                retries: values.retries,
                mean_latency_ms: values.meanLatencyMs,
                p50_latency_ms: values.p50LatencyMs,
                p95_latency_ms: values.p95LatencyMs,
                failure_disposition: values.failureDisposition,
            },
        ])),
        gender: report.gender,
        resolver: report.resolver,
    });
}

export async function runAnalysisV2AiReplay(input: {
    bundle: AnalysisV2ReplayBundle;
    runner?: ReplayAiRunner;
    mode: ReplayMode;
    paidAiOptIn?: boolean;
    diagnosticPartialCoverageCapability?:
        DiagnosticPartialCoverageCliCapability;
    featureConcurrencyExperimentCapability?:
        FeatureConcurrencyExperimentCliCapability;
    evaluationPolicy?: ReplayEvaluationPolicy;
    write?: (line: string) => void;
    /** Bounded post-abort telemetry bookkeeping only; it never grants resolver wait time. */
    resolverCutoffMs?: number;
    /** Incident-scoped consumers may retain full in-memory feature evidence without stdout. */
    onAccountAnalyzed?: (
        detail: ReplayAccountAiDetail,
    ) => void | Promise<void>;
}): Promise<AnalysisV2AiReplayReport> {
    const legacyBooleanSupplied = Object.prototype.hasOwnProperty.call(
        input,
        'allowLowPartialCoverage',
    );
    const diagnosticCapabilitySupplied =
        input.diagnosticPartialCoverageCapability !== undefined;
    if (
        legacyBooleanSupplied
        || (
            diagnosticCapabilitySupplied
            && !isDiagnosticPartialCoverageCliCapability(
                input.diagnosticPartialCoverageCapability,
            )
        )
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_AUTHORIZATION_REQUIRED',
        );
    }
    const diagnosticPartialCoverageAuthorized =
        diagnosticCapabilitySupplied;
    assertArtifactCapability(input.bundle);
    if (
        diagnosticPartialCoverageAuthorized
        && (
            input.bundle.schemaVersion !== 2
            || input.mode !== 'paid-ai'
        )
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_SCOPE_REQUIRED');
    }
    const paidPartialCoverage = input.bundle.schemaVersion === 2
        && input.mode === 'paid-ai'
        ? historicalPartialPaidCoverage({
            sourceUniverseDigest: input.bundle.capture.partial.sourceUniverseDigest,
            sourceIdentities: input.bundle.capture.partial.sourceIdentities,
            mediaUnavailable: input.bundle.capture.partial.mediaUnavailable,
            profiles: input.bundle.profiles,
        }, diagnosticPartialCoverageAuthorized
            ? { mode: 'diagnostic-low-partial-coverage' }
            : undefined)
        : undefined;
    if (
        paidPartialCoverage
        && !paidPartialCoverage.eligible
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_PARTIAL_COVERAGE_INSUFFICIENT');
    }
    assertReplayInput(input.bundle);
    const semanticInputFingerprint =
        analysisV2ReplaySemanticInputFingerprint(input.bundle);
    const authenticatedEvaluationPolicy = input.bundle.capture.evaluationPolicy;
    if (
        Boolean(authenticatedEvaluationPolicy) !== Boolean(input.evaluationPolicy)
        || (
            authenticatedEvaluationPolicy
            && input.evaluationPolicy
            && (
                authenticatedEvaluationPolicy.capability !== input.evaluationPolicy.capability
                || authenticatedEvaluationPolicy.aiStage !== input.evaluationPolicy.aiStage
            )
        )
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_MISMATCH');
    }
    const replayAiPolicy = resolveReplayAiStagePolicyVersion(
        input.bundle.capture.sourceLineage,
        input.evaluationPolicy,
    );
    const experimentScope = authenticatedEvaluationPolicy?.capability
        === CURRENT_PRODUCTION_STANDARD_V210_EXACT_REPLAY_CAPABILITY
        ? 'current-production'
        : authenticatedEvaluationPolicy?.capability
            === BETATEST_FREE_POOL_STANDARD_V210_EXACT_REPLAY_CAPABILITY
            ? 'betatest-free-pool'
            : undefined;
    const featureConcurrencyExperiment =
        input.featureConcurrencyExperimentCapability !== undefined;
    if (
        featureConcurrencyExperiment
        && (
            !isFeatureConcurrencyExperimentCliCapability(
                input.featureConcurrencyExperimentCapability,
            )
            || input.mode !== 'paid-ai'
            || input.bundle.schemaVersion !== 1
            || !experimentScope
            || input.featureConcurrencyExperimentCapability.scope !== experimentScope
        )
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_FEATURE_CONCURRENCY_SCOPE_REQUIRED');
    }
    const featureAnalysisConcurrency: 3 | 4 =
        featureConcurrencyExperiment ? 4 : 3;
    const supportsGenderTriageMicrobatch = aiStagePolicySupports(
        replayAiPolicy,
        'genderTriageMicrobatchV29',
    );
    if (input.mode === 'paid-ai' && input.paidAiOptIn !== true) {
        throw new Error('ANALYSIS_V2_REPLAY_PAID_AI_OPT_IN_REQUIRED');
    }
    const paidRunner = input.mode === 'paid-ai'
        ? await assertReplayAiRunnerPolicy(
            input.runner,
            replayAiPolicy,
            featureAnalysisConcurrency,
        )
        : undefined;
    const cutoffBookkeepingMs = input.resolverCutoffMs ?? 25;
    if (
        !Number.isInteger(cutoffBookkeepingMs)
        || cutoffBookkeepingMs < 0
        || cutoffBookkeepingMs > 1_000
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    }
    const replayStarted = performance.now();
    const names = ['genderTriage', 'featureAnalysis', 'privateAccountName', 'genderResolution'] as const;
    const stages = Object.fromEntries(names.map(name => [name, metrics()])) as AnalysisV2AiReplayReport['stages'];
    const durations = Object.fromEntries(names.map(name => [name, [] as number[]])) as Record<typeof names[number], number[]>;
    const gender = { male: 0, female: 0, unknown: 0, unknownRate: 0 };
    const resolver: AnalysisV2AiReplayReport['resolver'] = {
        ready: 0,
        applied: 0,
        inconclusive: 0,
        cutoff: 0,
        capacitySkipped: 0,
        admission: {
            eligible: 0,
            alreadyVerified: 0,
            officialOrGroup: 0,
            uncertainOrAbsent: 0,
            insufficientMedia: 0,
        },
        outcomes: {
            readyHighConfirmed: 0,
            evidenceInsufficient: 0,
            mixed: 0,
            unknown: 0,
            reconciliationApplied: 0,
            reconciliationInconclusive: 0,
            cutoff: 0,
            capacitySkipped: 0,
        },
    };
    const accountOutputs: ReplayAccountAiOutput[] = [];
    const appendAccountOutput = async (
        output: ReplayAccountAiOutput,
        detail: Pick<ReplayAccountAiDetail, 'triage' | 'feature'>,
    ): Promise<void> => {
        accountOutputs.push(output);
        await input.onAccountAnalyzed?.({ ...output, ...detail });
    };
    if (input.mode === 'paid-ai') {
        const runner = paidRunner!;
        const textOnly = input.bundle.schemaVersion === 1
            && input.bundle.capture.evaluationPolicy?.capability
                === TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY;
        const usesConciergeFirstPass = input.bundle.schemaVersion === 1
            && input.evaluationPolicy?.capability
                === FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY;
        // The text-only capability intentionally retains the source universe even
        // when old public media is unavailable. Those accounts must not enter AI.
        const publicProfiles = input.bundle.profiles.filter(profile => (
            !profile.isPrivate
            && (!textOnly || mediaFor(profile, profile.triageSelectionIds).length > 0)
        ));
        if (
            supportsGenderTriageMicrobatch
            && publicProfiles.some(profile => (
                typeof profile.hasProfileImage !== 'boolean'
            ))
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
        }
        const privateAccounts = input.bundle.profiles
            .filter(profile => profile.isPrivate)
            .map(profile => ({
                id: `ordinal:${profile.ordinal}`,
                username: profile.username,
                ...(profile.fullName ? { fullName: profile.fullName } : {}),
            }));
        let replayWorkFailed = false;
        const launchedResolvers: TrackedResolver[] = [];
        const observeRequiredTask = async <T>(task: Promise<T>): Promise<T> => {
            try {
                return await task;
            } catch (error) {
                replayWorkFailed = true;
                throw error;
            }
        };
        const privateTask = observeRequiredTask(privateAccounts.length && runner.privateNames
            ? runner.privateNames(privateAccounts).then(result => {
                collect(stages.privateAccountName, durations.privateAccountName, result);
            })
            : Promise.resolve());

        const nameOnlyProfiles = usesConciergeFirstPass
            ? publicProfiles.filter(profile => (
                profile.hasProfileImage === false
                && Boolean(profile.fullName?.trim())
            ))
            : [];
        const nameOnlyOrdinals = new Set(nameOnlyProfiles.map(profile => profile.ordinal));
        let nameOnlyInvocation: ReplayInvocation<readonly ReplayNameOnlyResult[]> | null = null;
        const nameOnlyTask = observeRequiredTask(
            nameOnlyProfiles.length > 0 && runner.nameOnly
                ? runner.nameOnly(nameOnlyProfiles.map(profile => ({
                    candidateId: `ordinal:${profile.ordinal}`,
                    fullName: profile.fullName!.trim(),
                }))).then(result => {
                    nameOnlyInvocation = result;
                    collect(stages.genderTriage, durations.genderTriage, result);
                    // A name-only batch covers many candidates at once. Reporting its
                    // failure as "unknown" for every covered candidate is the silent
                    // fallback that previously zeroed out an entire order's results.
                    // Fail the order closed instead so it is retried, with the cause
                    // recorded in the batch failure diagnostic.
                    if (result.outcome !== 'ok') {
                        throw new Error(
                            `ANALYSIS_V2_REPLAY_NAME_ONLY_BATCH_FAILED: outcome=${result.outcome}`,
                        );
                    }
                })
                : Promise.resolve(),
        );

        const prepared: PreparedPublicReplay[] = [];
        const v29AccountProfile = (
            profile: typeof publicProfiles[number],
        ): ReplayAccountProfile => {
            if (typeof profile.hasProfileImage !== 'boolean') {
                throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
            }
            return {
                fullName: profile.fullName,
                hasProfileImage: profile.hasProfileImage,
                bio: profile.bio ?? null,
            };
        };
        const processTriageResult = async (
            profile: typeof publicProfiles[number],
            triage: GenderTriageResult,
        ) => {
            if (replayWorkFailed) return;
            const canonicalResolverMedia = mediaFor(
                profile,
                profile.resolverSelectionIds,
            );
            const resolverMedia = supportsGenderTriageMicrobatch
                ? selectAnalysisV2GenderResolverMedia(canonicalResolverMedia)
                : canonicalResolverMedia;
            const v29ResolverAdmission = supportsGenderTriageMicrobatch
                ? v29GenderResolverAdmission(triage, resolverMedia.length)
                : null;
            if (v29ResolverAdmission === 'eligible') resolver.admission.eligible++;
            else if (v29ResolverAdmission === 'already_verified') {
                resolver.admission.alreadyVerified++;
            } else if (v29ResolverAdmission === 'official_or_group') {
                resolver.admission.officialOrGroup++;
            } else if (v29ResolverAdmission === 'uncertain_or_absent') {
                resolver.admission.uncertainOrAbsent++;
            } else if (v29ResolverAdmission === 'insufficient_media') {
                resolver.admission.insufficientMedia++;
            }
            if (triage.routingDecision === 'exclude_high_confidence_male') {
                gender.male++;
                await appendAccountOutput({
                    ordinal: profile.ordinal,
                    finalClassification: 'verified_non_female',
                    classificationSource: 'triage',
                    featureOverview: null,
                }, { triage, feature: null });
                return;
            }
            const featureMedia = selectReplayFeatureMedia(profile, profile.featureSelectionIds);
            const featureAdmitted = featureMedia.length > 0 && (!supportsGenderTriageMicrobatch
                || (
                    aiStagePolicySupports(replayAiPolicy, 'genderSummaryQualityV211')
                        ? v211FeatureAdmission(triage, profile)
                        : v29FeatureAdmission(triage, profile)
                ) === 'eligible');
            const featurePromise = featureAdmitted ? runner.feature?.({
                ordinal: profile.ordinal,
                bio: profile.bio ?? null,
                ...(supportsGenderTriageMicrobatch ? {
                    accountProfile: v29AccountProfile(profile),
                } : {}),
                media: featureMedia,
                captions: profile.captions,
                triage,
            }) : undefined;
            const assessment = triage.assessment;
            const eligible = supportsGenderTriageMicrobatch
                ? v29ResolverAdmission === 'eligible'
                : !(
                    assessment.inferredGender === 'female'
                    && assessment.confidence === 'high'
                    && assessment.ownerConsistency === 'same_person'
                );
            if (!featureAdmitted && !eligible) {
                gender.unknown++;
                await appendAccountOutput({
                    ordinal: profile.ordinal,
                    finalClassification: 'unresolved',
                    classificationSource: 'unknown',
                    featureOverview: null,
                }, { triage, feature: null });
                return;
            }
            const abort = new AbortController();
            let trackedResolver: TrackedResolver | undefined;
            if (eligible && runner.resolveGender) {
                trackedResolver = {
                    abort,
                    settled: false,
                    telemetry: {
                        calls: 0,
                        retries: 0,
                        rateLimited: 0,
                        attemptLatenciesMs: [],
                        failureDisposition: {},
                        pendingAttemptStartedAt: undefined,
                    },
                };
                launchedResolvers.push(trackedResolver);
                const resolverPromise = runner.resolveGender({
                    ordinal: profile.ordinal,
                    media: resolverMedia,
                    signal: abort.signal,
                    onAttemptStart: value => {
                        if (!trackedResolver) return;
                        trackedResolver.telemetry.calls++;
                        trackedResolver.telemetry.pendingAttemptStartedAt =
                            performance.now();
                        if (value.retryCount > 0) {
                            trackedResolver.telemetry.retries++;
                        }
                    },
                    onAttemptTelemetry: value => {
                        if (!trackedResolver) return;
                        trackedResolver.telemetry.attemptLatenciesMs.push(
                            Math.max(0, value.latencyMs),
                        );
                        trackedResolver.telemetry.pendingAttemptStartedAt =
                            undefined;
                        if (value.disposition === 'rate_limited') {
                            trackedResolver.telemetry.rateLimited++;
                        }
                        if (value.disposition !== 'success') {
                            const failures =
                                trackedResolver.telemetry.failureDisposition;
                            failures[value.disposition] =
                                (failures[value.disposition] ?? 0) + 1;
                        }
                    },
                });
                trackedResolver.promise = resolverPromise.then(value => {
                    trackedResolver!.settled = true;
                    trackedResolver!.value = value;
                    return value;
                });
                void trackedResolver.promise.catch(() => undefined);
            }
            const feature = featurePromise ? await featurePromise : undefined;
            if (feature) collect(stages.featureAnalysis, durations.featureAnalysis, feature);
            let baseline: ReplayBaselineClassification = featureAdmitted
                ? 'analysis_unavailable'
                : 'unresolved';
            if (feature?.outcome === 'ok' && feature.value) {
                baseline = feature.value.finalGenderDecision === 'verified_female'
                    ? 'verified_female'
                    : feature.value.finalGenderDecision === 'verified_non_female'
                        ? 'verified_non_female'
                        : feature.value.finalGenderDecision === 'unresolved_stage_conflict'
                            ? 'unresolved_stage_conflict'
                            : 'unresolved';
            }
            prepared.push({
                ordinal: profile.ordinal,
                baseline,
                triage,
                feature,
                resolver: trackedResolver,
            });
        };
        const publicTask = observeRequiredTask(runBounded(
            publicProfiles.filter(profile => !nameOnlyOrdinals.has(profile.ordinal)),
            supportsGenderTriageMicrobatch ? 6 : 4,
            async profile => {
                if (replayWorkFailed) return;
                let triage: ReplayInvocation<GenderTriageResult> | undefined;
                if (usesConciergeFirstPass) {
                    const fullName = profile.fullName?.trim() ?? '';
                    const firstPassMedia = mediaFor(profile, profile.triageSelectionIds)
                        .filter(item => item.kind === 'profile');
                    if (runner.firstPass && fullName && profile.hasProfileImage === true && firstPassMedia.length === 1) {
                        triage = await runner.firstPass({
                            ordinal: profile.ordinal,
                            fullName,
                            media: firstPassMedia,
                        });
                    } else if (runner.triage && fullName) {
                        triage = await runner.triage({
                            ordinal: profile.ordinal,
                            media: [],
                            ...(supportsGenderTriageMicrobatch
                                ? { accountProfile: v29AccountProfile(profile) }
                            : {}),
                        });
                    } else {
                        gender.unknown++;
                        await appendAccountOutput({
                            ordinal: profile.ordinal,
                            finalClassification: 'analysis_unavailable',
                            classificationSource: 'unknown',
                            featureOverview: null,
                        }, { triage: null, feature: null });
                        return;
                    }
                } else {
                    if (!runner.triage) return;
                    triage = await runner.triage({
                        ordinal: profile.ordinal,
                        media: mediaFor(profile, profile.triageSelectionIds),
                        ...(supportsGenderTriageMicrobatch
                            ? { accountProfile: v29AccountProfile(profile) }
                        : {}),
                    });
                }
                if (!triage) return;
                if (replayWorkFailed) return;
                collect(stages.genderTriage, durations.genderTriage, triage);
                if (triage.outcome !== 'ok' || !triage.value) {
                    gender.unknown++;
                    await appendAccountOutput({
                        ordinal: profile.ordinal,
                        finalClassification: 'analysis_unavailable',
                        classificationSource: 'unknown',
                        featureOverview: null,
                    }, { triage: null, feature: null });
                    return;
                }
                await processTriageResult(profile, triage.value);
            },
        ));
        try {
            await Promise.all([privateTask, publicTask, nameOnlyTask]);
        } catch (error) {
            await abortAndObserveResolvers(launchedResolvers, cutoffBookkeepingMs);
            throw error;
        }

        // The value is assigned by the observed promise callback above; keep
        // the snapshot explicit because TypeScript cannot follow that
        // assignment across the Promise.all boundary.
        const nameOnlyInvocationSnapshot = nameOnlyInvocation as unknown as
            ReplayInvocation<readonly ReplayNameOnlyResult[]> | null;
        const nameOnlyResults: readonly ReplayNameOnlyResult[] =
            nameOnlyInvocationSnapshot?.value ?? [];
        const nameOnlyResultsByCandidateId = new Map<string, ReplayNameOnlyResult>(
            nameOnlyResults.map(result => [result.candidateId, result] as const),
        );
        await Promise.all(nameOnlyProfiles.map(async profile => {
            const result = nameOnlyResultsByCandidateId.get(`ordinal:${profile.ordinal}`);
            if (!result) {
                gender.unknown++;
                await appendAccountOutput({
                    ordinal: profile.ordinal,
                    finalClassification: 'analysis_unavailable',
                    classificationSource: 'unavailable',
                    featureOverview: null,
                }, { triage: null, feature: null });
                return;
            }
            const triage = replayNameOnlyTriageResult(result);
            const finalClassification = result.gender === 'female'
                ? result.confidence === 'low' ? 'unresolved' : 'verified_female'
                : result.gender === 'male' ? 'verified_non_female' : 'unresolved';
            await appendAccountOutput({
                ordinal: profile.ordinal,
                finalClassification,
                classificationSource: 'name_only',
                featureOverview: null,
            }, { triage, feature: null });
            if (finalClassification === 'verified_female') gender.female++;
            else if (finalClassification === 'verified_non_female') gender.male++;
            else gender.unknown++;
        }));

        await Promise.all(prepared.map(async outcome => {
            let resolved: ReplayInvocation<GenderResolutionResult> | undefined;
            if (outcome.resolver?.settled) {
                resolved = outcome.resolver.value;
            } else if (outcome.resolver) {
                outcome.resolver.abort.abort();
                resolver.cutoff++;
                resolver.outcomes.cutoff++;
                collectCutoffResolver(
                    stages.genderResolution,
                    durations.genderResolution,
                    outcome.resolver,
                );
                let bookkeepingTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        outcome.resolver.promise!,
                        new Promise<undefined>(resolve => {
                            bookkeepingTimer = setTimeout(
                                () => resolve(undefined),
                                cutoffBookkeepingMs,
                            );
                        }),
                    ]);
                } finally {
                    if (bookkeepingTimer) clearTimeout(bookkeepingTimer);
                }
            }

            if (resolved) {
                collect(stages.genderResolution, durations.genderResolution, resolved);
                if (resolved.outcome === 'capacity_skipped') {
                    resolver.capacitySkipped++;
                    resolver.outcomes.capacitySkipped++;
                } else if (resolved.outcome === 'ok') {
                    resolver.ready++;
                    if (resolved.value) {
                        const readyOutcome =
                            analysisV2ReplayResolverReadyOutcome(resolved.value);
                        if (readyOutcome === 'ready_high_confirmed') {
                            resolver.outcomes.readyHighConfirmed++;
                        } else if (readyOutcome === 'evidence_insufficient') {
                            resolver.outcomes.evidenceInsufficient++;
                        } else {
                            resolver.outcomes[readyOutcome]++;
                        }
                    } else {
                        resolver.outcomes.unknown++;
                    }
                }
            }
            const reconciled = applyGenderResolution({
                baselineClassification: outcome.baseline,
                baselineSource: outcome.baseline === 'verified_female'
                    || outcome.baseline === 'verified_non_female'
                    ? 'feature'
                    : 'unknown',
                triage: outcome.triage.assessment,
                feature: outcome.feature?.value ?? null,
                resolver: resolved?.outcome === 'ok' ? resolved.value ?? null : null,
            });
            const reconciliation = usesConciergeFirstPass
                && reconciled.finalClassification === 'verified_female'
                && outcome.feature?.value === undefined
                ? {
                    finalClassification: 'unresolved' as const,
                    classificationSource: 'unknown' as const,
                    resolverApplied: false,
                }
                : reconciled;
            if (resolved?.outcome === 'ok') {
                if (reconciliation.resolverApplied) {
                    resolver.applied++;
                    resolver.outcomes.reconciliationApplied++;
                }
                else if (
                    outcome.baseline === 'unresolved'
                    || outcome.baseline === 'unresolved_stage_conflict'
                ) {
                    resolver.inconclusive++;
                    resolver.outcomes.reconciliationInconclusive++;
                }
            }
            await appendAccountOutput({
                ordinal: outcome.ordinal,
                finalClassification: reconciliation.finalClassification,
                classificationSource: reconciliation.classificationSource,
                featureOverview: reconciliation.finalClassification === 'verified_female'
                    ? outcome.feature?.value?.features.oneLineOverview ?? null
                    : null,
            }, {
                triage: outcome.triage,
                feature: outcome.feature?.value ?? null,
            });
            if (reconciliation.finalClassification === 'verified_female') gender.female++;
            else if (reconciliation.finalClassification === 'verified_non_female') gender.male++;
            else gender.unknown++;
        }));
    }
    // Stable ordinal order is required before a preview can be sealed.
    accountOutputs.sort((left, right) => left.ordinal - right.ordinal);
    const total = gender.male + gender.female + gender.unknown;
    gender.unknownRate = total ? Number((gender.unknown / total).toFixed(4)) : 0;
    for (const name of names) finalize(stages[name], durations[name]);
    const report = {
        benchmarkScope: input.bundle.schemaVersion === 2
            ? 'ai-only-historical-partial-available' as const
            : 'ai-only-exact-replay' as const,
        sourcePlan: input.bundle.capture.sourceLineage.selectedPlanId,
        sourcePipeline: input.bundle.capture.sourceLineage.policyVersions.pipeline,
        sourceAiPolicy: input.bundle.capture.sourceLineage.policyVersions.aiStage,
        sourceRiskPolicy: input.bundle.capture.sourceLineage.policyVersions.risk,
        evaluationAiPolicy: input.evaluationPolicy?.aiStage ?? null,
        replayAiPolicy,
        semanticInputFingerprint,
        fullE2eEvidence: false as const,
        sourceKind: experimentScope === 'current-production'
            ? 'current_paid_production' as const
            : experimentScope === 'betatest-free-pool'
                ? 'betatest_free_pool' as const
                : authenticatedEvaluationPolicy?.capability
                    === TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY
                    ? 'test_entitlement_v211_legacy_secondary' as const
                : authenticatedEvaluationPolicy?.capability
                    === TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY
                    ? 'test_entitlement_v211_legacy_secondary_text_only' as const
                : authenticatedEvaluationPolicy?.capability
                    === FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY
                    ? 'first_payment_basic_v211_concierge' as const
                : 'historical_or_legacy' as const,
        featureConcurrency: {
            experiment: featureConcurrencyExperiment
                ? 'feature-concurrency-4' as const
                : 'baseline' as const,
            featureAnalysis: featureAnalysisConcurrency,
            sharedCap: ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency,
        },
        ...(input.bundle.schemaVersion === 2 ? { notExact: true as const, noMediaSubstitution: true as const } : {}),
        ...(diagnosticPartialCoverageAuthorized && paidPartialCoverage ? {
            diagnosticCoverageOverride: {
                used: true as const,
                retainedProfiles: paidPartialCoverage.retainedProfiles,
                sourceProfiles: paidPartialCoverage.sourceProfiles,
                retainedMedia: paidPartialCoverage.retainedMedia,
                exactSelectedMedia: paidPartialCoverage.conservativeSourceMedia,
                profileRetentionBps: paidPartialCoverage.profileRetentionBps,
                mediaRetentionBps: paidPartialCoverage.mediaRetentionBps,
            },
        } : {}),
        stages,
        gender,
        resolver,
        totalElapsedMs: Math.round(performance.now() - replayStarted),
        accountOutputs,
    };
    input.write?.(safeLine(report));
    return report;
}
