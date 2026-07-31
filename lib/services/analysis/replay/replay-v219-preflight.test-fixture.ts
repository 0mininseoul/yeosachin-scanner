import type { AnalysisV2ReplayBundle } from './replay-bundle';
import { historicalPartialSourceUniverseDigest } from './historical-partial-available-artifact';

export function createV219SealedSourceTestBundle(
    now = Date.now(),
): AnalysisV2ReplayBundle {
    const sourceIdentities = Array.from({ length: 385 }, (_, index) => {
        const ordinal = index + 1;
        return {
            ordinal,
            username: `account.${ordinal}`,
            partition: ordinal <= 145
                ? 'private' as const
                : ordinal <= 381
                    ? 'public' as const
                    : 'fetch_terminal' as const,
        };
    });
    const privateProfiles = sourceIdentities.slice(0, 145).map(identity => ({
        ordinal: identity.ordinal,
        isPrivate: true,
        username: identity.username,
        fullName: null,
        hasProfileImage: false,
        bio: null,
        media: [],
        triageSelectionIds: [],
        featureSelectionIds: [],
        resolverSelectionIds: [],
        captions: [],
        coverage: {
            selectedCount: 0,
            normalizedCount: 0,
            failures: [],
        },
    }));
    const publicProfiles = sourceIdentities.slice(145, 380)
        .map((identity, index) => {
            const mediaCount = index < 24 ? 9 : 8;
            const media = Array.from(
                { length: mediaCount },
                (_, mediaIndex) => {
                    const selectionId =
                        `profile-${identity.ordinal}-media-${mediaIndex + 1}`;
                    return {
                        selectionId,
                        kind: mediaIndex === 0
                            ? 'profile' as const
                            : 'feed' as const,
                        ...(mediaIndex === 0
                            ? {}
                            : {
                                postId:
                                    `post-${identity.ordinal}-${mediaIndex}`,
                            }),
                        jpegBase64: 'YWJj',
                    };
                },
            );
            const selectionIds = media.map(item => item.selectionId);
            return {
                ordinal: identity.ordinal,
                isPrivate: false,
                username: identity.username,
                fullName: null,
                hasProfileImage: true,
                bio: null,
                media,
                triageSelectionIds: selectionIds.slice(0, 9),
                featureSelectionIds: selectionIds,
                resolverSelectionIds: selectionIds,
                captions: [],
                coverage: {
                    selectedCount: mediaCount,
                    normalizedCount: mediaCount,
                    failures: [],
                },
            };
        });
    return {
        schemaVersion: 2,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        capture: {
            scope: 'ai-only-historical-partial-available',
            notExact: true,
            fullE2eEvidence: false,
            noMediaSubstitution: true,
            requestFingerprint: 'a'.repeat(64),
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    aiStage: 'ai-stage-policy-v2.7',
                    risk: 'risk-policy-v2.3',
                },
            },
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v219-pro-gender-second-look-shadow',
                aiStage: 'ai-stage-policy-v2.19',
            },
            partial: {
                sourceUniverseDigest:
                    historicalPartialSourceUniverseDigest(sourceIdentities),
                sourceIdentities,
                mediaUnavailable: sourceIdentities.slice(380, 381).map(
                    identity => ({
                        ordinal: identity.ordinal,
                        terminal: 'media_unavailable' as const,
                        selectedMediaCount: 11,
                        triageFailures: 1,
                        featureFailures: 1,
                        reasons: ['normalization_failed'],
                    }),
                ),
            },
        },
        profiles: [...privateProfiles, ...publicProfiles],
        evidence: {
            relationship: [],
            targetInteractions: [],
            reverseInteractions: [],
        },
    };
}
