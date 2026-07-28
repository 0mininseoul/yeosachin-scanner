import { DEMO_V3_SOURCE_FIXTURE } from './demo-v3-source-fixture';

type SourceCard = { readonly imageSortOrdinal: number };

function uniqueByImageOrdinal<T extends SourceCard>(rows: readonly T[]): T[] {
    const seen = new Set<number>();
    return rows.filter(row => !seen.has(row.imageSortOrdinal) && seen.add(row.imageSortOrdinal));
}

/**
 * Generated v4 input derived solely from the committed, redacted v3 artifact.
 * The first occurrence of each public asset ordinal is retained; private cards
 * were already one-to-one and are retained in full. Do not hand-edit.
 */
const publicCards = uniqueByImageOrdinal(DEMO_V3_SOURCE_FIXTURE.public);
const privateCards = DEMO_V3_SOURCE_FIXTURE.private;

if (publicCards.length !== 84 || privateCards.length !== 145
    || new Set(privateCards.map(row => row.imageSortOrdinal)).size !== privateCards.length) {
    throw new Error('The v4 demo source fixture requires exactly 84 public and 145 private cards.');
}

export const DEMO_V4_SOURCE_FIXTURE = Object.freeze({
    public: Object.freeze(publicCards),
    private: Object.freeze(privateCards),
});
