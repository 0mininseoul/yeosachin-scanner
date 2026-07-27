import { createHash } from 'node:crypto';
import {
    STRONG_UNCERTAIN_RESOLVER_EXPERIMENT,
    STRONG_UNCERTAIN_RESOLVER_EXPERIMENT_CAPABILITY,
    parseStrongUncertainResolverExperimentBundle,
    type AnalysisV2ReplayBundle,
} from './replay-bundle';
import { HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY } from './replay-source-lineage';

export {
    STRONG_UNCERTAIN_RESOLVER_EXPERIMENT,
    STRONG_UNCERTAIN_RESOLVER_EXPERIMENT_CAPABILITY,
};

export type HistoricalPartialReplayBundle = Extract<
    AnalysisV2ReplayBundle,
    { schemaVersion: 2 }
>;
export type StrongUncertainResolverExperimentBundle = Extract<
    AnalysisV2ReplayBundle,
    { schemaVersion: 3 }
>;

function parentBinding(parent: HistoricalPartialReplayBundle): string {
    return createHash('sha256').update(JSON.stringify({
        schemaVersion: parent.schemaVersion,
        requestFingerprint: parent.capture.requestFingerprint,
        sourceLineage: parent.capture.sourceLineage,
        sourceUniverseDigest: parent.capture.partial.sourceUniverseDigest,
        evaluationPolicy: parent.capture.evaluationPolicy,
    })).digest('hex');
}

export function deriveStrongUncertainResolverExperiment(
    parent: HistoricalPartialReplayBundle,
): StrongUncertainResolverExperimentBundle {
    if (
        parent.schemaVersion !== 2
        || parent.capture.scope !== 'ai-only-historical-partial-available'
        || parent.capture.evaluationPolicy.capability
            !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY
        || parent.capture.evaluationPolicy.aiStage !== 'ai-stage-policy-v2.9'
    ) {
        throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_PARENT_MISMATCH');
    }
    return {
        ...parent,
        schemaVersion: 3,
        capture: {
            ...parent.capture,
            scope: 'ai-only-resolver-experiment',
            notProduction: true,
            evaluationPolicy: {
                capability: STRONG_UNCERTAIN_RESOLVER_EXPERIMENT_CAPABILITY,
                aiStage: 'ai-stage-policy-v2.9',
            },
            experiment: {
                id: STRONG_UNCERTAIN_RESOLVER_EXPERIMENT,
                parentSchemaVersion: 2,
                parentRequestFingerprint: parent.capture.requestFingerprint,
                parentBinding: parentBinding(parent),
                sourceUniverseDigest: parent.capture.partial.sourceUniverseDigest,
                evaluationAiStage: 'ai-stage-policy-v2.9',
                existingEligibleLimit: 40,
                uncertainPilotLimit: 24,
                totalResolverLimit: 64,
                maxResolverAttempts: 256,
                candidateOrder: 'source_ordinal_ascending',
            },
        },
    };
}

export function assertStrongUncertainResolverExperiment(
    bundle: AnalysisV2ReplayBundle,
): asserts bundle is StrongUncertainResolverExperimentBundle {
    parseStrongUncertainResolverExperimentBundle(bundle);
}
