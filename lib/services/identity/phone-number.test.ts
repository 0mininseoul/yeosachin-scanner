import { describe, expect, it } from 'vitest';
import { normalizeKoreanMobileNumber } from './phone-number';

describe('normalizeKoreanMobileNumber', () => {
    it.each([
        ['010-1234-5678', '+821012345678'],
        ['010 1234 5678', '+821012345678'],
        ['(010) 1234-5678', '+821012345678'],
        ['+82 10-1234-5678', '+821012345678'],
        ['821012345678', '+821012345678'],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeKoreanMobileNumber(input)).toBe(expected);
    });

    it.each([
        null,
        undefined,
        '',
        '02-123-4567',
        '+1 212 555 0100',
        '010-12-34',
        'abc010-1234-5678',
        '010-1234-5678abc',
        '010-1234-5678 ext 9',
    ])(
        'rejects %s',
        input => {
            expect(normalizeKoreanMobileNumber(input)).toBeNull();
        }
    );
});
