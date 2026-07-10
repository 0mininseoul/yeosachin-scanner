import { describe, expect, it } from 'vitest';
import {
    buildCombinedAnalysisCacheVersion,
    createCombinedAnalysisCacheEntry,
    createCombinedProfileSnapshot,
    DEFAULT_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS,
    getCombinedProfileSnapshotTtlHours,
    parseCombinedAnalysisCacheEntry,
    parseCombinedProfileSnapshot,
    tryCreateCombinedProfileSnapshot,
} from './combined-cache';

const validResult = {
    gender: 'male' as const,
    genderConfidence: 0.9,
    genderReasoning: 'evidence',
};

const capturedAt = '2026-07-10T00:00:00.000Z';
const validSnapshot = createCombinedProfileSnapshot({
    profile: {
        username: 'sample.user',
        profilePicUrl: 'https://scontent.cdninstagram.com/profile.jpg?signature=secret',
        fullName: 'Sample User',
        bio: 'bio',
        isPrivate: false,
    },
    recentPosts: [{
        id: '1234567890',
        shortCode: 'Post_123',
        caption: 'caption',
        hashtags: ['sample'],
        imageUrl: 'https://scontent.cdninstagram.com/post.jpg?signature=secret',
        type: 'image',
        likesCount: 12,
        commentsCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
        taggedUsers: ['target.user'],
        mentionedUsers: ['mentioned.user'],
    }],
}, capturedAt);

describe('combined analysis cache envelope', () => {
    it('accepts only a schema-valid result with the current version', () => {
        const entry = createCombinedAnalysisCacheEntry('version-a', validResult);
        expect(parseCombinedAnalysisCacheEntry(entry, 'version-a')).toEqual(validResult);
        expect(parseCombinedAnalysisCacheEntry(entry, 'version-b')).toBeNull();
    });

    it('treats legacy and malformed cached JSON as a miss', () => {
        expect(parseCombinedAnalysisCacheEntry(validResult, 'version-a')).toBeNull();
        expect(parseCombinedAnalysisCacheEntry({
            version: 'version-a',
            result: { ...validResult, genderConfidence: 12 },
        }, 'version-a')).toBeNull();
    });

    it('changes versions when model, prompt, schema, or image policy changes', () => {
        const baseline = buildCombinedAnalysisCacheVersion({
            modelName: 'model-a',
            promptTemplate: 'prompt-a',
            schemaVersion: 'schema-a',
            costOptimized: false,
        });
        expect(buildCombinedAnalysisCacheVersion({
            modelName: 'model-b',
            promptTemplate: 'prompt-a',
            schemaVersion: 'schema-a',
            costOptimized: false,
        })).not.toBe(baseline);
        expect(buildCombinedAnalysisCacheVersion({
            modelName: 'model-a',
            promptTemplate: 'prompt-b',
            schemaVersion: 'schema-a',
            costOptimized: false,
        })).not.toBe(baseline);
        expect(buildCombinedAnalysisCacheVersion({
            modelName: 'model-a',
            promptTemplate: 'prompt-a',
            schemaVersion: 'schema-b',
            costOptimized: false,
        })).not.toBe(baseline);
        expect(buildCombinedAnalysisCacheVersion({
            modelName: 'model-a',
            promptTemplate: 'prompt-a',
            schemaVersion: 'schema-a',
            costOptimized: true,
        })).not.toBe(baseline);
    });

    it('round-trips a strict fresh profile snapshot without dropping tag data', () => {
        const entry = createCombinedAnalysisCacheEntry('version-a', validResult, validSnapshot);
        expect(parseCombinedProfileSnapshot(entry, 'version-a', {
            nowMs: Date.parse(capturedAt) + 11 * 60 * 60 * 1_000,
            ttlHours: 12,
        })).toEqual(validSnapshot.account);
        expect(parseCombinedProfileSnapshot(entry, 'version-b', {
            nowMs: Date.parse(capturedAt),
            ttlHours: 12,
        })).toBeNull();
        expect(validSnapshot.account.recentPosts[0]).toMatchObject({
            id: '1234567890',
            shortCode: 'Post_123',
            likesCount: 12,
            commentsCount: 3,
            taggedUsers: ['target.user'],
            mentionedUsers: ['mentioned.user'],
        });
    });

    it('rejects expired, far-future, absent, and malformed profile snapshots', () => {
        const entry = createCombinedAnalysisCacheEntry('version-a', validResult, validSnapshot);
        expect(parseCombinedProfileSnapshot(entry, 'version-a', {
            nowMs: Date.parse(capturedAt) + 12 * 60 * 60 * 1_000 + 1,
            ttlHours: 12,
        })).toBeNull();
        expect(parseCombinedProfileSnapshot(entry, 'version-a', {
            nowMs: Date.parse(capturedAt) - 5 * 60 * 1_000 - 1,
            ttlHours: 12,
        })).toBeNull();
        expect(parseCombinedProfileSnapshot(
            createCombinedAnalysisCacheEntry('version-a', validResult),
            'version-a',
            { nowMs: Date.parse(capturedAt), ttlHours: 12 }
        )).toBeNull();
        expect(parseCombinedProfileSnapshot({
            ...entry,
            profileSnapshot: {
                ...validSnapshot,
                account: {
                    ...validSnapshot.account,
                    recentPosts: [{
                        ...validSnapshot.account.recentPosts[0],
                        imageUrl: 'http://169.254.169.254/metadata',
                    }],
                },
            },
        }, 'version-a', {
            nowMs: Date.parse(capturedAt),
            ttlHours: 12,
        })).toBeNull();
    });

    it('uses a validated 6-24 hour snapshot TTL with a 12 hour default', () => {
        expect(getCombinedProfileSnapshotTtlHours(undefined))
            .toBe(DEFAULT_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS);
        expect(getCombinedProfileSnapshotTtlHours('6')).toBe(6);
        expect(getCombinedProfileSnapshotTtlHours('24')).toBe(24);
        expect(getCombinedProfileSnapshotTtlHours('5')).toBe(12);
        expect(getCombinedProfileSnapshotTtlHours('25')).toBe(12);
        expect(getCombinedProfileSnapshotTtlHours('12.5')).toBe(12);
        expect(getCombinedProfileSnapshotTtlHours('invalid')).toBe(12);
    });

    it('keeps a valid result cache entry when an optional snapshot is invalid', () => {
        const invalidSnapshot = tryCreateCombinedProfileSnapshot({
            profile: {
                username: 'sample.user',
                profilePicUrl: 'http://169.254.169.254/metadata',
                isPrivate: false,
            },
            recentPosts: [],
        }, capturedAt);
        expect(invalidSnapshot).toBeNull();

        const entry = createCombinedAnalysisCacheEntry(
            'version-a',
            validResult,
            invalidSnapshot ?? undefined
        );
        expect(parseCombinedAnalysisCacheEntry(entry, 'version-a')).toEqual(validResult);
        expect(parseCombinedProfileSnapshot(entry, 'version-a', {
            nowMs: Date.parse(capturedAt),
            ttlHours: 12,
        })).toBeNull();
    });
});
