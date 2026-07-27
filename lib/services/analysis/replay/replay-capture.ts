import { createHash } from 'node:crypto';
import { MAX_RECENT_POSTS, selectAnalysisMedia, type SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { buildCarouselCaptionPolicy } from '@/lib/domain/analysis/carousel-caption-policy';
import type { AnalysisV2CheckpointProfile } from '@/lib/services/analysis/v2-profile-fetch-store';
import {
    isAnalysisV2PartialMediaCoverageAllowed,
    normalizeAnalysisV2MediaSelections,
} from '@/lib/services/analysis/v2-ai-scoring-executors';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import type { ReplayProviderLedgerIdentity } from './replay-readonly-apify';
import {
    replaySourceLineageSchema,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
    type ReplaySourceLineage,
} from './replay-source-lineage';

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

function selectionMedia(profile: AnalysisV2CheckpointProfile): readonly SelectedAnalysisMedia[] {
    if (profile.isPrivate) return [];
    if ((profile.latestPosts?.length ?? 0) < Math.min(profile.postsCount, MAX_RECENT_POSTS)) {
        fail('ANALYSIS_V2_REPLAY_MEDIA_STRUCTURAL_INCOMPLETE');
    }
    const policy = selectAnalysisMedia({
        profile: profile.profilePicUrl ? { id: profile.username, imageUrl: profile.profilePicUrl } : undefined,
        posts: profile.latestPosts ?? [],
    });
    if (policy.carouselCoverage.incompletePostIds.length) fail('ANALYSIS_V2_REPLAY_MEDIA_STRUCTURAL_INCOMPLETE');
    return policy.feature.media;
}

function jpeg(buffer: Buffer): boolean {
    return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
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
    const source = await input.repository.loadReplaySource(request);
    const profiles: AnalysisV2ReplayBundle['profiles'] = [];
    for (const [index, profile] of source.profiles.entries()) {
        const selected = selectionMedia(profile);
        const policy = profile.isPrivate ? null : selectAnalysisMedia({
            profile: profile.profilePicUrl ? { id: profile.username, imageUrl: profile.profilePicUrl } : undefined,
            posts: profile.latestPosts ?? [],
        });
        const normalized = await normalizeAnalysisV2MediaSelections(
            selected,
            input.normalizeMedia,
            request.sourceLineage.policyVersions.aiStage,
        );
        if (
            (!profile.isPrivate && !isAnalysisV2PartialMediaCoverageAllowed(normalized.coverage))
            || normalized.media.some(item => !jpeg(normalized.bytes.get(item.selectionId)!))
        ) {
            fail('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
        }
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
                kind: media.kind === 'profile' ? 'profile' as const : 'feed' as const,
                ...(media.postId ? { postId: media.postId } : {}),
                caption: media.postId
                    ? profile.latestPosts?.find(post => post.id === media.postId)?.caption ?? null
                    : null,
                jpegBase64: normalized.bytes.get(media.selectionId)!.toString('base64'),
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
