import type { AnalysisV2ReplayBundle } from './replay-bundle';

export type ReplayMode = 'dry-run' | 'paid-ai';
export type ReplayOutcome = 'ok' | 'rate_limited' | 'retry_exhausted' | 'rejected' | 'failed';

export interface ReplayInvocation<T> {
    outcome: ReplayOutcome;
    value?: T;
    attempts: number;
    retries: number;
    elapsedMs: number;
}

export interface ReplayAiRunner {
    triage?(input: { ordinal: number; media: readonly ReplayMedia[] }): Promise<ReplayInvocation<{ inferredGender: 'male' | 'female' | 'unknown'; routeToFeature: boolean }>>;
    feature?(input: { ordinal: number; bio: string | null; media: readonly ReplayMedia[] }): Promise<ReplayInvocation<unknown>>;
    privateName?(input: { ordinal: number }): Promise<ReplayInvocation<unknown>>;
    resolveGender?(input: { ordinal: number; media: readonly ReplayMedia[] }): Promise<ReplayInvocation<{ applied: boolean }>>;
}

export interface ReplayMedia {
    selectionId: string;
    caption?: string | null;
    jpegBase64: string;
}

export interface ReplayStageMetrics {
    calls: number;
    rateLimited: number;
    retries: number;
    meanLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    failureDisposition: Record<string, number>;
}

export interface AnalysisV2AiReplayReport {
    stages: Record<'genderTriage' | 'featureAnalysis' | 'privateAccountName' | 'genderResolution', ReplayStageMetrics>;
    gender: { male: number; female: number; unknown: number; unknownRate: number };
    resolver: { ready: number; applied: number; inconclusive: number; cutoff: number };
}

function metrics(): ReplayStageMetrics {
    return { calls: 0, rateLimited: 0, retries: 0, meanLatencyMs: 0, p50LatencyMs: 0, p95LatencyMs: 0, failureDisposition: {} };
}

function percentile(values: number[], percentileValue: number): number {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * percentileValue) - 1))] ?? 0;
}

function collect(stage: ReplayStageMetrics, durations: number[], invocation: ReplayInvocation<unknown>): void {
    stage.calls++;
    stage.retries += Math.max(0, invocation.retries);
    durations.push(Math.max(0, invocation.elapsedMs));
    if (invocation.outcome === 'rate_limited') stage.rateLimited++;
    if (invocation.outcome !== 'ok') stage.failureDisposition[invocation.outcome] = (stage.failureDisposition[invocation.outcome] ?? 0) + 1;
}

function finalize(stage: ReplayStageMetrics, durations: number[]): void {
    if (!durations.length) return;
    stage.meanLatencyMs = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
    stage.p50LatencyMs = percentile(durations, 0.5);
    stage.p95LatencyMs = percentile(durations, 0.95);
}

function safeLine(report: AnalysisV2AiReplayReport): string {
    return JSON.stringify({
        status: 'ok',
        stages: Object.fromEntries(Object.entries(report.stages).map(([stage, values]) => [stage, {
            calls: values.calls, rate_limited: values.rateLimited, retries: values.retries,
            mean_latency_ms: values.meanLatencyMs, p50_latency_ms: values.p50LatencyMs, p95_latency_ms: values.p95LatencyMs,
            failure_disposition: values.failureDisposition,
        }])),
        gender: report.gender,
        resolver: report.resolver,
    });
}

/**
 * AI-only runner: accepts an already decrypted in-memory bundle and injected staged AI functions.
 * It intentionally imports no provider, database, R2, archive, job, or result-store module.
 */
export async function runAnalysisV2AiReplay(input: {
    bundle: AnalysisV2ReplayBundle;
    runner: ReplayAiRunner;
    mode: ReplayMode;
    paidAiOptIn?: boolean;
    write?: (line: string) => void;
}): Promise<AnalysisV2AiReplayReport> {
    if (input.mode === 'paid-ai' && input.paidAiOptIn !== true) {
        throw new Error('ANALYSIS_V2_REPLAY_PAID_AI_OPT_IN_REQUIRED');
    }
    const stageNames = ['genderTriage', 'featureAnalysis', 'privateAccountName', 'genderResolution'] as const;
    const stages = Object.fromEntries(stageNames.map(name => [name, metrics()])) as AnalysisV2AiReplayReport['stages'];
    const durations = Object.fromEntries(stageNames.map(name => [name, [] as number[]])) as Record<typeof stageNames[number], number[]>;
    const gender = { male: 0, female: 0, unknown: 0, unknownRate: 0 };
    const resolver = { ready: 0, applied: 0, inconclusive: 0, cutoff: 0 };

    for (const profile of input.bundle.profiles) {
        if (input.mode === 'dry-run') continue;
        if (profile.isPrivate) {
            if (input.runner.privateName) collect(stages.privateAccountName, durations.privateAccountName, await input.runner.privateName({ ordinal: profile.ordinal }));
            continue;
        }
        if (!input.runner.triage) continue;
        const triage = await input.runner.triage({ ordinal: profile.ordinal, media: profile.media });
        collect(stages.genderTriage, durations.genderTriage, triage);
        if (triage.outcome !== 'ok' || !triage.value) continue;
        gender[triage.value.inferredGender]++;
        if (triage.value.routeToFeature && input.runner.feature) {
            collect(stages.featureAnalysis, durations.featureAnalysis, await input.runner.feature({ ordinal: profile.ordinal, bio: profile.bio ?? null, media: profile.media }));
        }
        if (triage.value.inferredGender === 'unknown' && input.runner.resolveGender) {
            resolver.ready++;
            const resolution = await input.runner.resolveGender({ ordinal: profile.ordinal, media: profile.media });
            collect(stages.genderResolution, durations.genderResolution, resolution);
            if (resolution.outcome === 'ok' && resolution.value?.applied) resolver.applied++;
            else resolver.inconclusive++;
        }
    }
    const totalGender = gender.male + gender.female + gender.unknown;
    gender.unknownRate = totalGender ? Number((gender.unknown / totalGender).toFixed(4)) : 0;
    for (const name of stageNames) finalize(stages[name], durations[name]);
    const report = { stages, gender, resolver };
    input.write?.(safeLine(report));
    return report;
}
