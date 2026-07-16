import { describe, expect, it } from 'vitest';
import {
    INSTAGRAM_USERNAME_MAX_LENGTH,
    isInstagramUsername,
    mergeInstagramMentions,
} from './username';

describe('Instagram username contract', () => {
    it('accepts the documented character set up to 30 characters', () => {
        expect(isInstagramUsername('fixture.user_00')).toBe(true);
        expect(isInstagramUsername('a'.repeat(INSTAGRAM_USERNAME_MAX_LENGTH))).toBe(true);
    });

    it('rejects empty, overlong, prefixed, and malformed values', () => {
        expect(isInstagramUsername('')).toBe(false);
        expect(isInstagramUsername('a'.repeat(INSTAGRAM_USERNAME_MAX_LENGTH + 1))).toBe(false);
        expect(isInstagramUsername('@username')).toBe(false);
        expect(isInstagramUsername('invalid user')).toBe(false);
    });

    it('bounds merged parent and carousel child mentions at 50', () => {
        const childCaptions = Array.from(
            { length: 60 },
            (_, index) => `@child_${index}`
        );

        const mentions = mergeInstagramMentions([], childCaptions);

        expect(mentions).toHaveLength(50);
        expect(mentions[0]).toBe('child_0');
        expect(mentions[49]).toBe('child_49');
    });

    it('reserves merge capacity for valid parent mentions before child mentions', () => {
        const parentMentions = Array.from(
            { length: 49 },
            (_, index) => `parent_${index}`
        );

        const mentions = mergeInstagramMentions(
            parentMentions,
            ['@child_first @child_second']
        );

        expect(mentions).toEqual([...parentMentions, 'child_first']);
    });

    it('does not let invalid or duplicate mentions consume merge capacity', () => {
        const childMentions = Array.from(
            { length: 50 },
            (_, index) => `@child_${index}`
        ).join(' ');

        const mentions = mergeInstagramMentions(
            ['Parent.One', 'parent.one', 'invalid user', 'x'.repeat(31)],
            [`@PARENT.ONE ${childMentions}`]
        );

        expect(mentions).toEqual([
            'parent.one',
            ...Array.from({ length: 49 }, (_, index) => `child_${index}`),
        ]);
    });
});
