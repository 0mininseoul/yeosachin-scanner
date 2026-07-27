import { describe, expect, it } from 'vitest';
import { historicalPartialSourceUniverseDigest } from './historical-partial-available-artifact';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import {
    assertStrongUncertainResolverExperiment,
    deriveStrongUncertainResolverExperiment,
    STRONG_UNCERTAIN_RESOLVER_EXPERIMENT,
} from './resolver-experiment-artifact';

function parent(): Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }> {
    const sourceIdentities = [
        { ordinal: 1, username: 'example', partition: 'public' as const },
    ];
    return {
        schemaVersion: 2,
        createdAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-07-27T01:00:00.000Z',
        capture: {
            requestFingerprint: 'a'.repeat(64),
            scope: 'ai-only-historical-partial-available',
            notExact: true,
            fullE2eEvidence: false,
            noMediaSubstitution: true,
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    aiStage: 'ai-stage-policy-v2.7',
                    risk: 'risk-policy-v2.3',
                },
            },
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
            partial: {
                sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                sourceIdentities,
                mediaUnavailable: [],
            },
        },
        profiles: [{
            ordinal: 1, isPrivate: false, username: 'example', fullName: null,
            hasProfileImage: true, bio: null, media: [], triageSelectionIds: [],
            featureSelectionIds: [], resolverSelectionIds: [], captions: [],
            coverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
        }],
        evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
    };
}

describe('strong uncertain resolver experiment artifact', () => {
    it('derives a sealed schema-v3 child with parent and source-universe bindings', () => {
        const derived = deriveStrongUncertainResolverExperiment(parent());
        expect(derived.schemaVersion).toBe(3);
        expect(derived.capture.experiment).toMatchObject({
            id: STRONG_UNCERTAIN_RESOLVER_EXPERIMENT,
            evaluationAiStage: 'ai-stage-policy-v2.9',
            uncertainPilotLimit: 24,
        });
        expect(derived.capture.experiment.parentRequestFingerprint).toBe('a'.repeat(64));
        expect(derived.capture.experiment.sourceUniverseDigest)
            .toBe(parent().capture.partial.sourceUniverseDigest);
        expect(derived.capture.experiment.parentBinding).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(derived.capture.experiment)).not.toContain('example');
    });

    it('rejects anything except the authenticated historical-partial v2 lineage', () => {
        const invalid = parent();
        invalid.capture.evaluationPolicy.aiStage = 'ai-stage-policy-v2.8' as 'ai-stage-policy-v2.9';
        expect(() => deriveStrongUncertainResolverExperiment(invalid))
            .toThrow('ANALYSIS_V2_RESOLVER_EXPERIMENT_PARENT_MISMATCH');
    });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    it.each([
        ['scope', (value: any) => { value.capture.scope = 'ai-only-historical-partial-available'; }],
        ['notProduction', (value: any) => { value.capture.notProduction = false; }],
        ['fullE2e', (value: any) => { value.capture.fullE2eEvidence = true; }],
        ['experiment', (value: any) => { value.capture.experiment.id = 'other'; }],
        ['capability', (value: any) => { value.capture.evaluationPolicy.capability = 'other'; }],
        ['parent fingerprint', (value: any) => { value.capture.experiment.parentRequestFingerprint = 'b'.repeat(64); }],
        ['parent binding', (value: any) => { value.capture.experiment.parentBinding = 'b'.repeat(64); }],
        ['source digest', (value: any) => { value.capture.partial.sourceUniverseDigest = 'b'.repeat(64); }],
        ['lineage', (value: any) => { value.capture.sourceLineage.policyVersions.risk = 'risk-policy-v2.4'; }],
        ['pilot', (value: any) => { value.capture.experiment.uncertainPilotLimit = 23; }],
    ])('rejects mutated %s at the library runner boundary', (_label, mutate) => {
        const value = structuredClone(deriveStrongUncertainResolverExperiment(parent()));
        mutate(value);
        expect(() => assertStrongUncertainResolverExperiment(value))
            .toThrow('ANALYSIS_V2_RESOLVER_EXPERIMENT_CAPABILITY_MISMATCH');
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
});
