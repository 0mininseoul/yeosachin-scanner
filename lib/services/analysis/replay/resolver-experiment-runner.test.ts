import { describe, expect, it, vi } from 'vitest';

vi.mock('./resolver-experiment-ai-adapter', () => ({
    isStrongUncertainResolverExperimentAdapter: () => true,
}));

import { historicalPartialSourceUniverseDigest } from './historical-partial-available-artifact';
import { deriveStrongUncertainResolverExperiment } from './resolver-experiment-artifact';
import { runStrongUncertainResolverExperiment } from './resolver-experiment-runner';
import type { ReplayAiRunner, ReplayOutcome } from './replay-runner';

function sealedSensitiveBundle() {
    const sourceIdentities = [{
        ordinal: 1, username: 'sensitive_username', partition: 'public' as const,
    }];
    return deriveStrongUncertainResolverExperiment({
        schemaVersion: 2,
        createdAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-07-27T01:00:00.000Z',
        capture: {
            requestFingerprint: 'a'.repeat(64),
            scope: 'ai-only-historical-partial-available',
            notExact: true, fullE2eEvidence: false, noMediaSubstitution: true,
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2', aiStage: 'ai-stage-policy-v2.7',
                    risk: 'risk-policy-v2.3',
                },
            },
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
            partial: {
                sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                sourceIdentities, mediaUnavailable: [],
            },
        },
        profiles: [{
            ordinal: 1, isPrivate: false, username: 'sensitive_username',
            fullName: 'sensitive-name', hasProfileImage: true,
            bio: 'sensitive-bio', media: [1, 2].map(index => ({
                selectionId: `sensitive-selection-${index}`,
                kind: 'feed' as const, jpegBase64: '/9j/2Q==',
            })),
            triageSelectionIds: ['sensitive-selection-1', 'sensitive-selection-2'],
            featureSelectionIds: [],
            resolverSelectionIds: ['sensitive-selection-1', 'sensitive-selection-2'],
            captions: [{
                evidenceRefId: 'sensitive-evidence', selectionId: 'sensitive-selection-1',
                text: 'sensitive-caption',
            }],
            coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
        }],
        evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
    });
}

const nonOkTriageOutcomes = [
    'rate_limited', 'retry_exhausted', 'rejected', 'failed', 'capacity_skipped',
] as const satisfies readonly ReplayOutcome[];

describe('resolver experiment triage failure reporting boundary', () => {
    it.each(nonOkTriageOutcomes)(
        'fails closed for %s without emitting a partial report',
        async outcome => {
            let serializedReport: string | undefined;
            let failure: unknown;
            const runner: Pick<ReplayAiRunner, 'triage' | 'resolveGender'> = {
                triage: async () => ({
                    outcome, attempts: 1, retries: 0, elapsedMs: 1,
                }),
                resolveGender: async () => ({
                    outcome: 'failed', attempts: 0, retries: 0, elapsedMs: 0,
                }),
            };

            try {
                await runStrongUncertainResolverExperiment({
                    bundle: sealedSensitiveBundle(),
                    runner,
                }).then(report => { serializedReport = JSON.stringify(report); });
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message)
                .toBe('ANALYSIS_V2_RESOLVER_EXPERIMENT_TRIAGE_FAILED');
            expect(serializedReport).toBeUndefined();
            expect((failure as Error).message).not.toMatch(/sensitive/i);
        },
    );
});
