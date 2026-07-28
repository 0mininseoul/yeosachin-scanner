import type {
    GenderResolutionResult,
    GenderTriageResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { selectAnalysisV2GenderResolverMedia } from '../v2-gender-resolver-media-policy';
import { v29GenderResolverAdmission } from '../v2-v29-gender-resolver-admission';
import type {
    ReplayAiRunner,
    ReplayInvocation,
    ReplayMedia,
    ReplayStageMetrics,
} from './replay-runner';
import {
    assertStrongUncertainResolverExperiment,
    type StrongUncertainResolverExperimentBundle,
} from './resolver-experiment-artifact';
import { isStrongUncertainResolverExperimentAdapter } from './resolver-experiment-ai-adapter';

export const STRONG_UNCERTAIN_RESOLVER_CONFIG = Object.freeze({
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'HIGH',
    mediaResolution: 'HIGH',
    maxOutputTokens: 2_048,
    mediaProjection: 'existing-five-image-projection',
    concurrency: 2,
} as const);

type DiagnosticOutcomeHistogram = {
    ok: number;
    rateLimited: number;
    retryExhausted: number;
    rejected: number;
    failed: number;
    capacitySkipped: number;
};

type ResolverCohortDiagnostics = {
    selected: number;
    outcomes: DiagnosticOutcomeHistogram;
    highConfidence: { applied: number; inconclusive: number };
};

/**
 * Deliberately fixed-key, aggregate-only cohort diagnostics. It cannot carry
 * candidate content, model content, or media references.
 */
export interface ResolverExperimentDiagnostics {
    triageOutcomes: DiagnosticOutcomeHistogram;
    accountContextAdmission: {
        alreadyVerified: number;
        officialOrGroup: number;
        uncertainOrAbsent: number;
        insufficientMedia: number;
        eligible: number;
    };
    resolverCohorts: {
        existing: ResolverCohortDiagnostics;
        uncertain: ResolverCohortDiagnostics;
    };
}

export interface ResolverExperimentReport {
    experimentId: 'strong-uncertain-v1';
    evaluationAiStage: 'ai-stage-policy-v2.9';
    sourceProfiles: number;
    triaged: number;
    existingEligible: number;
    uncertainPilotSelected: number;
    attempted: number;
    succeeded: number;
    failed: number;
    finalUnknown: number;
    resolvedHighConfidence: number;
    inconclusive: number;
    cohorts: {
        existing: {
            attempted: number; succeeded: number; failed: number;
            resolverTelemetry: ReplayStageMetrics;
        };
        uncertain: {
            attempted: number; succeeded: number; failed: number;
            resolverTelemetry: ReplayStageMetrics;
        };
    };
    resolverTelemetry: ReplayStageMetrics;
    failureOutcomes: {
        rateLimited: number;
        rejected: number;
        failed: number;
        capacitySkipped: number;
        ambiguous: number;
    };
    diagnostics: ResolverExperimentDiagnostics;
    limits: {
        existingEligible: 40;
        uncertainPilot: 24;
        totalResolvers: 64;
        maxAttempts: 256;
        maxOutputTokens: 2048;
        maxBudgetedOutputTokens: 524288;
    };
    preflightPassed: true;
}

function diagnosticOutcomes(): DiagnosticOutcomeHistogram {
    return {
        ok: 0,
        rateLimited: 0,
        retryExhausted: 0,
        rejected: 0,
        failed: 0,
        capacitySkipped: 0,
    };
}

function recordDiagnosticOutcome(
    histogram: DiagnosticOutcomeHistogram,
    outcome: ReplayInvocation<unknown>['outcome'],
): void {
    switch (outcome) {
    case 'ok': histogram.ok++; break;
    case 'rate_limited': histogram.rateLimited++; break;
    case 'retry_exhausted': histogram.retryExhausted++; break;
    case 'rejected': histogram.rejected++; break;
    case 'failed': histogram.failed++; break;
    case 'capacity_skipped': histogram.capacitySkipped++; break;
    }
}

function resolverCohortDiagnostics(): ResolverCohortDiagnostics {
    return {
        selected: 0,
        outcomes: diagnosticOutcomes(),
        highConfidence: { applied: 0, inconclusive: 0 },
    };
}

function mediaFor(
    profile: StrongUncertainResolverExperimentBundle['profiles'][number],
    ids: readonly string[],
): ReplayMedia[] {
    const wanted = new Set(ids);
    return profile.media.filter(item => wanted.has(item.selectionId))
        .map(item => ({ ...item }));
}

function highConfidence(result: GenderResolutionResult): boolean {
    const assessment = result.assessment;
    return assessment.ownerConsistency === 'same_person'
        && assessment.confidence === 'high'
        && assessment.inferredGender !== 'unknown'
        && new Set(assessment.evidenceSelectionIds).size >= 2;
}

function emptyResolverTelemetry(): ReplayStageMetrics {
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

function collectResolverTelemetry(
    stage: ReplayStageMetrics,
    durations: number[],
    invocation: ReplayInvocation<unknown>,
): void {
    const calls = invocation.calls ?? 1;
    stage.calls += calls;
    stage.retries += Math.max(0, invocation.retries);
    stage.rateLimited += invocation.rateLimited
        ?? (invocation.outcome === 'rate_limited' ? 1 : 0);
    const attemptLatencies = invocation.attemptLatenciesMs?.filter(
        value => Number.isFinite(value) && value >= 0,
    );
    if (attemptLatencies?.length) durations.push(...attemptLatencies);
    else if (calls > 0) durations.push(Math.max(0, invocation.elapsedMs));
    const recordedFailures = Object.entries(invocation.failureDisposition ?? {})
        .filter(([, count]) => Number.isInteger(count) && count > 0);
    for (const [disposition, count] of recordedFailures) {
        stage.failureDisposition[disposition] =
            (stage.failureDisposition[disposition] ?? 0) + count;
    }
    if (invocation.outcome !== 'ok' && recordedFailures.length === 0) {
        stage.failureDisposition[invocation.outcome] =
            (stage.failureDisposition[invocation.outcome] ?? 0) + 1;
    }
}

function percentile(values: readonly number[], fraction: number): number {
    if (!values.length) return 0;
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[
        Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)
    ] ?? 0;
}

function finalizeResolverTelemetry(
    stage: ReplayStageMetrics,
    durations: readonly number[],
): void {
    if (!durations.length) return;
    stage.meanLatencyMs = Math.round(
        durations.reduce((sum, value) => sum + value, 0) / durations.length,
    );
    stage.p50LatencyMs = percentile(durations, 0.5);
    stage.p95LatencyMs = percentile(durations, 0.95);
}

export async function runStrongUncertainResolverExperiment(input: {
    bundle: StrongUncertainResolverExperimentBundle;
    runner: Pick<ReplayAiRunner, 'triage' | 'resolveGender'>;
    signal?: AbortSignal;
}): Promise<ResolverExperimentReport> {
    assertStrongUncertainResolverExperiment(input.bundle);
    if (
        !input.runner.triage
        || !input.runner.resolveGender
        || !isStrongUncertainResolverExperimentAdapter(input.runner)
    ) {
        throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_RUNNER_INVALID');
    }
    const profiles = input.bundle.profiles
        .filter(profile => !profile.isPrivate)
        .sort((left, right) => left.ordinal - right.ordinal);
    const admitted: Array<{
        cohort: 'existing' | 'uncertain';
        ordinal: number;
        media: ReplayMedia[];
    }> = [];
    const diagnostics: ResolverExperimentDiagnostics = {
        triageOutcomes: diagnosticOutcomes(),
        accountContextAdmission: {
            alreadyVerified: 0,
            officialOrGroup: 0,
            uncertainOrAbsent: 0,
            insufficientMedia: 0,
            eligible: 0,
        },
        resolverCohorts: {
            existing: resolverCohortDiagnostics(),
            uncertain: resolverCohortDiagnostics(),
        },
    };
    let triaged = 0;
    const triageInputs = profiles.map(profile => {
        const triageMedia = mediaFor(profile, profile.triageSelectionIds);
        return {
            profile,
            promise: input.runner.triage!({
            ordinal: profile.ordinal,
            media: triageMedia,
            accountProfile: {
                fullName: profile.fullName,
                hasProfileImage: profile.hasProfileImage ?? false,
                bio: profile.bio ?? null,
            },
            }),
        };
    });
    const triageResults = await Promise.all(
        triageInputs.map(async ({ profile, promise }) => ({ profile, triage: await promise })),
    );
    for (const { profile, triage } of triageResults) {
        if (input.signal?.aborted) throw input.signal.reason;
        recordDiagnosticOutcome(diagnostics.triageOutcomes, triage.outcome);
        if (triage.outcome !== 'ok' || !triage.value) {
            throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_TRIAGE_FAILED');
        }
        triaged++;
        const resolverMedia = selectAnalysisV2GenderResolverMedia(
            mediaFor(profile, profile.resolverSelectionIds),
        );
        const admission = v29GenderResolverAdmission(
            triage.value as GenderTriageResult,
            resolverMedia.length,
        );
        if (admission === 'eligible') {
            diagnostics.accountContextAdmission.eligible++;
            diagnostics.resolverCohorts.existing.selected++;
            admitted.push({ cohort: 'existing', ordinal: profile.ordinal, media: resolverMedia });
        } else if (admission === 'already_verified') {
            diagnostics.accountContextAdmission.alreadyVerified++;
        } else if (admission === 'official_or_group') {
            diagnostics.accountContextAdmission.officialOrGroup++;
        } else if (
            admission === 'uncertain_or_absent'
            && triage.value.v29AccountContext === 'uncertain'
            && resolverMedia.length >= 2
            && admitted.filter(item => item.cohort === 'uncertain').length
                < input.bundle.capture.experiment.uncertainPilotLimit
        ) {
            diagnostics.accountContextAdmission.uncertainOrAbsent++;
            diagnostics.resolverCohorts.uncertain.selected++;
            admitted.push({ cohort: 'uncertain', ordinal: profile.ordinal, media: resolverMedia });
        } else if (admission === 'uncertain_or_absent') {
            diagnostics.accountContextAdmission.uncertainOrAbsent++;
        } else {
            diagnostics.accountContextAdmission.insufficientMedia++;
        }
    }
    const existingEligible = admitted.filter(item => item.cohort === 'existing').length;
    const uncertainPilotSelected = admitted.length - existingEligible;
    if (
        existingEligible > input.bundle.capture.experiment.existingEligibleLimit
        || admitted.length > input.bundle.capture.experiment.totalResolverLimit
        || admitted.length * 4 > input.bundle.capture.experiment.maxResolverAttempts
    ) {
        throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_COST_BOUND_EXCEEDED');
    }
    let next = 0;
    let succeeded = 0;
    let failed = 0;
    let resolvedHighConfidence = 0;
    const resolverTelemetry = emptyResolverTelemetry();
    const resolverDurations: number[] = [];
    const cohorts = {
        existing: {
            attempted: 0, succeeded: 0, failed: 0,
            resolverTelemetry: emptyResolverTelemetry(),
        },
        uncertain: {
            attempted: 0, succeeded: 0, failed: 0,
            resolverTelemetry: emptyResolverTelemetry(),
        },
    };
    const cohortDurations = { existing: [] as number[], uncertain: [] as number[] };
    const failureOutcomes = {
        rateLimited: 0,
        rejected: 0,
        failed: 0,
        capacitySkipped: 0,
        ambiguous: 0,
    };
    let fatalError: unknown;
    const abort = new AbortController();
    input.signal?.addEventListener('abort', () => abort.abort(input.signal?.reason), { once: true });
    const worker = async () => {
        while (next < admitted.length && fatalError === undefined) {
            if (abort.signal.aborted) break;
            const candidate = admitted[next++];
            cohorts[candidate.cohort].attempted++;
            let result;
            try {
                result = await input.runner.resolveGender!({
                    ordinal: candidate.ordinal,
                    media: candidate.media,
                    signal: abort.signal,
                });
            } catch (error) {
                if (fatalError === undefined) {
                    fatalError = error;
                    abort.abort(error);
                }
                break;
            }
            collectResolverTelemetry(resolverTelemetry, resolverDurations, result);
            collectResolverTelemetry(
                cohorts[candidate.cohort].resolverTelemetry,
                cohortDurations[candidate.cohort],
                result,
            );
            recordDiagnosticOutcome(
                diagnostics.resolverCohorts[candidate.cohort].outcomes,
                result.outcome,
            );
            if (abort.signal.aborted) break;
            if (result.outcome === 'ok' && result.value) {
                succeeded++;
                cohorts[candidate.cohort].succeeded++;
                if (highConfidence(result.value)) {
                    resolvedHighConfidence++;
                    diagnostics.resolverCohorts[candidate.cohort].highConfidence.applied++;
                } else {
                    diagnostics.resolverCohorts[candidate.cohort].highConfidence.inconclusive++;
                }
            } else {
                failed++;
                cohorts[candidate.cohort].failed++;
                if (result.outcome === 'rate_limited') failureOutcomes.rateLimited++;
                else if (result.outcome === 'rejected') failureOutcomes.rejected++;
                else if (result.outcome === 'capacity_skipped') {
                    failureOutcomes.capacitySkipped++;
                } else {
                    failureOutcomes.failed++;
                }
                failureOutcomes.ambiguous += result.failureDisposition?.ambiguous ?? 0;
            }
        }
    };
    await Promise.all(Array.from(
        { length: Math.min(STRONG_UNCERTAIN_RESOLVER_CONFIG.concurrency, admitted.length) },
        worker,
    ));
    if (fatalError !== undefined) throw fatalError;
    finalizeResolverTelemetry(resolverTelemetry, resolverDurations);
    finalizeResolverTelemetry(
        cohorts.existing.resolverTelemetry,
        cohortDurations.existing,
    );
    finalizeResolverTelemetry(
        cohorts.uncertain.resolverTelemetry,
        cohortDurations.uncertain,
    );
    const inconclusive = succeeded - resolvedHighConfidence;
    return {
        experimentId: 'strong-uncertain-v1',
        evaluationAiStage: 'ai-stage-policy-v2.9',
        sourceProfiles: profiles.length,
        triaged,
        existingEligible,
        uncertainPilotSelected,
        attempted: admitted.length,
        succeeded,
        failed,
        finalUnknown: admitted.length - resolvedHighConfidence,
        resolvedHighConfidence,
        inconclusive,
        cohorts,
        resolverTelemetry,
        failureOutcomes,
        diagnostics,
        limits: {
            existingEligible: 40,
            uncertainPilot: 24,
            totalResolvers: 64,
            maxAttempts: 256,
            maxOutputTokens: 2048,
            maxBudgetedOutputTokens: 524288,
        },
        preflightPassed: true,
    };
}
