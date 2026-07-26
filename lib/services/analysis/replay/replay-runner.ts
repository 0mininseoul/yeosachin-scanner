import { applyGenderResolution, type FeatureAnalysisResult, type GenderResolutionResult, type GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import type { PrivateNameAccountInput } from '@/lib/services/ai/private-name-analysis';
import type { AnalysisV2ReplayBundle } from './replay-bundle';

export type ReplayMode = 'dry-run' | 'paid-ai';
export type ReplayOutcome = 'ok' | 'rate_limited' | 'retry_exhausted' | 'rejected' | 'failed' | 'capacity_skipped';

export interface ReplayInvocation<T> {
    outcome: ReplayOutcome;
    value?: T;
    calls?: number;
    rateLimited?: number;
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

export interface ReplayAiRunner {
    triage?(input: { ordinal: number; media: readonly ReplayMedia[] }): Promise<ReplayInvocation<GenderTriageResult>>;
    feature?(input: { ordinal: number; bio: string | null; media: readonly ReplayMedia[]; captions: readonly ReplayCaption[]; triage: GenderTriageResult }): Promise<ReplayInvocation<FeatureAnalysisResult>>;
    privateNames?(input: readonly PrivateNameAccountInput[]): Promise<ReplayInvocation<unknown>>;
    resolveGender?(input: { ordinal: number; media: readonly ReplayMedia[]; signal: AbortSignal }): Promise<ReplayInvocation<GenderResolutionResult>>;
}

export interface ReplayCaption { evidenceRefId: string; selectionId: string; text: string; }
export interface ReplayStageMetrics {
    calls: number; rateLimited: number; retries: number; meanLatencyMs: number; p50LatencyMs: number; p95LatencyMs: number; failureDisposition: Record<string, number>;
}
export interface AnalysisV2AiReplayReport {
    stages: Record<'genderTriage' | 'featureAnalysis' | 'privateAccountName' | 'genderResolution', ReplayStageMetrics>;
    gender: { male: number; female: number; unknown: number; unknownRate: number };
    resolver: { ready: number; applied: number; inconclusive: number; cutoff: number; capacitySkipped: number };
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
    promise: Promise<ReplayInvocation<GenderResolutionResult>>;
    settled: boolean;
    value?: ReplayInvocation<GenderResolutionResult>;
}

interface PreparedPublicReplay {
    baseline: ReplayBaselineClassification;
    triage: GenderTriageResult;
    feature?: ReplayInvocation<FeatureAnalysisResult>;
    resolver?: TrackedResolver;
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

function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)] ?? 0;
}

function collect(stage: ReplayStageMetrics, durations: number[], invocation: ReplayInvocation<unknown>): void {
    stage.calls += invocation.calls ?? 1;
    stage.retries += Math.max(0, invocation.retries);
    durations.push(Math.max(0, invocation.elapsedMs));
    stage.rateLimited += invocation.rateLimited
        ?? (invocation.outcome === 'rate_limited' ? 1 : 0);
    if (invocation.outcome !== 'ok') {
        stage.failureDisposition[invocation.outcome] =
            (stage.failureDisposition[invocation.outcome] ?? 0) + 1;
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
        const invalidCoverage = profile.coverage.selectedCount !== profile.media.length
            || profile.coverage.normalizedCount !== profile.media.length
            || profile.coverage.failures.length > 0;
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
    runner: ReplayAiRunner;
    mode: ReplayMode;
    paidAiOptIn?: boolean;
    write?: (line: string) => void;
    /** Bounded post-abort telemetry bookkeeping only; it never grants resolver wait time. */
    resolverCutoffMs?: number;
}): Promise<AnalysisV2AiReplayReport> {
    assertReplayInput(input.bundle);
    if (input.mode === 'paid-ai' && input.paidAiOptIn !== true) {
        throw new Error('ANALYSIS_V2_REPLAY_PAID_AI_OPT_IN_REQUIRED');
    }
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
    const resolver = { ready: 0, applied: 0, inconclusive: 0, cutoff: 0, capacitySkipped: 0 };
    if (input.mode === 'paid-ai') {
        const privateAccounts = input.bundle.profiles
            .filter(profile => profile.isPrivate)
            .map(profile => ({
                id: `ordinal:${profile.ordinal}`,
                username: profile.username,
                ...(profile.fullName ? { fullName: profile.fullName } : {}),
            }));
        const privateTask = privateAccounts.length && input.runner.privateNames
            ? input.runner.privateNames(privateAccounts).then(result => {
                collect(stages.privateAccountName, durations.privateAccountName, result);
            })
            : Promise.resolve();

        const prepared: PreparedPublicReplay[] = [];
        const publicTask = runBounded(
            input.bundle.profiles.filter(profile => !profile.isPrivate),
            4,
            async profile => {
            if (!input.runner.triage) return;
            const triage = await input.runner.triage({
                ordinal: profile.ordinal,
                media: mediaFor(profile, profile.triageSelectionIds),
            });
            collect(stages.genderTriage, durations.genderTriage, triage);
            if (triage.outcome !== 'ok' || !triage.value) {
                gender.unknown++;
                return;
            }
            if (triage.value.routingDecision === 'exclude_high_confidence_male') {
                gender.male++;
                return;
            }
            const featurePromise = input.runner.feature?.({
                ordinal: profile.ordinal,
                bio: profile.bio ?? null,
                media: mediaFor(profile, profile.featureSelectionIds),
                captions: profile.captions,
                triage: triage.value,
            });
            const assessment = triage.value.assessment;
            const eligible = !(
                assessment.inferredGender === 'female'
                && assessment.confidence === 'high'
                && assessment.ownerConsistency === 'same_person'
            );
            const abort = new AbortController();
            const resolverPromise = eligible && input.runner.resolveGender
                ? input.runner.resolveGender({
                    ordinal: profile.ordinal,
                    media: mediaFor(profile, profile.resolverSelectionIds),
                    signal: abort.signal,
                })
                : undefined;
            let trackedResolver: TrackedResolver | undefined;
            if (resolverPromise) {
                trackedResolver = {
                    abort,
                    settled: false,
                } as TrackedResolver;
                trackedResolver.promise = resolverPromise.then(value => {
                    trackedResolver!.settled = true;
                    trackedResolver!.value = value;
                    return value;
                });
            }
            const feature = featurePromise ? await featurePromise : undefined;
            if (feature) collect(stages.featureAnalysis, durations.featureAnalysis, feature);
            let baseline: ReplayBaselineClassification = 'analysis_unavailable';
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
                triage: triage.value,
                feature,
                resolver: trackedResolver,
            });
        });
        await Promise.all([privateTask, publicTask]);

        await Promise.all(prepared.map(async outcome => {
            let resolved: ReplayInvocation<GenderResolutionResult> | undefined;
            if (outcome.resolver?.settled) {
                resolved = outcome.resolver.value;
            } else if (outcome.resolver) {
                outcome.resolver.abort.abort();
                resolver.cutoff++;
                let bookkeepingTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const afterAbort = await Promise.race([
                        outcome.resolver.promise.then(value => ({ value })),
                        new Promise<{ value: undefined }>(resolve => {
                            bookkeepingTimer = setTimeout(
                                () => resolve({ value: undefined }),
                                cutoffBookkeepingMs,
                            );
                        }),
                    ]);
                    if (afterAbort.value) {
                        collect(
                            stages.genderResolution,
                            durations.genderResolution,
                            afterAbort.value,
                        );
                    }
                } finally {
                    if (bookkeepingTimer) clearTimeout(bookkeepingTimer);
                }
            }

            if (resolved) {
                collect(stages.genderResolution, durations.genderResolution, resolved);
                if (resolved.outcome === 'capacity_skipped') resolver.capacitySkipped++;
                else if (resolved.outcome === 'ok') resolver.ready++;
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
                if (reconciliation.resolverApplied) resolver.applied++;
                else if (
                    outcome.baseline === 'unresolved'
                    || outcome.baseline === 'unresolved_stage_conflict'
                ) resolver.inconclusive++;
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
        stages,
        gender,
        resolver,
        totalElapsedMs: Math.round(performance.now() - replayStarted),
    };
    input.write?.(safeLine(report));
    return report;
}
