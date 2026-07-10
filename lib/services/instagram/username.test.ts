import { describe, expect, it } from 'vitest';
import {
    INSTAGRAM_USERNAME_MAX_LENGTH,
    isInstagramUsername,
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
});
