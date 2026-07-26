import { describe, expect, it } from 'vitest';
import { formatKstDateTime } from './date-time-presentation';

// The rendered day-period token for ko-KR varies by ICU/CLDR build ("오전" in
// browsers, "AM" on some Node builds), so nothing below hardcodes it. These
// pin the two properties that matter: the Asia/Seoul instant conversion, and
// parity with the format this helper replaced.
const PREVIOUS_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
});

describe('formatKstDateTime', () => {
    it('uses the next KST calendar day when a UTC instant crosses midnight in Seoul', () => {
        // 15:30Z is 00:30 the next day in Asia/Seoul. Dropping the timeZone pin
        // renders 7. 24. under any timezone west of KST.
        expect(formatKstDateTime('2026-07-24T15:30:00.000Z'))
            .toContain('2026. 7. 25.');
        expect(formatKstDateTime('2026-07-24T15:30:00.000Z'))
            .not.toContain('2026. 7. 24.');
    });

    it('formats equivalent Z and +09:00 instants identically', () => {
        expect(formatKstDateTime('2026-07-24T03:04:00.000Z'))
            .toBe(formatKstDateTime('2026-07-24T12:04:00.000+09:00'));
    });

    it.each([
        '2026-07-24T03:04:00.000Z',
        '2026-07-24T15:30:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-12-31T14:59:59.000Z',
    ])('renders %s exactly as the format it replaced', (value) => {
        expect(formatKstDateTime(value)).toBe(PREVIOUS_FORMATTER.format(new Date(value)));
    });

    it('accepts Date and epoch-millisecond inputs', () => {
        const instant = '2026-07-24T03:04:00.000Z';
        const expected = PREVIOUS_FORMATTER.format(new Date(instant));
        expect(formatKstDateTime(new Date(instant))).toBe(expected);
        expect(formatKstDateTime(Date.parse(instant))).toBe(expected);
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

    it('does not resolve null to the unix epoch', () => {
        // new Date(null) is 1970-01-01, so a missing null guard would render a
        // 1970 date instead of the fallback label.
        expect(formatKstDateTime(null)).not.toContain('1970');
    });
});
