import type {
    GenderResolutionResult,
    GenderTriageResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { selectAnalysisV2GenderResolverMedia } from '../v2-gender-resolver-media-policy';
import { v29GenderResolverAdmission } from '../v2-v29-gender-resolver-admission';
import type { ReplayAiRunner, ReplayMedia } from './replay-runner';
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
        existing: { attempted: number; succeeded: number; failed: number };
        uncertain: { attempted: number; succeeded: number; failed: number };
    };
    failureOutcomes: {
        rateLimited: number;
        rejected: number;
        failed: number;
        capacitySkipped: number;
        ambiguous: number;
    };
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
            admitted.push({ cohort: 'existing', ordinal: profile.ordinal, media: resolverMedia });
        } else if (
            admission === 'uncertain_or_absent'
            && triage.value.v29AccountContext === 'uncertain'
            && resolverMedia.length >= 2
            && admitted.filter(item => item.cohort === 'uncertain').length
                < input.bundle.capture.experiment.uncertainPilotLimit
        ) {
            admitted.push({ cohort: 'uncertain', ordinal: profile.ordinal, media: resolverMedia });
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
    const cohorts = {
        existing: { attempted: 0, succeeded: 0, failed: 0 },
        uncertain: { attempted: 0, succeeded: 0, failed: 0 },
    };
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
            if (abort.signal.aborted) break;
            if (result.outcome === 'ok' && result.value) {
                succeeded++;
                cohorts[candidate.cohort].succeeded++;
                if (highConfidence(result.value)) resolvedHighConfidence++;
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
        failureOutcomes,
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
