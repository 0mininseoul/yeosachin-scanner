import { createHash } from 'node:crypto';
import { selectAnalysisMedia, type SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import type { AnalysisV2CheckpointProfile } from '@/lib/services/analysis/v2-profile-fetch-store';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import type { ReplayProviderLedgerIdentity } from './replay-readonly-apify';

export interface ReplayCaptureSelector { targetUsername: string; }
export interface ReplayCompletedRequest {
    requestFingerprint: string;
    plan: string;
    pipelineVersion: string;
    completed: boolean;
}
export interface ReplayCaptureSource {
    profiles: readonly AnalysisV2CheckpointProfile[];
    evidence: AnalysisV2ReplayBundle['evidence'];
    providerRuns: readonly ReplayProviderLedgerIdentity[];
}

/** A deliberately narrow read-only source. It has no RPC/mutation methods. */
export interface ReplayCaptureRepository {
    findCompletedStandardV2Exact(selector: ReplayCaptureSelector): Promise<ReplayCompletedRequest | null>;
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
    if ((profile.latestPosts?.length ?? 0) < Math.min(profile.postsCount, 4)) {
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
    now?: number;
}): Promise<AnalysisV2ReplayBundle> {
    const targetUsername = normalizedUsername(input.selector.targetUsername);
    const request = await input.repository.findCompletedStandardV2Exact({ targetUsername });
    if (!request || request.plan !== 'standard' || request.pipelineVersion !== 'v2' || request.completed !== true || !/^[a-f0-9]{64}$/.test(request.requestFingerprint)) {
        fail('ANALYSIS_V2_REPLAY_REQUEST_INELIGIBLE');
    }
    const source = await input.repository.loadReplaySource(request);
    const profiles: AnalysisV2ReplayBundle['profiles'] = [];
    for (const [index, profile] of source.profiles.entries()) {
        const selected = selectionMedia(profile);
        const normalized = await Promise.all(selected.map(async media => ({ media, bytes: await input.normalizeMedia(media) })));
        if (normalized.length !== selected.length || normalized.some(item => !jpeg(item.bytes))) {
            fail('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
        }
        profiles.push({
            ordinal: index + 1,
            isPrivate: profile.isPrivate,
            bio: profile.isPrivate ? undefined : profile.bio ?? null,
            media: normalized.map(({ media, bytes }) => ({
                selectionId: media.selectionId,
                caption: media.postId
                    ? profile.latestPosts?.find(post => post.id === media.postId)?.caption ?? null
                    : null,
                jpegBase64: bytes.toString('base64'),
            })),
        });
    }
    const now = input.now ?? Date.now();
    return {
        schemaVersion: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
        capture: { requestFingerprint: request.requestFingerprint, plan: 'standard' },
        profiles,
        evidence: source.evidence,
    };
}

/** PII-free capture selector fingerprint for safe CLI metrics. */
export function replayCaptureMetricFingerprint(selector: ReplayCaptureSelector): string {
    return createHash('sha256').update(`analysis-v2-replay-selector-v1\n${normalizedUsername(selector.targetUsername)}`).digest('hex');
}
