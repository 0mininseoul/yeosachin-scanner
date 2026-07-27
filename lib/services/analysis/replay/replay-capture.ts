import { createHash } from 'node:crypto';
import { MAX_RECENT_POSTS, selectAnalysisMedia, type SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { buildCarouselCaptionPolicy } from '@/lib/domain/analysis/carousel-caption-policy';
import type { AnalysisV2CheckpointProfile } from '@/lib/services/analysis/v2-profile-fetch-store';
import {
    isAnalysisV2PartialMediaCoverageAllowed,
    normalizeAnalysisV2MediaSelections,
} from '@/lib/services/analysis/v2-media-normalization';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import type { ReplayProviderLedgerIdentity } from './replay-readonly-apify';
import {
    replaySourceLineageSchema,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
    type ReplaySourceLineage,
} from './replay-source-lineage';
import { aiStagePolicySupports } from '@/lib/services/ai/stage-policy';

export interface ReplayCaptureSelector { targetUsername: string; }
export interface ReplayCompletedRequest {
    requestFingerprint: string;
    sourceLineage: ReplaySourceLineage;
    completed: boolean;
}
export interface ReplayCaptureSource {
    profiles: readonly AnalysisV2CheckpointProfile[];
    evidence: AnalysisV2ReplayBundle['evidence'];
    providerRuns: readonly ReplayProviderLedgerIdentity[];
}

/** A deliberately narrow read-only source. It has no RPC/mutation methods. */
export interface ReplayCaptureRepository {
    findCompletedReplaySourceExact(selector: ReplayCaptureSelector): Promise<ReplayCompletedRequest | null>;
    loadReplaySource(request: ReplayCompletedRequest): Promise<ReplayCaptureSource>;
}

function fail(code: string): never { throw new Error(code); }

function normalizedUsername(value: string): string {
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) fail('ANALYSIS_V2_REPLAY_SELECTOR_INVALID');
    return normalized;
}

function jpeg(buffer: Buffer): boolean {
    return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function mergeNormalizedMedia(
    selected: readonly SelectedAnalysisMedia[],
    parts: readonly Awaited<ReturnType<typeof normalizeAnalysisV2MediaSelections>>[],
) {
    const bytes = new Map(parts.flatMap(part => [...part.bytes.entries()]));
    const failures = parts.flatMap(part => part.coverage.failures);
    return {
        media: selected.flatMap(media => bytes.has(media.selectionId)
            ? [{ ...media, bytes: bytes.get(media.selectionId)! }]
            : []),
        coverage: {
            selectedCount: selected.length,
            normalizedCount: bytes.size,
            failures,
        },
    };
}

/**
 * Converts an exact completed V2 source to an in-memory, encrypted-bundle-ready value.
 * Dataset loading is intentionally outside this pure adapter and must use replay-readonly-apify.
 */
export async function captureAnalysisV2ReplayBundle(input: {
    selector: ReplayCaptureSelector;
    repository: ReplayCaptureRepository;
    normalizeMedia: (media: SelectedAnalysisMedia) => Promise<Buffer>;
    evaluationPolicy?: ReplayEvaluationPolicy;
    now?: number;
}): Promise<AnalysisV2ReplayBundle> {
    const targetUsername = normalizedUsername(input.selector.targetUsername);
    const request = await input.repository.findCompletedReplaySourceExact({ targetUsername });
    if (
        !request
        || request.completed !== true
        || !/^[a-f0-9]{64}$/.test(request.requestFingerprint)
        || !replaySourceLineageSchema.safeParse(request.sourceLineage).success
    ) {
        fail('ANALYSIS_V2_REPLAY_REQUEST_INELIGIBLE');
    }
    resolveReplayAiStagePolicyVersion(request.sourceLineage, input.evaluationPolicy);
    const carouselDiversity = aiStagePolicySupports(
        request.sourceLineage.policyVersions.aiStage as Parameters<typeof aiStagePolicySupports>[0],
        'inputQualityV28',
    );
    const source = await input.repository.loadReplaySource(request);
    const profiles: AnalysisV2ReplayBundle['profiles'] = [];
    for (const [index, profile] of source.profiles.entries()) {
        if (!profile.isPrivate && (profile.latestPosts?.length ?? 0) < Math.min(profile.postsCount, MAX_RECENT_POSTS)) {
            fail('ANALYSIS_V2_REPLAY_MEDIA_STRUCTURAL_INCOMPLETE');
        }
        const policy = profile.isPrivate ? null : selectAnalysisMedia({
            profile: profile.profilePicUrl ? { id: profile.username, imageUrl: profile.profilePicUrl } : undefined,
            posts: profile.latestPosts ?? [],
        }, carouselDiversity ? { carouselDiversity: true } : undefined);
        if (policy?.carouselCoverage.incompletePostIds.length) fail('ANALYSIS_V2_REPLAY_MEDIA_STRUCTURAL_INCOMPLETE');
        const triageNormalized = await normalizeAnalysisV2MediaSelections(
            policy?.triage.media ?? [],
            input.normalizeMedia,
            request.sourceLineage.policyVersions.aiStage,
        );
        if (
            (!profile.isPrivate && !isAnalysisV2PartialMediaCoverageAllowed(triageNormalized.coverage))
            || triageNormalized.media.some(item => !jpeg(triageNormalized.bytes.get(item.selectionId)!))
        ) {
            fail('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
        }
        const triageIds = new Set(policy?.triage.selectionIds ?? []);
        const featureRemainder = (policy?.feature.media ?? []).filter(media => !triageIds.has(media.selectionId));
        const remainderNormalized = await normalizeAnalysisV2MediaSelections(
            featureRemainder,
            input.normalizeMedia,
            request.sourceLineage.policyVersions.aiStage,
        );
        const normalized = mergeNormalizedMedia(policy?.feature.media ?? [], [triageNormalized, remainderNormalized]);
        if (
            (!profile.isPrivate && !isAnalysisV2PartialMediaCoverageAllowed(normalized.coverage))
            || normalized.media.some(item => !jpeg(item.bytes))
        ) fail('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
        const normalizedSelectionIds = new Set(normalized.media.map(item => item.selectionId));
        profiles.push({
            ordinal: index + 1,
            isPrivate: profile.isPrivate,
            username: profile.username.toLowerCase(),
            fullName: profile.fullName ?? null,
            hasProfileImage: Boolean(profile.profilePicUrl?.trim()),
            bio: profile.isPrivate ? undefined : profile.bio ?? null,
            media: normalized.media.map(media => ({
                selectionId: media.selectionId,
                kind: media.role === 'profile' ? 'profile' as const : 'feed' as const,
                ...(media.postId ? { postId: media.postId } : {}),
                caption: media.postId
                    ? profile.latestPosts?.find(post => post.id === media.postId)?.caption ?? null
                    : null,
                jpegBase64: media.bytes.toString('base64'),
            })),
            triageSelectionIds: (policy?.triage.selectionIds ?? []).filter(id => normalizedSelectionIds.has(id)),
            featureSelectionIds: (policy?.feature.selectionIds ?? []).filter(id => normalizedSelectionIds.has(id)),
            // Production passes the complete normalized feature set to the resolver;
            // the resolver applies its own current projection/media limit.
            resolverSelectionIds: (policy?.feature.selectionIds ?? []).filter(id => normalizedSelectionIds.has(id)),
            captions: policy ? buildCarouselCaptionPolicy({
                targetUsername: profile.username,
                profile,
                featureSelections: policy.feature.media,
                partnerSelections: policy.partnerSafetyContactSheetCandidates.media,
            }).featureCaptions.filter(caption => normalizedSelectionIds.has(caption.selectionId)) : [],
            coverage: {
                selectedCount: normalized.coverage.selectedCount,
                normalizedCount: normalized.coverage.normalizedCount,
                failures: normalized.coverage.failures.map(failure => ({ ...failure })),
            },
        });
    }
    const now = input.now ?? Date.now();
    return {
        schemaVersion: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
        capture: {
            requestFingerprint: request.requestFingerprint,
            ...(input.evaluationPolicy ? { evaluationPolicy: input.evaluationPolicy } : {}),
            sourceLineage: request.sourceLineage,
        },
        profiles,
        evidence: source.evidence,
    };
}

/** PII-free capture selector fingerprint for safe CLI metrics. */
export function replayCaptureMetricFingerprint(selector: ReplayCaptureSelector): string {
    return createHash('sha256').update(`analysis-v2-replay-selector-v1\n${normalizedUsername(selector.targetUsername)}`).digest('hex');
}
