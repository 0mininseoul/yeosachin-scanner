import { describe, expect, it } from 'vitest';
import {
    deriveConciergePrivacyPartition,
    validateCanonicalConciergeCorrection,
} from './concierge-basic-correction';

function profile(username: string, isPrivate: boolean) {
    return {
        username,
        followersCount: 10,
        followingCount: 10,
        postsCount: 0,
        isPrivate,
        isVerified: false,
        latestPosts: [],
    };
}

function relationship(username: string, side: 'follower' | 'following', isPrivate: boolean, ordinal: number) {
    return { username, side, isPrivate, isVerified: false, fullName: null, ordinal };
}

describe('concierge basic correction', () => {
    it('derives privacy from profile and both relationship sides instead of defaulting public', () => {
        const partition = deriveConciergePrivacyPartition({
            profiles: [profile('public.one', false), profile('private.one', true)],
            relationshipRows: [
                relationship('public.one', 'follower', false, 1),
                relationship('private.one', 'follower', true, 2),
                relationship('public.one', 'following', false, 1),
                relationship('private.one', 'following', true, 2),
            ],
        });

        expect(partition.publicProfiles.map(row => row.username)).toEqual(['public.one']);
        expect(partition.privateProfiles.map(row => row.username)).toEqual(['private.one']);
        expect(partition.orderedMutualUsernames).toEqual(['public.one', 'private.one']);
    });

    it('fails closed when relationship privacy disagrees with the collected profile', () => {
        expect(() => deriveConciergePrivacyPartition({
            profiles: [profile('conflict', true)],
            relationshipRows: [
                relationship('conflict', 'follower', false, 1),
                relationship('conflict', 'following', false, 1),
            ],
        })).toThrow('CONCIERGE_PRIVACY_PROVIDER_EVIDENCE_CONFLICT');
    });

    it('uses the collected profile state when one retained relationship side is absent', () => {
        const partition = deriveConciergePrivacyPartition({
            profiles: [profile('public.one', false), profile('private.one', true)],
            relationshipRows: [
                relationship('public.one', 'follower', false, 1),
                relationship('private.one', 'following', true, 2),
            ],
        });

        expect(partition.publicProfiles).toHaveLength(1);
        expect(partition.privateProfiles).toHaveLength(1);
    });

    it('requires reconciled gender totals and canonical narratives for high-risk rows', () => {
        const result = {
            femaleRows: [{ risk_grade: 'high_risk', risk_analysis: ['첫 문장', '둘째 문장'] }],
            privateRows: [],
            counts: { male: 1, female: 1, unknownPublic: 0, unknown: 1 },
        } as never;
        expect(() => validateCanonicalConciergeCorrection({
            fetchedCount: 3,
            partition: {
                publicProfiles: [profile('one', false), profile('two', false)],
                privateProfiles: [profile('private', true)],
            },
            result,
        })).not.toThrow();
        expect(() => validateCanonicalConciergeCorrection({
            fetchedCount: 4,
            partition: {
                publicProfiles: [profile('one', false), profile('two', false)],
                privateProfiles: [],
            },
            result,
        })).toThrow('CONCIERGE_COUNT_RECONCILIATION_FAILED');
    });
});
