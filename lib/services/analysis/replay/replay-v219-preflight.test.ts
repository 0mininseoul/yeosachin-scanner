import { describe, expect, it, vi } from 'vitest';

vi.mock('./replay-v219-approved-source', async importOriginal => {
    const actual = await importOriginal<
        typeof import('./replay-v219-approved-source')
    >();
    return {
        ...actual,
        V219_APPROVED_REPLAY_SOURCE_MANIFEST: Object.freeze({
            schema: 'analysis-v2-replay-v219-approved-source-v1',
            manifestId: 'synthetic-v219-source-test-v1',
            parentSourceContentSha256:
                '83ae21a5fd01b4311d1e2981fe199322435d8ed24403042242d2f107a4eeee3a',
            witnessSourceContentSha256:
                '83ae21a5fd01b4311d1e2981fe199322435d8ed24403042242d2f107a4eeee3a',
        }),
    };
});
import {
    createV219SealedSourceTestBundle,
} from './replay-v219-preflight.test-fixture';
import {
    createV219ReplayPreflightReport,
    createV219ReplaySourceOnlyPreflightReport,
} from './replay-v219-preflight';

describe('V2.19 zero-provider preflight', () => {
    it('derives the exact sealed-source cohort, histogram, topology, and reviewed Pro ceiling', () => {
        const report = createV219ReplayPreflightReport(
            createV219SealedSourceTestBundle(),
        );

        expect(report).toMatchObject({
            schema: 'analysis-v2-replay-v219-preflight-v1',
            source: {
                sourceProfiles: 385,
                selectedMediaReferences: 1_915,
                unavailableSelectedMediaReferences: 11,
                mediaUnavailableProfiles: 1,
                fetchTerminalProfiles: 4,
                retainedProfiles: 380,
                retainedPublicProfiles: 235,
                retainedPrivateProfiles: 145,
                retainedNormalizedMedia: 1_904,
                missingPublicProfiles: 5,
            },
            treatment: {
                staticCohort: 235,
                mediaCountHistogram: {
                    '2': 0,
                    '3': 0,
                    '4': 0,
                    '5': 0,
                    '6': 0,
                    '7': 0,
                    '8': 211,
                    '9': 24,
                },
            },
            budget: {
                controlLogicalCalls: 710,
                treatmentLogicalCalls: 235,
                totalLogicalCalls: 945,
                controlProviderDispatches: 2_840,
                treatmentProviderDispatches: 940,
                totalProviderDispatches: 3_780,
                costCeilingUsd: 121.1792,
            },
            treatmentConfiguration: {
                model: 'gemini-3.1-pro-preview',
                location: 'global',
                thinkingLevel: 'HIGH',
                mediaResolution: 'HIGH',
                profileImageLimit: 1,
                feedImageLimit: 8,
                maxOutputUnits: 2_048,
                maxAttemptsPerLogicalCall: 4,
                highImageInputUnits: 1_120,
                inputUsdPerMillionUnits: 2,
                outputUsdPerMillionUnits: 12,
            },
            externalEffects: {
                geminiClientsConstructed: 0,
                providerDispatches: 0,
                apifyClientsConstructed: 0,
                instagramTransportsConstructed: 0,
                productionStoresConstructed: 0,
                resultWritersConstructed: 0,
                cloudRunExecutionsCreated: 0,
            },
        });
        expect(Object.isFrozen(report)).toBe(true);
    });

    it('fails closed when lineage or the approved retained-source cardinality drifts', () => {
        const wrongPolicy = structuredClone(
            createV219SealedSourceTestBundle(),
        );
        wrongPolicy.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v218-public-gender-headroom-diagnostic',
            aiStage: 'ai-stage-policy-v2.18',
        } as never;
        expect(() => createV219ReplayPreflightReport(wrongPolicy))
            .toThrow('ANALYSIS_V2_REPLAY_V219_PREFLIGHT_SOURCE_MISMATCH');

        const missingMedia = structuredClone(
            createV219SealedSourceTestBundle(),
        );
        missingMedia.profiles[145]!.media.pop();
        expect(() => createV219ReplayPreflightReport(missingMedia))
            .toThrow('ANALYSIS_V2_REPLAY_V219_PREFLIGHT_SOURCE_MISMATCH');
    });

    it('rejects a same-shape source whose authenticated media content is not the approved immutable source', () => {
        const forged = structuredClone(
            createV219SealedSourceTestBundle(),
        );
        for (const profile of forged.profiles) {
            for (const media of profile.media) {
                media.jpegBase64 = 'ZGVm';
            }
        }

        expect(() => createV219ReplayPreflightReport(forged))
            .toThrow(
                'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_APPROVED_SOURCE_MISMATCH',
            );
    });

    it('accepts only the authenticated V2.17 parent capture for source-only V2.19 dry preflight', () => {
        const parent = createV219SealedSourceTestBundle();
        const witness = structuredClone(parent);
        parent.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v217-public-name-visual-fusion-shadow',
            aiStage: 'ai-stage-policy-v2.17',
        } as never;
        witness.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality',
            aiStage: 'ai-stage-policy-v2.12',
        } as never;

        const report =
            createV219ReplaySourceOnlyPreflightReport(
                parent,
                witness,
            );

        expect(report).toMatchObject({
            evaluationAiPolicy: 'ai-stage-policy-v2.19',
            sourceArtifactAiPolicy: 'ai-stage-policy-v2.17',
            sourceBinding: 'v217-parent-with-v212-witness',
            sourceWitness: {
                aiPolicy: 'ai-stage-policy-v2.12',
                identityAgreement: true,
            },
            treatment: { staticCohort: 235 },
        });
        expect(() => createV219ReplayPreflightReport(parent))
            .toThrow(
                'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_SOURCE_MISMATCH',
            );
        witness.capture.requestFingerprint = 'b'.repeat(64);
        expect(() => createV219ReplaySourceOnlyPreflightReport(
            parent,
            witness,
        )).toThrow(
            'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_SOURCE_MISMATCH',
        );
    });

    it('fails before cohort issuance when any resolver reference is absent', () => {
        const bundle = structuredClone(
            createV219SealedSourceTestBundle(),
        );
        bundle.profiles[145]!.resolverSelectionIds.push(
            'missing-selection',
        );

        expect(() => createV219ReplayPreflightReport(bundle))
            .toThrow(
                'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_MEDIA_REFERENCE_MISSING',
            );
    });
});
