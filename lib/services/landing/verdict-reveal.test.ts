import { describe, expect, it } from 'vitest';
import { revealVerdicts, totalVerdictChars } from './verdict-reveal';

describe('verdict reveal sequencing', () => {
    const rows = [
        { lines: ['abc', 'de'] },
        { lines: ['fg'] },
    ] as const;

    it('sums every character across all rows and lines', () => {
        expect(totalVerdictChars(rows)).toBe(7);
    });

    it('reveals nothing and marks no row complete at zero characters', () => {
        expect(revealVerdicts(rows, 0)).toEqual([
            { lines: ['', ''], complete: false },
            { lines: [''], complete: false },
        ]);
    });

    it('fills the first line before advancing to later lines and rows', () => {
        expect(revealVerdicts(rows, 2)).toEqual([
            { lines: ['ab', ''], complete: false },
            { lines: [''], complete: false },
        ]);
    });

    it('marks a row complete only once all of its lines are fully typed', () => {
        expect(revealVerdicts(rows, 5)).toEqual([
            { lines: ['abc', 'de'], complete: true },
            { lines: [''], complete: false },
        ]);
    });

    it('carries remaining characters into the next row', () => {
        expect(revealVerdicts(rows, 6)).toEqual([
            { lines: ['abc', 'de'], complete: true },
            { lines: ['f'], complete: false },
        ]);
    });

    it('completes every row once the full budget is reached', () => {
        expect(revealVerdicts(rows, 7)).toEqual([
            { lines: ['abc', 'de'], complete: true },
            { lines: ['fg'], complete: true },
        ]);
    });

    it('clamps an over-budget count to the full text', () => {
        expect(revealVerdicts(rows, 999)).toEqual([
            { lines: ['abc', 'de'], complete: true },
            { lines: ['fg'], complete: true },
        ]);
    });

    it('treats a negative count as zero', () => {
        expect(revealVerdicts(rows, -5)).toEqual([
            { lines: ['', ''], complete: false },
            { lines: [''], complete: false },
        ]);
    });
});
