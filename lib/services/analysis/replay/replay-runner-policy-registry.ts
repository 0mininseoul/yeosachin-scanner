import type { ReplayAiRunner } from './replay-runner';
import type { ReplaySupportedAiStagePolicyVersion } from './replay-source-lineage';

interface IssuedReplayRunner {
    policyVersion: ReplaySupportedAiStagePolicyVersion;
    triage: ReplayAiRunner['triage'];
    feature: ReplayAiRunner['feature'];
    privateNames: ReplayAiRunner['privateNames'];
    resolveGender: ReplayAiRunner['resolveGender'];
}

const issuedReplayRunners = new WeakMap<ReplayAiRunner, IssuedReplayRunner>();

export function registerReplayAiRunnerPolicy(
    runner: ReplayAiRunner,
    policyVersion: ReplaySupportedAiStagePolicyVersion,
): void {
    issuedReplayRunners.set(runner, {
        policyVersion,
        triage: runner.triage,
        feature: runner.feature,
        privateNames: runner.privateNames,
        resolveGender: runner.resolveGender,
    });
}

/** Non-issuing lookup used by the paid runner admission check. */
export function lookupReplayAiRunnerPolicy(
    runner: ReplayAiRunner,
): ReplaySupportedAiStagePolicyVersion | undefined {
    const issued = issuedReplayRunners.get(runner);
    if (
        !issued
        || !Object.isFrozen(runner)
        || runner.triage !== issued.triage
        || runner.feature !== issued.feature
        || runner.privateNames !== issued.privateNames
        || runner.resolveGender !== issued.resolveGender
    ) {
        return undefined;
    }
    return issued.policyVersion;
}
