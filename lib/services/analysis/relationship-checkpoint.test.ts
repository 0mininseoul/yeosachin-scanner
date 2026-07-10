import { describe, expect, it } from 'vitest';
import { parseRelationshipCheckpoint } from './relationship-checkpoint';

const follower = {
    username: 'candidate.user',
    fullName: 'Candidate',
    profilePicUrl: 'https://example.com/profile.jpg',
    isPrivate: false,
    isVerified: false,
};

describe('paid relationship checkpoint', () => {
    it('restores both lists so a later collect retry does not rerun paid actors', () => {
        expect(parseRelationshipCheckpoint({
            followers: [follower],
            following: [follower],
        }, 500)).toEqual({
            followers: [follower],
            following: [follower],
        });
    });

    it('restores one completed parallel list while the other Actor still needs to run', () => {
        expect(parseRelationshipCheckpoint({
            followers: [follower],
        }, 500)).toEqual({
            followers: [follower],
        });
    });

    it('fails closed on oversized or malformed persisted data', () => {
        expect(() => parseRelationshipCheckpoint({
            followers: Array.from({ length: 2 }, () => follower),
            following: [],
        }, 1)).toThrow('CHECKPOINT');
        expect(() => parseRelationshipCheckpoint({
            followers: [{ ...follower, username: 'invalid user' }],
            following: [],
        }, 500)).toThrow('CHECKPOINT');
    });
});
