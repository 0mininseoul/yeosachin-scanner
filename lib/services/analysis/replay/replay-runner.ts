import type { FeatureAnalysisResult, GenderResolutionResult, GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import { applyGenderResolution } from '@/lib/services/ai/gender-resolution-reconciliation';
import type { PrivateNameAccountInput } from '@/lib/services/ai/private-name-analysis';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import {
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
} from './replay-source-lineage';
import { v29FeatureAdmission } from '../v2-v29-feature-admission';
import { v29GenderResolverAdmission } from '../v2-v29-gender-resolver-admission';
import { selectAnalysisV2GenderResolverMedia } from '../v2-gender-resolver-media-policy';
import { historicalPartialBundleInvariantIssues, historicalPartialPaidCoverage } from './historical-partial-available-artifact';

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
    latencyMs: number;
}
export interface ReplayStageMetrics {
    calls: number; rateLimited: number; retries: number; meanLatencyMs: number; p50LatencyMs: number; p95LatencyMs: number; failureDisposition: Record<string, number>;
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
    if (
        (bundle.schemaVersion === 1 && capability === HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY)
        || (bundle.schemaVersion === 2 && capability !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY)
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
    evaluationPolicy?: ReplayEvaluationPolicy;
    write?: (line: string) => void;
    /** Bounded post-abort telemetry bookkeeping only; it never grants resolver wait time. */
    resolverCutoffMs?: number;
}): Promise<AnalysisV2AiReplayReport> {
    assertArtifactCapability(input.bundle);
    if (
        input.bundle.schemaVersion === 2
        && input.mode === 'paid-ai'
        && !historicalPartialPaidCoverage({
            sourceUniverseDigest: input.bundle.capture.partial.sourceUniverseDigest,
            sourceIdentities: input.bundle.capture.partial.sourceIdentities,
            mediaUnavailable: input.bundle.capture.partial.mediaUnavailable,
            profiles: input.bundle.profiles,
        }).eligible
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
    if (input.mode === 'paid-ai') {
        const runner = paidRunner!;
        const publicProfiles = input.bundle.profiles.filter(
            profile => !profile.isPrivate,
        );
        if (
            replayAiPolicy === 'ai-stage-policy-v2.9'
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
        ) => {
            if (replayWorkFailed) return;
            const canonicalResolverMedia = mediaFor(
                profile,
                profile.resolverSelectionIds,
            );
            const resolverMedia = replayAiPolicy === 'ai-stage-policy-v2.9'
                ? selectAnalysisV2GenderResolverMedia(canonicalResolverMedia)
                : canonicalResolverMedia;
            const v29ResolverAdmission = replayAiPolicy === 'ai-stage-policy-v2.9'
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
                return;
            }
            const featureAdmitted = replayAiPolicy !== 'ai-stage-policy-v2.9'
                || v29FeatureAdmission(triage, profile) === 'eligible';
            const featurePromise = featureAdmitted ? runner.feature?.({
                ordinal: profile.ordinal,
                bio: profile.bio ?? null,
                ...(replayAiPolicy === 'ai-stage-policy-v2.9' ? {
                    accountProfile: v29AccountProfile(profile),
                } : {}),
                media: mediaFor(profile, profile.featureSelectionIds),
                captions: profile.captions,
                triage,
            }) : undefined;
            const assessment = triage.assessment;
            const eligible = replayAiPolicy === 'ai-stage-policy-v2.9'
                ? v29ResolverAdmission === 'eligible'
                : !(
                    assessment.inferredGender === 'female'
                    && assessment.confidence === 'high'
                    && assessment.ownerConsistency === 'same_person'
                );
            if (!featureAdmitted && !eligible) {
                gender.unknown++;
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
                baseline,
                triage,
                feature,
                resolver: trackedResolver,
            });
        };
        const publicTask = observeRequiredTask(runBounded(
            publicProfiles,
            replayAiPolicy === 'ai-stage-policy-v2.9' ? 6 : 4,
            async profile => {
                if (replayWorkFailed) return;
                if (!runner.triage) return;
                const triage = await runner.triage({
                    ordinal: profile.ordinal,
                    media: mediaFor(profile, profile.triageSelectionIds),
                    ...(replayAiPolicy === 'ai-stage-policy-v2.9'
                        ? { accountProfile: v29AccountProfile(profile) }
                        : {}),
                });
                if (replayWorkFailed) return;
                collect(stages.genderTriage, durations.genderTriage, triage);
                if (triage.outcome !== 'ok' || !triage.value) {
                    gender.unknown++;
                    return;
                }
                await processTriageResult(profile, triage.value);
            },
        ));
        try {
            await Promise.all([privateTask, publicTask]);
        } catch (error) {
            await abortAndObserveResolvers(launchedResolvers, cutoffBookkeepingMs);
            throw error;
        }

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
            const reconciliation = applyGenderResolution({
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
        }));
    }
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
        fullE2eEvidence: false as const,
        ...(input.bundle.schemaVersion === 2 ? { notExact: true as const, noMediaSubstitution: true as const } : {}),
        stages,
        gender,
        resolver,
        totalElapsedMs: Math.round(performance.now() - replayStarted),
    };
    input.write?.(safeLine(report));
    return report;
}
