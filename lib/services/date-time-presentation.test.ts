import { describe, expect, it } from 'vitest';
import { formatKstDateTime } from './date-time-presentation';

describe('formatKstDateTime', () => {
    it('uses the next KST calendar day when a UTC instant crosses midnight in Seoul', () => {
        expect(formatKstDateTime('2026-07-24T15:30:00.000Z'))
            .toBe('2026. 7. 25. AM 12:30');
    });

    it('formats equivalent Z and +09:00 instants identically', () => {
        expect(formatKstDateTime('2026-07-24T03:04:00.000Z'))
            .toBe(formatKstDateTime('2026-07-24T12:04:00.000+09:00'));
    });

    it.each([
        undefined,
        null,
        '',
        'not-a-date',
        new Date(Number.NaN),
    ])('returns a safe fallback without throwing for invalid input %#', (value) => {
        expect(() => formatKstDateTime(value)).not.toThrow();
        expect(formatKstDateTime(value)).toBe('날짜 미상');
    });

    it('returns stable Korean date and short 12-hour KST time text', () => {
        expect(formatKstDateTime('2026-07-24T03:04:00.000Z'))
            .toBe('2026. 7. 24. PM 12:04');
    });
});
