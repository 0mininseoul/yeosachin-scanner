import { describe, expect, it } from 'vitest';
import { computePrecheckoutBliteCandidateRange } from './blite-range';

describe('computePrecheckoutBliteCandidateRange', () => {
    it('is deterministic for the same inputs', () => {
        const first = computePrecheckoutBliteCandidateRange(1_200, 900);
        const second = computePrecheckoutBliteCandidateRange(1_200, 900);
        expect(second).toEqual(first);
    });

    it('always returns integers with min < max and min >= 0', () => {
        const cases: Array<[number, number]> = [
            [0, 0], [0, 500], [500, 0], [1, 1], [50, 80], [400, 400],
            [10_000, 8_000], [2_000_000, 1_000], [5_000_000, 5_000_000],
        ];
        for (const [followers, following] of cases) {
            const range = computePrecheckoutBliteCandidateRange(followers, following);
            expect(Number.isInteger(range.min)).toBe(true);
            expect(Number.isInteger(range.max)).toBe(true);
            expect(range.min).toBeGreaterThanOrEqual(0);
            expect(range.max).toBeGreaterThan(range.min);
        }
    });

    it('produces a sane non-degenerate range for a zero-follow account', () => {
        const range = computePrecheckoutBliteCandidateRange(0, 0);
        expect(range).toEqual({ min: 0, max: 1 });
    });

    it('produces a zero-floor range when following is zero but followers exist', () => {
        const range = computePrecheckoutBliteCandidateRange(5_000, 0);
        expect(range.min).toBe(0);
        expect(range.max).toBeGreaterThan(0);
    });

    it('scales up with a small account and keeps a broad, non-degenerate spread', () => {
        const range = computePrecheckoutBliteCandidateRange(50, 80);
        // circleCeiling=50, midpoint=round(50*0.12)=6 -> min=floor(6*0.6)=3, max=ceil(6*1.4)=9
        expect(range).toEqual({ min: 3, max: 9 });
    });

    it('clamps very large accounts to a sane ceiling instead of an unbounded number', () => {
        const range = computePrecheckoutBliteCandidateRange(10_000_000, 8_000_000);
        expect(range.max).toBeLessThanOrEqual(560); // capped well below the raw follow counts
        expect(range.min).toBeLessThan(range.max);
    });

    it('bounds the range by the smaller of followers/following for a lopsided account', () => {
        const range = computePrecheckoutBliteCandidateRange(2_000_000, 1_000);
        expect(range.max).toBeLessThanOrEqual(1_000);
    });

    it('never produces a single-number output (only a min/max band)', () => {
        const range = computePrecheckoutBliteCandidateRange(300, 400);
        expect(Object.keys(range).sort()).toEqual(['max', 'min']);
    });

    it('rejects negative or non-integer inputs', () => {
        expect(() => computePrecheckoutBliteCandidateRange(-1, 10)).toThrow();
        expect(() => computePrecheckoutBliteCandidateRange(10, -1)).toThrow();
        expect(() => computePrecheckoutBliteCandidateRange(1.5, 10)).toThrow();
        expect(() => computePrecheckoutBliteCandidateRange(10, Number.NaN)).toThrow();
    });
});
