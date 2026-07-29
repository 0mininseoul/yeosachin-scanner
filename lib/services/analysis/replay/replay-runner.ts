import type { FeatureAnalysisResult, GenderResolutionResult, GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import {
    GEMINI_GENERATION_FAILURE_KINDS,
    type GeminiGenerationFailureKind,
} from '@/lib/services/ai/gemini-generation-policy';
import { applyGenderResolution } from '@/lib/services/ai/gender-resolution-reconciliation';
import {
    AI_STAGE_POLICY_V212_VERSION,
    aiStagePolicySupports,
} from '@/lib/services/ai/stage-policy';
import type { PrivateNameAccountInput } from '@/lib/services/ai/private-name-analysis';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import {
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
} from './replay-source-lineage';
import { v29FeatureAdmission } from '../v2-v29-feature-admission';
import {
    v211FeatureAdmission,
    v211FeatureResolverExcluded,
} from '../v2-v211-feature-admission';
import { v29GenderResolverAdmission } from '../v2-v29-gender-resolver-admission';
import { v211LateGenderResolverEligible } from '../v2-v211-gender-resolver-admission';
import { selectAnalysisV2GenderResolverMedia } from '../v2-gender-resolver-media-policy';
import { historicalPartialBundleInvariantIssues, historicalPartialPaidCoverage } from './historical-partial-available-artifact';
import {
    isDiagnosticPartialCoverageCliCapability,
    type DiagnosticPartialCoverageCliCapability,
} from './diagnostic-partial-coverage-capability';
import { evaluateReplayGenderQualityGate } from './replay-gender-quality-gate';

export type ReplayMode = 'dry-run' | 'paid-ai';
export type ReplayOutcome = 'ok' | 'rate_limited' | 'retry_exhausted' | 'rejected' | 'failed' | 'capacity_skipped';
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

export interface ReplayInvocation<T> {
    outcome: ReplayOutcome;
    value?: T;
    calls?: number;
    rateLimited?: number;
    failureDisposition?: Readonly<Record<string, number>>;
    failureKind?: Readonly<Partial<Record<GeminiGenerationFailureKind, number>>>;
    triageSource?: 'checkpoint' | 'safe_fallback';
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

export interface ReplayAccountProfile {
    fullName: string | null;
    hasProfileImage: boolean;
    bio: string | null;
}

export interface ReplayAiRunner {
    triage?(input: ReplayTriageInput): Promise<ReplayInvocation<GenderTriageResult>>;
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
): Promise<ReplayAiRunner> {
    const { lookupReplayStagedAiAdapterPolicy } = await import(
        './replay-staged-ai-adapter'
    );
    if (!runner || lookupReplayStagedAiAdapterPolicy(runner) !== expected) {
        throw new Error('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
    }
    return runner;
}

export interface ReplayCaption { evidenceRefId: string; selectionId: string; text: string; }
export interface ReplayAttemptStart { attempt: number; retryCount: number; }
export interface ReplayAttemptTelemetry extends ReplayAttemptStart {
    disposition: string;
    failureKind?: GeminiGenerationFailureKind;
    latencyMs: number;
}
export interface ReplayStageMetrics {
    calls: number; rateLimited: number; retries: number; meanLatencyMs: number; p50LatencyMs: number; p95LatencyMs: number; failureDisposition: Record<string, number>; failureKind?: Partial<Record<GeminiGenerationFailureKind, number>>;
}
export interface AnalysisV2AiReplayReport {
    benchmarkScope: 'ai-only-exact-replay' | 'ai-only-historical-partial-available';
    sourcePlan: 'standard' | 'plus';
    sourcePipeline: 'v2';
    sourceAiPolicy: string;
    sourceRiskPolicy: string;
    evaluationAiPolicy: string | null;
    replayAiPolicy: string;
    fullE2eEvidence: false;
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
    /** v2.11-only, aggregate and deliberately PII-free quality observability. */
    genderQuality?: {
        triage: {
            nonOk: number;
            capacity: number;
            outcome: Record<string, number>;
            source: Record<string, number>;
            genderConfidence: Record<string, number>;
            accountContext: Record<string, number>;
        };
        feature: {
            admission: Record<string, number>;
            finalDecision: Record<string, number>;
            accountContext: Record<string, number>;
            routeTerminal: Record<string, number>;
        };
        resolver: { earlyAdmission: number; lateAdmission: number; outcome: Record<string, number> };
        finalClassificationSource: Record<string, number>;
        qualityGate: ReturnType<typeof evaluateReplayGenderQualityGate>;
    };
    totalElapsedMs: number;
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
    settlement?: Promise<ResolverSettlement>;
    settled: boolean;
    value?: ReplayInvocation<GenderResolutionResult>;
    telemetry: {
        calls: number;
        retries: number;
        rateLimited: number;
        attemptLatenciesMs: number[];
        failureDisposition: Record<string, number>;
        failureKind: Partial<Record<GeminiGenerationFailureKind, number>>;
        pendingAttemptStartedAt?: number;
    };
}

type ResolverSettlement =
    | { status: 'fulfilled' }
    | { status: 'rejected'; error: unknown };

const V212_RESOLVER_SETTLEMENT_DEFAULT_MS = 50;
const V212_RESOLVER_SETTLEMENT_TIMEOUT_CODE =
    'ANALYSIS_V2_REPLAY_RESOLVER_SETTLEMENT_TIMEOUT';

interface PreparedPublicReplay {
    baseline: ReplayBaselineClassification;
    triage: GenderTriageResult;
    feature?: ReplayInvocation<FeatureAnalysisResult>;
    resolver?: TrackedResolver;
    resolverExcludedByFeatureOfficial?: boolean;
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

/**
 * v2.12 waits briefly after cutoff solely to distinguish a normal abort
 * settlement from a raw fault. The timeout remains bounded and never turns
 * the opportunistic resolver into required provider work.
 */
async function awaitV212ResolverSettlement(
    resolver: TrackedResolver,
    timeoutMs: number,
): Promise<void> {
    if (!resolver.settlement) {
        throw new Error(V212_RESOLVER_SETTLEMENT_TIMEOUT_CODE);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const settlement = await Promise.race([
            resolver.settlement,
            new Promise<{ status: 'timeout' }>(resolve => {
                timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
            }),
        ]);
        if (settlement.status === 'timeout') {
            throw new Error(V212_RESOLVER_SETTLEMENT_TIMEOUT_CODE);
        }
        if (settlement.status === 'rejected') throw settlement.error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function awaitResolverCutoffBookkeeping(
    resolver: TrackedResolver,
    timeoutMs: number,
    strictV212ResolverSettlement: boolean,
): Promise<void> {
    if (strictV212ResolverSettlement) {
        await awaitV212ResolverSettlement(resolver, timeoutMs);
        return;
    }
    if (!resolver.promise) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            resolver.promise,
            new Promise<undefined>(resolve => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function metrics(includeFailureKind: boolean): ReplayStageMetrics {
    return {
        calls: 0,
        rateLimited: 0,
        retries: 0,
        meanLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        failureDisposition: {},
        ...(includeFailureKind ? { failureKind: {} } : {}),
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
        || capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY
        || capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY
        || capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY;
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
    if (stage.failureKind) {
        for (const kind of GEMINI_GENERATION_FAILURE_KINDS) {
            const count = invocation.failureKind?.[kind];
            if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) continue;
            stage.failureKind[kind] = (stage.failureKind[kind] ?? 0) + count;
        }
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
    if (stage.failureKind) {
        for (const kind of GEMINI_GENERATION_FAILURE_KINDS) {
            const count = tracked.telemetry.failureKind[kind];
            if (!count) continue;
            stage.failureKind[kind] = (stage.failureKind[kind] ?? 0) + count;
        }
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
            !profile.media.length
            || !profile.triageSelectionIds.length
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
            || (!profile.isPrivate && (
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

function mediaFor(profile: AnalysisV2ReplayBundle['profiles'][number], ids: readonly string[]): ReplayMedia[] {
    const allowed = new Set(ids);
    return profile.media.filter(item => allowed.has(item.selectionId));
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
        full_e2e_evidence: report.fullE2eEvidence,
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
                ...(report.replayAiPolicy === AI_STAGE_POLICY_V212_VERSION
                    ? { failure_kind: values.failureKind ?? {} }
                    : {}),
            },
        ])),
        gender: report.gender,
        resolver: report.resolver,
        ...(report.genderQuality ? { gender_quality: report.genderQuality } : {}),
    });
}

export async function runAnalysisV2AiReplay(input: {
    bundle: AnalysisV2ReplayBundle;
    runner?: ReplayAiRunner;
    mode: ReplayMode;
    paidAiOptIn?: boolean;
    diagnosticPartialCoverageCapability?:
        DiagnosticPartialCoverageCliCapability;
    evaluationPolicy?: ReplayEvaluationPolicy;
    write?: (line: string) => void;
    /**
     * Bounded post-abort telemetry bookkeeping only; it never grants resolver
     * provider time. Exact v2.12 uses the same override for its abort-settlement
     * window (50ms by default) so delayed raw faults cannot outlive success.
     */
    resolverCutoffMs?: number;
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
    const supportsGenderTriageMicrobatch = aiStagePolicySupports(
        replayAiPolicy,
        'genderTriageMicrobatchV29',
    );
    const genderQualityV211 = aiStagePolicySupports(
        replayAiPolicy,
        'genderQualityV211',
    );
    const strictV212ResolverSettlement =
        replayAiPolicy === AI_STAGE_POLICY_V212_VERSION;
    if (input.mode === 'paid-ai' && input.paidAiOptIn !== true) {
        throw new Error('ANALYSIS_V2_REPLAY_PAID_AI_OPT_IN_REQUIRED');
    }
    const paidRunner = input.mode === 'paid-ai'
        ? await assertReplayAiRunnerPolicy(input.runner, replayAiPolicy)
        : undefined;
    const cutoffBookkeepingMs = input.resolverCutoffMs ?? 25;
    if (
        !Number.isInteger(cutoffBookkeepingMs)
        || cutoffBookkeepingMs < 0
        || cutoffBookkeepingMs > 1_000
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    }
    const resolverSettlementMs = strictV212ResolverSettlement
        ? input.resolverCutoffMs ?? V212_RESOLVER_SETTLEMENT_DEFAULT_MS
        : cutoffBookkeepingMs;
    const replayStarted = performance.now();
    const names = ['genderTriage', 'featureAnalysis', 'privateAccountName', 'genderResolution'] as const;
    const stages = Object.fromEntries(names.map(name => [
        name,
        metrics(strictV212ResolverSettlement),
    ])) as AnalysisV2AiReplayReport['stages'];
    const durations = Object.fromEntries(names.map(name => [name, [] as number[]])) as Record<typeof names[number], number[]>;
    const gender = { male: 0, female: 0, unknown: 0, unknownRate: 0 };
    const genderQuality = genderQualityV211 ? {
        triage: {
            nonOk: 0,
            capacity: 0,
            outcome: {} as Record<string, number>,
            source: {} as Record<string, number>,
            genderConfidence: {} as Record<string, number>,
            accountContext: {} as Record<string, number>,
        },
        feature: {
            admission: {} as Record<string, number>,
            finalDecision: {} as Record<string, number>,
            accountContext: {} as Record<string, number>,
            routeTerminal: {} as Record<string, number>,
        },
        resolver: { earlyAdmission: 0, lateAdmission: 0, outcome: {} as Record<string, number> },
        finalClassificationSource: {} as Record<string, number>,
    } : null;
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
    if (input.mode === 'paid-ai') {
        const runner = paidRunner!;
        const publicProfiles = input.bundle.profiles.filter(
            profile => !profile.isPrivate,
        );
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
            triageSource: 'checkpoint' | 'safe_fallback' | 'unknown',
        ) => {
            if (replayWorkFailed) return;
            const canonicalResolverMedia = mediaFor(
                profile,
                profile.resolverSelectionIds,
            );
            const resolverMedia = supportsGenderTriageMicrobatch
                ? selectAnalysisV2GenderResolverMedia(
                    canonicalResolverMedia,
                    replayAiPolicy,
                )
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
            if (genderQuality) {
                const context = triage.v29AccountContext ?? 'absent';
                const genderConfidence = `${triage.assessment.inferredGender}:${triage.assessment.confidence}`;
                genderQuality.triage.outcome.ok = (genderQuality.triage.outcome.ok ?? 0) + 1;
                genderQuality.triage.source[triageSource] =
                    (genderQuality.triage.source[triageSource] ?? 0) + 1;
                genderQuality.triage.genderConfidence[genderConfidence] =
                    (genderQuality.triage.genderConfidence[genderConfidence] ?? 0) + 1;
                genderQuality.triage.accountContext[context] =
                    (genderQuality.triage.accountContext[context] ?? 0) + 1;
            }
            if (triage.routingDecision === 'exclude_high_confidence_male') {
                if (genderQuality) {
                    genderQuality.finalClassificationSource.triage =
                        (genderQuality.finalClassificationSource.triage ?? 0) + 1;
                    genderQuality.feature.routeTerminal.not_routed_high_male =
                        (genderQuality.feature.routeTerminal.not_routed_high_male ?? 0) + 1;
                }
                gender.male++;
                return;
            }
            const featureAdmission = !supportsGenderTriageMicrobatch
                ? 'eligible'
                : (genderQualityV211
                    ? v211FeatureAdmission(triage, profile)
                    : v29FeatureAdmission(triage, profile));
            const featureAdmitted = featureAdmission === 'eligible';
            if (genderQuality) {
                genderQuality.feature.admission[featureAdmission] =
                    (genderQuality.feature.admission[featureAdmission] ?? 0) + 1;
            }
            const featurePromise = featureAdmitted ? runner.feature?.({
                ordinal: profile.ordinal,
                bio: profile.bio ?? null,
                ...(supportsGenderTriageMicrobatch ? {
                    accountProfile: v29AccountProfile(profile),
                } : {}),
                media: mediaFor(profile, profile.featureSelectionIds),
                captions: profile.captions,
                triage,
            }) : undefined;
            const assessment = triage.assessment;
            const eligible = !(
                genderQualityV211
                && featureAdmission === 'nonpersonal_or_official'
            ) && (supportsGenderTriageMicrobatch
                ? v29ResolverAdmission === 'eligible'
                : !(
                    assessment.inferredGender === 'female'
                    && assessment.confidence === 'high'
                    && assessment.ownerConsistency === 'same_person'
                ));
            if (!featureAdmitted && !eligible) {
                if (genderQuality) {
                    genderQuality.finalClassificationSource.unknown =
                        (genderQuality.finalClassificationSource.unknown ?? 0) + 1;
                    genderQuality.feature.routeTerminal.excluded_official =
                        (genderQuality.feature.routeTerminal.excluded_official ?? 0) + 1;
                }
                gender.unknown++;
                return;
            }
            const abort = new AbortController();
            let trackedResolver: TrackedResolver | undefined;
            const startResolver = () => {
                if (trackedResolver || !runner.resolveGender) return;
                const tracked: TrackedResolver = {
                    abort,
                    settled: false,
                    telemetry: {
                        calls: 0,
                        retries: 0,
                        rateLimited: 0,
                        attemptLatenciesMs: [],
                        failureDisposition: {},
                        failureKind: {},
                        pendingAttemptStartedAt: undefined,
                    },
                };
                trackedResolver = tracked;
                launchedResolvers.push(tracked);
                const resolverPromise = runner.resolveGender({
                    ordinal: profile.ordinal,
                    media: resolverMedia,
                    signal: abort.signal,
                    onAttemptStart: value => {
                        tracked.telemetry.calls++;
                        tracked.telemetry.pendingAttemptStartedAt =
                            performance.now();
                        if (value.retryCount > 0) {
                            tracked.telemetry.retries++;
                        }
                    },
                    onAttemptTelemetry: value => {
                        tracked.telemetry.attemptLatenciesMs.push(
                            Math.max(0, value.latencyMs),
                        );
                        tracked.telemetry.pendingAttemptStartedAt =
                            undefined;
                        if (value.disposition === 'rate_limited') {
                            tracked.telemetry.rateLimited++;
                        }
                        if (value.disposition !== 'success') {
                            const failures =
                                tracked.telemetry.failureDisposition;
                            failures[value.disposition] =
                                (failures[value.disposition] ?? 0) + 1;
                        }
                        if (value.failureKind) {
                            const kinds = tracked.telemetry.failureKind;
                            kinds[value.failureKind] =
                                (kinds[value.failureKind] ?? 0) + 1;
                        }
                    },
                });
                tracked.promise = resolverPromise.then(value => {
                    tracked.settled = true;
                    tracked.value = value;
                    return value;
                });
                if (strictV212ResolverSettlement) {
                    tracked.settlement = tracked.promise.then(
                        () => ({ status: 'fulfilled' as const }),
                        error => ({ status: 'rejected' as const, error }),
                    );
                }
                void tracked.promise.catch(() => undefined);
            };
            if (eligible) {
                if (genderQuality) genderQuality.resolver.earlyAdmission++;
                startResolver();
            }
            const feature = featurePromise ? await featurePromise : undefined;
            if (feature) collect(stages.featureAnalysis, durations.featureAnalysis, feature);
            if (genderQuality && featureAdmitted) {
                const terminal = feature?.outcome === 'ok' && feature.value
                    ? 'completed'
                    : 'provider_non_ok';
                genderQuality.feature.routeTerminal[terminal] =
                    (genderQuality.feature.routeTerminal[terminal] ?? 0) + 1;
            }
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
                if (genderQuality) {
                    const decision = feature.value.finalGenderDecision;
                    const context = feature.value.features.accountContext;
                    genderQuality.feature.finalDecision[decision] =
                        (genderQuality.feature.finalDecision[decision] ?? 0) + 1;
                    genderQuality.feature.accountContext[context] =
                        (genderQuality.feature.accountContext[context] ?? 0) + 1;
                }
            }
            const resolverExcludedByFeatureOfficial = genderQualityV211
                && feature?.outcome === 'ok'
                && feature.value !== undefined
                && v211FeatureResolverExcluded(feature.value.features.accountContext);
            if (resolverExcludedByFeatureOfficial && trackedResolver) {
                // Abort immediately after feature's collective context arrives.
                // The finalizer records this as an excluded resolver outcome and
                // deliberately ignores even a racing ready result.
                trackedResolver.abort.abort();
            }
            if (
                genderQualityV211
                && !trackedResolver
                && !resolverExcludedByFeatureOfficial
                && feature?.outcome === 'ok'
                && feature.value
                && v211LateGenderResolverEligible(
                    triage,
                    feature.value.features.accountContext,
                    baseline === 'unresolved_stage_conflict'
                        ? 'unresolved_stage_conflict'
                        : baseline === 'unresolved'
                            ? 'unresolved'
                            : 'verified_non_female',
                    resolverMedia.length,
                )
            ) {
                if (genderQuality) genderQuality.resolver.lateAdmission++;
                startResolver();
            }
            prepared.push({
                baseline,
                triage,
                feature,
                resolver: trackedResolver,
                ...(resolverExcludedByFeatureOfficial
                    ? { resolverExcludedByFeatureOfficial: true }
                    : {}),
            });
        };
        const publicTask = observeRequiredTask(runBounded(
            publicProfiles,
            supportsGenderTriageMicrobatch ? 6 : 4,
            async profile => {
                if (replayWorkFailed) return;
                if (!runner.triage) return;
                const triage = await runner.triage({
                    ordinal: profile.ordinal,
                    media: mediaFor(profile, profile.triageSelectionIds),
                    ...(supportsGenderTriageMicrobatch
                        ? { accountProfile: v29AccountProfile(profile) }
                        : {}),
                });
                if (replayWorkFailed) return;
                collect(stages.genderTriage, durations.genderTriage, triage);
                if (triage.outcome !== 'ok' || !triage.value) {
                    if (genderQuality) {
                        genderQuality.triage.nonOk++;
                        genderQuality.triage.outcome[triage.outcome] =
                            (genderQuality.triage.outcome[triage.outcome] ?? 0) + 1;
                        genderQuality.triage.source.non_ok =
                            (genderQuality.triage.source.non_ok ?? 0) + 1;
                        if (triage.outcome === 'capacity_skipped') genderQuality.triage.capacity++;
                        genderQuality.finalClassificationSource.triage_non_ok =
                            (genderQuality.finalClassificationSource.triage_non_ok ?? 0) + 1;
                        genderQuality.feature.routeTerminal.triage_non_ok =
                            (genderQuality.feature.routeTerminal.triage_non_ok ?? 0) + 1;
                    }
                    gender.unknown++;
                    return;
                }
                await processTriageResult(
                    profile,
                    triage.value,
                    triage.triageSource ?? 'unknown',
                );
            },
        ));
        try {
            await Promise.all([privateTask, publicTask]);
        } catch (error) {
            await abortAndObserveResolvers(launchedResolvers, cutoffBookkeepingMs);
            throw error;
        }

        await Promise.all(prepared.map(async outcome => {
            // Let an already-admitted resolver complete its synchronous local
            // path before deciding it missed the opportunistic window. This is
            // one event-loop turn, not a provider wait: unresolved work is
            // still aborted immediately below.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            let resolved: ReplayInvocation<GenderResolutionResult> | undefined;
            if (outcome.resolverExcludedByFeatureOfficial && outcome.resolver) {
                if (outcome.resolver.settled && outcome.resolver.value) {
                    // The call may have won the race just before feature
                    // completed. Keep its PII-free cost/latency telemetry but
                    // never pass the result to reconciliation.
                    collect(
                        stages.genderResolution,
                        durations.genderResolution,
                        outcome.resolver.value,
                    );
                } else {
                    outcome.resolver.abort.abort();
                    resolver.cutoff++;
                    resolver.outcomes.cutoff++;
                    collectCutoffResolver(
                        stages.genderResolution,
                        durations.genderResolution,
                        outcome.resolver,
                    );
                    await awaitResolverCutoffBookkeeping(
                        outcome.resolver,
                        resolverSettlementMs,
                        strictV212ResolverSettlement,
                    );
                }
                if (genderQuality) {
                    genderQuality.resolver.outcome.official_excluded =
                        (genderQuality.resolver.outcome.official_excluded ?? 0) + 1;
                }
            } else if (outcome.resolver?.settled) {
                resolved = outcome.resolver.value;
            } else if (outcome.resolver) {
                outcome.resolver.abort.abort();
                resolver.cutoff++;
                resolver.outcomes.cutoff++;
                if (genderQuality) {
                    genderQuality.resolver.outcome.cutoff =
                        (genderQuality.resolver.outcome.cutoff ?? 0) + 1;
                }
                collectCutoffResolver(
                    stages.genderResolution,
                    durations.genderResolution,
                    outcome.resolver,
                );
                await awaitResolverCutoffBookkeeping(
                    outcome.resolver,
                    resolverSettlementMs,
                    strictV212ResolverSettlement,
                );
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
            const reconciliation = applyGenderResolution({
                aiStagePolicyVersion: replayAiPolicy,
                baselineClassification: outcome.baseline,
                baselineSource: outcome.baseline === 'verified_female'
                    || outcome.baseline === 'verified_non_female'
                    ? 'feature'
                    : 'unknown',
                triage: outcome.triage.assessment,
                feature: outcome.feature?.value ?? null,
                resolver: resolved?.outcome === 'ok' ? resolved.value ?? null : null,
            });
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
            if (reconciliation.finalClassification === 'verified_female') gender.female++;
            else if (reconciliation.finalClassification === 'verified_non_female') gender.male++;
            else gender.unknown++;
            if (genderQuality) {
                const source = reconciliation.classificationSource;
                genderQuality.finalClassificationSource[source] =
                    (genderQuality.finalClassificationSource[source] ?? 0) + 1;
                if (resolved?.outcome) {
                    genderQuality.resolver.outcome[resolved.outcome] =
                        (genderQuality.resolver.outcome[resolved.outcome] ?? 0) + 1;
                }
            }
        }));
    }
    const total = gender.male + gender.female + gender.unknown;
    if (genderQuality) {
        const sum = (values: Readonly<Record<string, number>>) => Object.values(values)
            .reduce((total, value) => total + value, 0);
        const observedPublic = input.bundle.profiles.filter(profile => !profile.isPrivate).length;
        const triageOutcomes = sum(genderQuality.triage.outcome);
        const triageSources = sum(genderQuality.triage.source);
        const finalSources = sum(genderQuality.finalClassificationSource);
        const resolverAdmissions = genderQuality.resolver.earlyAdmission
            + genderQuality.resolver.lateAdmission;
        const resolverOutcomes = sum(genderQuality.resolver.outcome);
        const featureRouteTerminals = sum(genderQuality.feature.routeTerminal);
        const featureAdmitted = genderQuality.feature.admission.eligible ?? 0;
        const featureCompleted = genderQuality.feature.routeTerminal.completed ?? 0;
        const featureProviderNonOk =
            genderQuality.feature.routeTerminal.provider_non_ok ?? 0;
        if (
            total !== observedPublic
            || triageOutcomes !== observedPublic
            || triageSources !== observedPublic
            || finalSources !== observedPublic
            || resolverAdmissions !== resolverOutcomes
            || featureRouteTerminals !== observedPublic
            || featureAdmitted !== featureCompleted + featureProviderNonOk
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_GENDER_QUALITY_CONSERVATION_FAILED');
        }
    }
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
        fullE2eEvidence: false as const,
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
        ...(genderQuality ? {
            genderQuality: {
                ...genderQuality,
                qualityGate: evaluateReplayGenderQualityGate({
                    ...gender,
                    missingPublic: input.bundle.schemaVersion === 2
                        ? Math.max(0, input.bundle.capture.partial.sourceIdentities.filter(
                            identity => identity.partition === 'public'
                                || identity.partition === 'fetch_terminal',
                        ).length - input.bundle.profiles.filter(
                            profile => !profile.isPrivate,
                        ).length)
                        : 0,
                }),
            },
        } : {}),
        totalElapsedMs: Math.round(performance.now() - replayStarted),
    };
    input.write?.(safeLine(report));
    return report;
}
