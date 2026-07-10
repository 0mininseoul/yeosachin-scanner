import { describe, expect, it } from 'vitest';
import { instagramTimestampMs, normalizeInstagramTimestamp } from './timestamp';

describe('Instagram timestamps', () => {
    it('normalizes Unix seconds, Unix milliseconds, and ISO offsets', () => {
        expect(normalizeInstagramTimestamp('1767225600')).toBe('2026-01-01T00:00:00.000Z');
        expect(normalizeInstagramTimestamp(1_767_225_600_000)).toBe('2026-01-01T00:00:00.000Z');
        expect(normalizeInstagramTimestamp('2026-01-01T09:00:00+09:00'))
            .toBe('2026-01-01T00:00:00.000Z');
    });

    it('fails closed for missing and invalid values', () => {
        expect(normalizeInstagramTimestamp('')).toBe('');
        expect(normalizeInstagramTimestamp('not-a-date')).toBe('');
        expect(instagramTimestampMs(undefined)).toBe(Number.NEGATIVE_INFINITY);
    });
});
