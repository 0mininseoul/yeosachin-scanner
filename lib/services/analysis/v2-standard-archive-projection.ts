import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import type {
    AnalysisV2CanonicalRelationshipRow,
    AnalysisV2CanonicalTargetEvidenceRow,
} from './v2-evidence-store';
import type { ReadyPreflightSnapshot } from './preflight';
import {
    analysisV2CheckpointProfileSchema,
    type AnalysisV2CheckpointProfile,
    type AnalysisV2CheckpointResult,
} from './v2-profile-fetch-store';

type ArchivePost = NonNullable<AnalysisV2CheckpointProfile['latestPosts']>[number];
type ArchiveMediaItem = NonNullable<ArchivePost['mediaItems']>[number];

// Free text can reference URLs too. Remove links rather than copying their path,
// query, fragment, or optional userinfo into a long-lived scoring input.
function withoutLinks(value: string): string {
    return value
        .replace(/(?:[a-z][a-z0-9+.-]*(?::|%3a))?(?:\/\/|%2f%2f)[^\s<>"'`]+/gi, '[link]')
        .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#][^\s<>"'`]*/gi, '[link]');
}

function archiveIdentifier(value: string): string {
    // Stable identifiers must still match the source when read for replay.
    if (withoutLinks(value) !== value) throw new Error('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
    return value;
}

function archivedMediaUrls(value: { imageUrl?: string; thumbnailUrl?: string; videoUrl?: string }) {
    return {
        ...(value.imageUrl === undefined ? {} : { imageUrl: archiveMediaUrlAnchor(value.imageUrl) }),
        ...(value.thumbnailUrl === undefined ? {} : { thumbnailUrl: archiveMediaUrlAnchor(value.thumbnailUrl) }),
        // Display selection uses this identity to reject a raw video URL used as an image.
        ...(value.videoUrl === undefined ? {} : { videoUrl: archiveMediaUrlAnchor(value.videoUrl) }),
    };
}

function archivedMediaItem(item: ArchiveMediaItem): ArchiveMediaItem {
    return {
        ...(item.id === undefined ? {} : { id: archiveIdentifier(item.id) }),
        type: item.type,
        ...(item.caption === undefined ? {} : { caption: withoutLinks(item.caption) }),
        ...archivedMediaUrls(item),
    };
}

function archivedPost(post: ArchivePost): ArchivePost {
    return {
        id: archiveIdentifier(post.id),
        shortCode: archiveIdentifier(post.shortCode),
        type: post.type,
        ...(post.caption === undefined ? {} : { caption: withoutLinks(post.caption) }),
        ...(post.hashtags === undefined ? {} : { hashtags: post.hashtags.map(withoutLinks) }),
        ...archivedMediaUrls(post),
        ...(post.mediaItems === undefined ? {} : { mediaItems: post.mediaItems.map(archivedMediaItem) }),
        ...(post.declaredMediaCount === undefined ? {} : { declaredMediaCount: post.declaredMediaCount }),
        ...(post.childrenComplete === undefined ? {} : { childrenComplete: post.childrenComplete }),
        likesCount: post.likesCount,
        commentsCount: post.commentsCount,
        ...(post.likesCountHidden === undefined ? {} : { likesCountHidden: post.likesCountHidden }),
        ...(post.commentsCountHidden === undefined ? {} : { commentsCountHidden: post.commentsCountHidden }),
        timestamp: post.timestamp,
        taggedUsers: post.taggedUsers,
        mentionedUsers: post.mentionedUsers,
    };
}

export function projectDevStandardArchiveProfile(profile: AnalysisV2CheckpointProfile): AnalysisV2CheckpointProfile {
    return analysisV2CheckpointProfileSchema.parse({
        username: profile.username,
        ...(profile.fullName === undefined ? {} : { fullName: withoutLinks(profile.fullName) }),
        ...(profile.bio === undefined ? {} : { bio: withoutLinks(profile.bio) }),
        ...(profile.profilePicUrl === undefined ? {} : { profilePicUrl: archiveMediaUrlAnchor(profile.profilePicUrl) }),
        ...(profile.profilePicUrlHD === undefined ? {} : { profilePicUrlHD: archiveMediaUrlAnchor(profile.profilePicUrlHD) }),
        followersCount: profile.followersCount,
        followingCount: profile.followingCount,
        postsCount: profile.postsCount,
        isPrivate: profile.isPrivate,
        isVerified: profile.isVerified,
        ...(profile.latestPosts === undefined ? {} : { latestPosts: profile.latestPosts.map(archivedPost) }),
    });
}

export function projectDevStandardArchiveProfileResult(result: AnalysisV2CheckpointResult): AnalysisV2CheckpointResult {
    return 'profile' in result
        ? { outcome: result.outcome, profile: projectDevStandardArchiveProfile(result.profile) }
        : result;
}

export function projectDevStandardArchivePreflightTarget(target: ReadyPreflightSnapshot['target']): ReadyPreflightSnapshot['target'] {
    return {
        username: target.username,
        fullName: target.fullName === null ? null : withoutLinks(target.fullName),
        bio: target.bio === null ? null : withoutLinks(target.bio),
        profileImageUrl: target.profileImageUrl === null ? null : archiveMediaUrlAnchor(target.profileImageUrl),
        followersCount: target.followersCount,
        followingCount: target.followingCount,
        isPrivate: target.isPrivate,
    };
}

export function projectDevStandardArchiveRelationship(row: AnalysisV2CanonicalRelationshipRow): AnalysisV2CanonicalRelationshipRow {
    return {
        username: row.username,
        isPrivate: row.isPrivate,
        isVerified: row.isVerified,
        fullName: row.fullName === null ? null : withoutLinks(row.fullName),
        profilePicUrl: row.profilePicUrl === null ? null : archiveMediaUrlAnchor(row.profilePicUrl),
    };
}

export function projectDevStandardArchiveTargetEvidence(row: AnalysisV2CanonicalTargetEvidenceRow): AnalysisV2CanonicalTargetEvidenceRow {
    return {
        actorUsername: row.actorUsername,
        postId: archiveIdentifier(row.postId),
        signal: row.signal,
        sourceInteractionId: archiveIdentifier(row.sourceInteractionId),
        occurredAt: row.occurredAt,
        content: row.content === null ? null : withoutLinks(row.content),
    };
}
