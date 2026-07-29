import {
    AI_STAGE_POLICY_V219_VERSION,
} from '@/lib/services/ai/stage-policy';
import {
    selectAnalysisV2GenderResolverMedia,
} from '@/lib/services/analysis/v2-gender-resolver-media-policy';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import {
    historicalPartialSourceUniverseDigest,
    normalizeHistoricalPartialUsername,
} from './historical-partial-available-artifact';
import {
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V217_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V219_CAPABILITY,
} from './replay-source-lineage';
import {
    deriveV219ReplayBudgetPlan,
    type V219ReplayBudgetPlan,
} from './replay-v219-budget';
import {
    PRO_GENDER_SECOND_LOOK_CONFIG_V219,
    projectProGenderSecondLookV219,
    selectProGenderSecondLookMediaV219,
} from './replay-v219-gender-second-look';

const APPROVED_SOURCE_PROFILES = 385;
const APPROVED_SELECTED_MEDIA = 1_915;
const APPROVED_RETAINED_PROFILES = 380;
const APPROVED_RETAINED_PUBLIC_PROFILES = 235;
const APPROVED_RETAINED_PRIVATE_PROFILES = 145;
const APPROVED_RETAINED_MEDIA = 1_904;
const APPROVED_MISSING_PUBLIC_PROFILES = 5;

const sourceMismatch =
    'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_SOURCE_MISMATCH';
const mediaReferenceMissing =
    'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_MEDIA_REFERENCE_MISSING';

type MediaCountHistogramV219 = Record<
    '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9',
    number
>;

export interface V219ReplayPreflightReport {
    schema: 'analysis-v2-replay-v219-preflight-v1';
    evaluationAiPolicy: 'ai-stage-policy-v2.19';
    sourceArtifactAiPolicy:
        | 'ai-stage-policy-v2.17'
        | 'ai-stage-policy-v2.19';
    sourceBinding:
        | 'v217-parent-with-v212-witness'
        | 'v219-bound-evaluation-source';
    sourceWitness: {
        aiPolicy: 'ai-stage-policy-v2.12';
        identityAgreement: true;
    } | null;
    source: {
        sourceProfiles: number;
        selectedMediaReferences: number;
        unavailableSelectedMediaReferences: number;
        mediaUnavailableProfiles: number;
        fetchTerminalProfiles: number;
        retainedProfiles: number;
        retainedPublicProfiles: number;
        retainedPrivateProfiles: number;
        retainedNormalizedMedia: number;
        missingPublicProfiles: number;
    };
    treatment: {
        staticCohort: number;
        mediaCountHistogram: MediaCountHistogramV219;
    };
    budget: V219ReplayBudgetPlan;
    treatmentConfiguration:
        typeof PRO_GENDER_SECOND_LOOK_CONFIG_V219;
    externalEffects: {
        geminiClientsConstructed: 0;
        providerDispatches: 0;
        apifyClientsConstructed: 0;
        instagramTransportsConstructed: 0;
        productionStoresConstructed: 0;
        resultWritersConstructed: 0;
        cloudRunExecutionsCreated: 0;
    };
}

function failSource(): never {
    throw new Error(sourceMismatch);
}

function assertExactSource(
    bundle: AnalysisV2ReplayBundle,
    sourceBinding: V219ReplayPreflightReport['sourceBinding'],
): asserts bundle is Extract<
    AnalysisV2ReplayBundle,
    { schemaVersion: 2 }
> {
    if (
        bundle.schemaVersion !== 2
        || bundle.capture.scope
            !== 'ai-only-historical-partial-available'
        || bundle.capture.notExact !== true
        || bundle.capture.fullE2eEvidence !== false
        || bundle.capture.noMediaSubstitution !== true
        || (
            sourceBinding === 'v219-bound-evaluation-source'
                ? (
                    bundle.capture.evaluationPolicy.capability
                        !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V219_CAPABILITY
                    || bundle.capture.evaluationPolicy.aiStage
                        !== AI_STAGE_POLICY_V219_VERSION
                )
                : (
                    bundle.capture.evaluationPolicy.capability
                        !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V217_CAPABILITY
                    || bundle.capture.evaluationPolicy.aiStage
                        !== 'ai-stage-policy-v2.17'
                )
        )
        || bundle.capture.sourceLineage.selectedPlanId !== 'standard'
        || bundle.capture.sourceLineage.policyVersions.pipeline !== 'v2'
        || bundle.capture.sourceLineage.policyVersions.aiStage
            !== 'ai-stage-policy-v2.7'
        || bundle.capture.sourceLineage.policyVersions.risk
            !== 'risk-policy-v2.3'
        || 'scheduler'
            in bundle.capture.sourceLineage.policyVersions
    ) {
        failSource();
    }
}

function assertV212SourceWitness(
    parent: Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>,
    witness: AnalysisV2ReplayBundle | undefined,
): void {
    if (
        !witness
        || witness.schemaVersion !== 2
        || witness.capture.scope
            !== 'ai-only-historical-partial-available'
        || witness.capture.evaluationPolicy.capability
            !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY
        || witness.capture.evaluationPolicy.aiStage
            !== 'ai-stage-policy-v2.12'
        || witness.capture.sourceLineage.selectedPlanId !== 'standard'
        || witness.capture.sourceLineage.policyVersions.pipeline !== 'v2'
        || witness.capture.sourceLineage.policyVersions.aiStage
            !== 'ai-stage-policy-v2.7'
        || witness.capture.sourceLineage.policyVersions.risk
            !== 'risk-policy-v2.3'
        || witness.capture.requestFingerprint
            !== parent.capture.requestFingerprint
        || witness.capture.partial.sourceUniverseDigest
            !== parent.capture.partial.sourceUniverseDigest
        || witness.capture.partial.sourceIdentities.length
            !== APPROVED_SOURCE_PROFILES
        || witness.profiles.length !== APPROVED_RETAINED_PROFILES
        || witness.profiles.filter(profile => !profile.isPrivate).length
            !== APPROVED_RETAINED_PUBLIC_PROFILES
        || witness.profiles.filter(profile => profile.isPrivate).length
            !== APPROVED_RETAINED_PRIVATE_PROFILES
        || witness.profiles.reduce(
            (sum, profile) => sum + profile.media.length,
            0,
        ) !== APPROVED_RETAINED_MEDIA
        || witness.profiles.reduce(
            (sum, profile) => sum + profile.coverage.selectedCount,
            witness.capture.partial.mediaUnavailable.reduce(
                (sum, terminal) => (
                    sum + (terminal.selectedMediaCount ?? 0)
                ),
                0,
            ),
        ) !== APPROVED_SELECTED_MEDIA
    ) {
        failSource();
    }
}

function mediaHistogram(): MediaCountHistogramV219 {
    return {
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 0,
        '6': 0,
        '7': 0,
        '8': 0,
        '9': 0,
    };
}

function assertReviewedTreatmentConfiguration(
    plan: V219ReplayBudgetPlan,
): void {
    const treatment = plan.stages.proGenderSecondLook;
    const expectedInputUnits = 16_384
        + (
            PRO_GENDER_SECOND_LOOK_CONFIG_V219.profileImageLimit
            + PRO_GENDER_SECOND_LOOK_CONFIG_V219.feedImageLimit
        ) * PRO_GENDER_SECOND_LOOK_CONFIG_V219.highImageInputUnits;
    const expectedCostPerDispatch = Number((
        expectedInputUnits
            * PRO_GENDER_SECOND_LOOK_CONFIG_V219
                .inputUsdPerMillionUnits / 1_000_000
        + PRO_GENDER_SECOND_LOOK_CONFIG_V219.maxOutputUnits
            * PRO_GENDER_SECOND_LOOK_CONFIG_V219
                .outputUsdPerMillionUnits / 1_000_000
    ).toFixed(9));
    if (
        treatment.model
            !== PRO_GENDER_SECOND_LOOK_CONFIG_V219.model
        || treatment.inputUnitsPerDispatch !== expectedInputUnits
        || treatment.outputUnitsPerDispatch
            !== PRO_GENDER_SECOND_LOOK_CONFIG_V219.maxOutputUnits
        || treatment.costUsdPerDispatch !== expectedCostPerDispatch
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_V219_PREFLIGHT_PRICING_MISMATCH',
        );
    }
}

function createV219ReplayPreflightReportForBinding(
    bundle: AnalysisV2ReplayBundle,
    sourceBinding: V219ReplayPreflightReport['sourceBinding'],
    witness?: AnalysisV2ReplayBundle,
): Readonly<V219ReplayPreflightReport> {
    assertExactSource(bundle, sourceBinding);
    if (sourceBinding === 'v217-parent-with-v212-witness') {
        assertV212SourceWitness(bundle, witness);
    }
    const partial = bundle.capture.partial;
    const sourceIdentities = partial.sourceIdentities;
    const publicProfiles = bundle.profiles.filter(
        profile => !profile.isPrivate,
    );
    const privateProfiles = bundle.profiles.filter(
        profile => profile.isPrivate,
    );
    const retainedMedia = bundle.profiles.reduce(
        (sum, profile) => sum + profile.media.length,
        0,
    );
    const sourcePrivate = sourceIdentities.filter(
        identity => identity.partition === 'private',
    );
    const sourcePublic = sourceIdentities.filter(
        identity => identity.partition === 'public',
    );
    const sourceFetchTerminal = sourceIdentities.filter(
        identity => identity.partition === 'fetch_terminal',
    );
    const unavailableSelectedMediaReferences =
        partial.mediaUnavailable.reduce((sum, terminal) => {
            if (!Number.isSafeInteger(terminal.selectedMediaCount)) {
                failSource();
            }
            return sum + terminal.selectedMediaCount!;
        }, 0);
    const retainedSelectedMediaReferences = bundle.profiles.reduce(
        (sum, profile) => sum + profile.coverage.selectedCount,
        0,
    );
    const selectedMediaReferences =
        retainedSelectedMediaReferences
        + unavailableSelectedMediaReferences;
    if (
        sourceIdentities.length !== APPROVED_SOURCE_PROFILES
        || sourcePrivate.length
            !== APPROVED_RETAINED_PRIVATE_PROFILES
        || sourcePublic.length
            !== APPROVED_RETAINED_PUBLIC_PROFILES + 1
        || sourceFetchTerminal.length
            !== APPROVED_MISSING_PUBLIC_PROFILES - 1
        || bundle.profiles.length !== APPROVED_RETAINED_PROFILES
        || publicProfiles.length
            !== APPROVED_RETAINED_PUBLIC_PROFILES
        || privateProfiles.length
            !== APPROVED_RETAINED_PRIVATE_PROFILES
        || retainedMedia !== APPROVED_RETAINED_MEDIA
        || partial.mediaUnavailable.length !== 1
        || retainedSelectedMediaReferences
            !== APPROVED_RETAINED_MEDIA
        || unavailableSelectedMediaReferences
            !== APPROVED_SELECTED_MEDIA
                - APPROVED_RETAINED_MEDIA
        || selectedMediaReferences !== APPROVED_SELECTED_MEDIA
        || historicalPartialSourceUniverseDigest(sourceIdentities)
            !== partial.sourceUniverseDigest
    ) {
        failSource();
    }

    const identityByOrdinal = new Map(
        sourceIdentities.map(identity => [
            identity.ordinal,
            identity,
        ]),
    );
    const retainedOrdinals = new Set<number>();
    for (const profile of bundle.profiles) {
        const identity = identityByOrdinal.get(profile.ordinal);
        let normalizedUsername: string;
        try {
            normalizedUsername =
                normalizeHistoricalPartialUsername(profile.username);
        } catch {
            failSource();
        }
        if (
            !identity
            || identity.username !== normalizedUsername
            || identity.partition !== (
                profile.isPrivate ? 'private' : 'public'
            )
            || retainedOrdinals.has(profile.ordinal)
            || profile.coverage.selectedCount
                !== profile.media.length
            || profile.coverage.normalizedCount
                !== profile.media.length
            || (
                profile.isPrivate
                    ? profile.media.length !== 0
                    : profile.media.length === 0
            )
        ) {
            failSource();
        }
        retainedOrdinals.add(profile.ordinal);
    }
    const unavailableOrdinals = new Set<number>();
    for (const terminal of partial.mediaUnavailable) {
        if (
            identityByOrdinal.get(terminal.ordinal)?.partition
                !== 'public'
            || retainedOrdinals.has(terminal.ordinal)
            || unavailableOrdinals.has(terminal.ordinal)
        ) {
            failSource();
        }
        unavailableOrdinals.add(terminal.ordinal);
    }
    if (
        sourceIdentities.some(identity => (
            !retainedOrdinals.has(identity.ordinal)
            && !unavailableOrdinals.has(identity.ordinal)
            && identity.partition !== 'fetch_terminal'
        ))
    ) {
        failSource();
    }

    const histogram = mediaHistogram();
    let staticCohort = 0;
    for (const profile of publicProfiles) {
        const mediaBySelectionId = new Map(
            profile.media.map(media => [media.selectionId, media]),
        );
        if (mediaBySelectionId.size !== profile.media.length) {
            failSource();
        }
        const resolverMedia = profile.resolverSelectionIds.map(
            selectionId => {
                const media = mediaBySelectionId.get(selectionId);
                if (!media) {
                    throw new Error(mediaReferenceMissing);
                }
                return media;
            },
        );
        const selected = selectProGenderSecondLookMediaV219(
            selectAnalysisV2GenderResolverMedia(
                resolverMedia,
                AI_STAGE_POLICY_V219_VERSION,
            ),
        );
        if (selected.length < 2) continue;
        const projected = projectProGenderSecondLookV219(selected);
        if (
            projected.projectedMedia.length !== selected.length
            || selected.length > 9
        ) {
            failSource();
        }
        for (const [index, opaque] of
            projected.projectedMedia.entries()) {
            const finalized = projected.finalize({
                inferredGender: 'unknown',
                genderConfidence: 'low',
                ownerConsistency: 'same_person',
                accountContext: 'uncertain',
                contextConfidence: 'low',
                genderEvidenceIds: [opaque.selectionId],
                contextEvidenceIds: [],
            });
            if (
                finalized.genderEvidenceIds.length !== 1
                || finalized.genderEvidenceIds[0]
                    !== selected[index]!.selectionId
            ) {
                failSource();
            }
        }
        histogram[String(selected.length) as keyof typeof histogram]++;
        staticCohort++;
    }
    const budget = deriveV219ReplayBudgetPlan(staticCohort);
    assertReviewedTreatmentConfiguration(budget);

    const report: V219ReplayPreflightReport = {
        schema: 'analysis-v2-replay-v219-preflight-v1',
        evaluationAiPolicy: AI_STAGE_POLICY_V219_VERSION,
        sourceArtifactAiPolicy:
            sourceBinding === 'v219-bound-evaluation-source'
                ? AI_STAGE_POLICY_V219_VERSION
                : 'ai-stage-policy-v2.17',
        sourceBinding,
        sourceWitness:
            sourceBinding === 'v217-parent-with-v212-witness'
                ? {
                    aiPolicy: 'ai-stage-policy-v2.12',
                    identityAgreement: true,
                }
                : null,
        source: {
            sourceProfiles: sourceIdentities.length,
            selectedMediaReferences,
            unavailableSelectedMediaReferences,
            mediaUnavailableProfiles:
                partial.mediaUnavailable.length,
            fetchTerminalProfiles: sourceFetchTerminal.length,
            retainedProfiles: bundle.profiles.length,
            retainedPublicProfiles: publicProfiles.length,
            retainedPrivateProfiles: privateProfiles.length,
            retainedNormalizedMedia: retainedMedia,
            missingPublicProfiles:
                sourceIdentities.length - bundle.profiles.length,
        },
        treatment: {
            staticCohort,
            mediaCountHistogram: histogram,
        },
        budget,
        treatmentConfiguration:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219,
        externalEffects: {
            geminiClientsConstructed: 0,
            providerDispatches: 0,
            apifyClientsConstructed: 0,
            instagramTransportsConstructed: 0,
            productionStoresConstructed: 0,
            resultWritersConstructed: 0,
            cloudRunExecutionsCreated: 0,
        },
    };
    return Object.freeze(report);
}

/** Paid/job issuance requires an artifact authenticated directly to V2.19. */
export function createV219ReplayPreflightReport(
    bundle: AnalysisV2ReplayBundle,
): Readonly<V219ReplayPreflightReport> {
    return createV219ReplayPreflightReportForBinding(
        bundle,
        'v219-bound-evaluation-source',
    );
}

/**
 * Zero-provider dry preflight may inspect the retained V2.17 parent capture
 * used by V2.18. It does not issue a V2.19 runner or authorize paid replay.
 */
export function createV219ReplaySourceOnlyPreflightReport(
    bundle: AnalysisV2ReplayBundle,
    authenticatedV212Witness: AnalysisV2ReplayBundle,
): Readonly<V219ReplayPreflightReport> {
    return createV219ReplayPreflightReportForBinding(
        bundle,
        'v217-parent-with-v212-witness',
        authenticatedV212Witness,
    );
}
