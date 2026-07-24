// Pure sequencing for the landing hero's typewriter verdicts. The component
// increments a single "revealed characters" budget over time; this module maps
// that budget onto per-row, per-line visible substrings so the rows type out in
// order and a row is only marked complete once every one of its lines is done.

export interface VerdictRowInput {
    readonly lines: readonly string[];
}

export interface VerdictRowReveal {
    lines: string[];
    complete: boolean;
}

export function totalVerdictChars(rows: readonly VerdictRowInput[]): number {
    return rows.reduce(
        (sum, row) => sum + row.lines.reduce((lineSum, line) => lineSum + line.length, 0),
        0,
    );
}

export function revealVerdicts(
    rows: readonly VerdictRowInput[],
    revealedChars: number,
): VerdictRowReveal[] {
    let budget = Math.max(0, Math.floor(revealedChars));
    return rows.map((row) => {
        const lines = row.lines.map((line) => {
            const take = Math.min(budget, line.length);
            budget -= take;
            return line.slice(0, take);
        });
        const complete = lines.every((visible, index) => visible.length === row.lines[index].length);
        return { lines, complete };
    });
}
