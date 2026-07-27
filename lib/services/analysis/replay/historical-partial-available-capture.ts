import { createHash } from 'node:crypto';
import { MAX_RECENT_POSTS, selectAnalysisMedia, type SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { buildCarouselCaptionPolicy } from '@/lib/domain/analysis/carousel-caption-policy';
import type { AnalysisV2CheckpointProfile } from '@/lib/services/analysis/v2-profile-fetch-store';
import { aiStagePolicySupports } from '@/lib/services/ai/stage-policy';
import { isAnalysisV2PartialMediaCoverageAllowed, normalizeAnalysisV2MediaSelections } from '@/lib/services/analysis/v2-media-normalization';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import { HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY, type ReplayEvaluationPolicy, type ReplaySourceLineage } from './replay-source-lineage';

export type HistoricalPartialSourceProfile = {
    ordinal: number;
    partition: 'private' | 'public' | 'fetch_terminal';
    profile?: AnalysisV2CheckpointProfile;
    /** Used only in the encrypted universe digest, never in visible reports. */
    username?: string;
};

export type HistoricalPartialAvailableReport = {
    scope: 'ai-only-historical-partial-available'; notExact: true; fullE2eEvidence: false; noMediaSubstitution: true;
    sourceProfiles: number; sourceSelectedMedia: number;
    partitions: { private: number; fetch_terminal: number; public_available: number; public_media_unavailable: number; total: number };
    retained: { profiles: number; profileRatio: number; media: number; mediaRatio: number };
    stages: Record<'triage' | 'feature', { selected: number; normalized: number; failed: number; reasons: Record<string, number>; dispositions: Record<string, number> }>;
    aiWorkload: { publicTriage: number; publicFeature: number; privateNames: number };
};

type PartialBundle = Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>;

function jpeg(bytes: Buffer): boolean {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}
function stageMetrics() { return { selected: 0, normalized: 0, failed: 0, reasons: {} as Record<string, number>, dispositions: {} as Record<string, number> }; }
function record(stage: ReturnType<typeof stageMetrics>, coverage: { selectedCount: number; normalizedCount: number; failures: readonly { reason: string; disposition: string }[] }) {
    stage.selected += coverage.selectedCount; stage.normalized += coverage.normalizedCount; stage.failed += coverage.failures.length;
    for (const failure of coverage.failures) {
        stage.reasons[failure.reason] = (stage.reasons[failure.reason] ?? 0) + 1;
        stage.dispositions[failure.disposition] = (stage.dispositions[failure.disposition] ?? 0) + 1;
    }
}
function merge(selected: readonly SelectedAnalysisMedia[], parts: readonly Awaited<ReturnType<typeof normalizeAnalysisV2MediaSelections>>[]) {
    const bytes = new Map(parts.flatMap(part => [...part.bytes]));
    return { media: selected.flatMap(item => bytes.has(item.selectionId) ? [{ ...item, bytes: bytes.get(item.selectionId)! }] : []), coverage: { selectedCount: selected.length, normalizedCount: bytes.size, failures: parts.flatMap(part => part.coverage.failures) } };
}
function universeDigest(profiles: readonly HistoricalPartialSourceProfile[]): string {
    const value = profiles.map(profile => `${profile.ordinal}\u0000${profile.partition}\u0000${profile.username ?? profile.profile?.username ?? ''}`).join('\n');
    return createHash('sha256').update(`analysis-v2-historical-partial-universe-v1\n${value}`).digest('hex');
}
function unavailableReason(reason: string) { return /^[a-z_]{1,64}$/.test(reason) ? reason : 'media_gate_failed'; }

/**
 * Read-only non-exact capture: it deliberately keeps exact capture fail-closed and
 * contains only profiles that independently pass both production media gates.
 */
export async function captureHistoricalPartialAvailableReplayBundle(input: {
    requestFingerprint: string; sourceLineage: ReplaySourceLineage; evaluationPolicy: ReplayEvaluationPolicy;
    source: { profiles: readonly HistoricalPartialSourceProfile[]; evidence: AnalysisV2ReplayBundle['evidence'] };
    normalizeMedia: (media: SelectedAnalysisMedia) => Promise<Buffer>; now?: number;
}): Promise<{ bundle: PartialBundle; report: HistoricalPartialAvailableReport }> {
    if (input.evaluationPolicy.capability !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY) throw new Error('ANALYSIS_V2_REPLAY_PARTIAL_CAPABILITY_REQUIRED');
    if (input.sourceLineage.selectedPlanId !== 'standard' || input.sourceLineage.policyVersions.aiStage !== 'ai-stage-policy-v2.7' || input.sourceLineage.policyVersions.risk !== 'risk-policy-v2.3' || 'scheduler' in input.sourceLineage.policyVersions) throw new Error('ANALYSIS_V2_REPLAY_EVALUATION_SOURCE_INELIGIBLE');
    const seen = new Set<number>();
    if (input.source.profiles.some(item => !Number.isInteger(item.ordinal) || item.ordinal < 1 || seen.has(item.ordinal) || (seen.add(item.ordinal), false))) throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    const report: HistoricalPartialAvailableReport = { scope: 'ai-only-historical-partial-available', notExact: true, fullE2eEvidence: false, noMediaSubstitution: true, sourceProfiles: input.source.profiles.length, sourceSelectedMedia: 0, partitions: { private: 0, fetch_terminal: 0, public_available: 0, public_media_unavailable: 0, total: input.source.profiles.length }, retained: { profiles: 0, profileRatio: 0, media: 0, mediaRatio: 0 }, stages: { triage: stageMetrics(), feature: stageMetrics() }, aiWorkload: { publicTriage: 0, publicFeature: 0, privateNames: 0 } };
    const profiles: PartialBundle['profiles'] = [];
    const mediaUnavailable: NonNullable<PartialBundle['capture']['partial']>['mediaUnavailable'] = [];
    const carouselDiversity = aiStagePolicySupports('ai-stage-policy-v2.7', 'inputQualityV28');
    for (const candidate of input.source.profiles) {
        if (candidate.partition === 'fetch_terminal') { report.partitions.fetch_terminal++; continue; }
        if (!candidate.profile) {
            if (candidate.partition !== 'public') throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
            report.partitions.public_media_unavailable++;
            mediaUnavailable.push({ ordinal: candidate.ordinal, terminal: 'media_unavailable', triageFailures: 0, featureFailures: 0, reasons: ['profile_unavailable'] });
            continue;
        }
        const profile = candidate.profile;
        if (candidate.partition === 'private' || profile.isPrivate) {
            report.partitions.private++; report.aiWorkload.privateNames++;
            profiles.push({ ordinal: candidate.ordinal, isPrivate: true, username: profile.username.toLowerCase(), fullName: profile.fullName ?? null, hasProfileImage: false, media: [], triageSelectionIds: [], featureSelectionIds: [], resolverSelectionIds: [], captions: [], coverage: { selectedCount: 0, normalizedCount: 0, failures: [] } });
            continue;
        }
        let reason = (profile.latestPosts?.length ?? 0) < Math.min(profile.postsCount, MAX_RECENT_POSTS) ? 'structural_incomplete' : undefined;
        let policy: ReturnType<typeof selectAnalysisMedia> | undefined;
        try { policy = selectAnalysisMedia({ profile: profile.profilePicUrl ? { id: profile.username, imageUrl: profile.profilePicUrl } : undefined, posts: profile.latestPosts ?? [] }, carouselDiversity ? { carouselDiversity: true } : undefined); } catch { reason = reason ?? 'media_selection_invalid'; }
        if (policy?.carouselCoverage.incompletePostIds.length) reason = reason ?? 'structural_incomplete';
        const triage = await normalizeAnalysisV2MediaSelections(policy?.triage.media ?? [], input.normalizeMedia, input.sourceLineage.policyVersions.aiStage);
        const triageJpeg = triage.media.every(item => jpeg(triage.bytes.get(item.selectionId)!));
        record(report.stages.triage, triage.coverage);
        const triageIds = new Set(policy?.triage.selectionIds ?? []);
        const remainder = await normalizeAnalysisV2MediaSelections((policy?.feature.media ?? []).filter(item => !triageIds.has(item.selectionId)), input.normalizeMedia, input.sourceLineage.policyVersions.aiStage);
        const feature = merge(policy?.feature.media ?? [], [triage, remainder]);
        record(report.stages.feature, feature.coverage); report.sourceSelectedMedia += feature.coverage.selectedCount;
        const featureJpeg = feature.media.every(item => jpeg(item.bytes));
        const triagePass = !reason && triageJpeg && isAnalysisV2PartialMediaCoverageAllowed(triage.coverage);
        const featurePass = !reason && featureJpeg && isAnalysisV2PartialMediaCoverageAllowed(feature.coverage);
        if (!triagePass || !featurePass) {
            report.partitions.public_media_unavailable++;
            mediaUnavailable.push({ ordinal: candidate.ordinal, terminal: 'media_unavailable', triageFailures: triage.coverage.failures.length, featureFailures: feature.coverage.failures.length, reasons: [...new Set([...triage.coverage.failures, ...feature.coverage.failures].map(failure => unavailableReason(failure.reason)).concat(reason ? [reason] : []))].sort() });
            continue;
        }
        report.partitions.public_available++; report.aiWorkload.publicTriage++; report.aiWorkload.publicFeature++;
        const ids = new Set(feature.media.map(item => item.selectionId));
        profiles.push({ ordinal: candidate.ordinal, isPrivate: false, username: profile.username.toLowerCase(), fullName: profile.fullName ?? null, hasProfileImage: Boolean(profile.profilePicUrl?.trim()), bio: profile.bio ?? null, media: feature.media.map(item => ({ selectionId: item.selectionId, kind: item.role === 'profile' ? 'profile' as const : 'feed' as const, ...(item.postId ? { postId: item.postId } : {}), caption: item.postId ? profile.latestPosts?.find(post => post.id === item.postId)?.caption ?? null : null, jpegBase64: item.bytes.toString('base64') })), triageSelectionIds: (policy?.triage.selectionIds ?? []).filter(id => ids.has(id)), featureSelectionIds: (policy?.feature.selectionIds ?? []).filter(id => ids.has(id)), resolverSelectionIds: (policy?.feature.selectionIds ?? []).filter(id => ids.has(id)), captions: policy ? buildCarouselCaptionPolicy({ targetUsername: profile.username, profile, featureSelections: policy.feature.media, partnerSelections: policy.partnerSafetyContactSheetCandidates.media }).featureCaptions.filter(caption => ids.has(caption.selectionId)) : [], coverage: { selectedCount: feature.coverage.selectedCount, normalizedCount: feature.coverage.normalizedCount, failures: feature.coverage.failures.map(failure => ({ ...failure })) } });
    }
    report.retained.profiles = profiles.length; report.retained.media = profiles.reduce((sum, profile) => sum + profile.media.length, 0); report.retained.profileRatio = report.sourceProfiles ? Number((profiles.length / report.sourceProfiles).toFixed(4)) : 0; report.retained.mediaRatio = report.sourceSelectedMedia ? Number((report.retained.media / report.sourceSelectedMedia).toFixed(4)) : 0;
    const now = input.now ?? Date.now();
    return { bundle: { schemaVersion: 2, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), capture: { scope: 'ai-only-historical-partial-available', notExact: true, fullE2eEvidence: false, noMediaSubstitution: true, requestFingerprint: input.requestFingerprint, sourceLineage: input.sourceLineage, evaluationPolicy: input.evaluationPolicy, partial: { sourceUniverseDigest: universeDigest(input.source.profiles), mediaUnavailable } }, profiles, evidence: input.source.evidence }, report };
}

/** Deliberately omits all profile identifiers, URLs, ordinals and universe digest. */
export function partialAvailableSafeReport(report: HistoricalPartialAvailableReport): HistoricalPartialAvailableReport { return report; }
