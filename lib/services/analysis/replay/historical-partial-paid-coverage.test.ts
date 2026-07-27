import { describe, expect, it } from 'vitest';
import {
    historicalPartialPaidCoverage,
    historicalPartialSourceUniverseDigest,
    type HistoricalPartialSourceIdentity,
} from './historical-partial-available-artifact';

function coverage(retainedProfiles: number, sourceProfiles: number, retainedMedia: number, selectedMedia: number) {
    const identities: HistoricalPartialSourceIdentity[] = Array.from({ length: sourceProfiles }, (_, index) => ({
        ordinal: index + 1,
        username: `profile_${index + 1}`,
        partition: index < retainedProfiles ? 'public' : 'fetch_terminal',
    }));
    return historicalPartialPaidCoverage({
        sourceUniverseDigest: historicalPartialSourceUniverseDigest(identities),
        sourceIdentities: identities,
        mediaUnavailable: [],
        profiles: Array.from({ length: retainedProfiles }, (_, index) => ({
            ordinal: index + 1,
            username: `profile_${index + 1}`,
            isPrivate: false,
            media: Array.from({ length: index === 0 ? retainedMedia : 0 }),
            coverage: { selectedCount: index === 0 ? selectedMedia : 0 },
        })),
    });
}

describe('historical partial paid coverage', () => {
    it('accepts observed profile coverage and rejects the immediately lower retained profile count', () => {
        expect(coverage(380, 385, 1_904, 1_915).eligible).toBe(true);
        expect(coverage(379, 385, 1_904, 1_915).eligible).toBe(false);
    });

    it('seals the audited media floor and rejects exactly one fewer item with either denominator', () => {
        expect(coverage(385, 385, 1_904, 1_915).eligible).toBe(true);
        expect(coverage(385, 385, 1_903, 1_915).eligible).toBe(false);
        expect(coverage(385, 385, 1_903, 1_916).eligible).toBe(false);
    });

    it('also retains the conservative 99% missing-media ratio fence above the audited volume floor', () => {
        expect(coverage(385, 385, 1_904, 1_923).eligible).toBe(true);
        expect(coverage(385, 385, 1_904, 1_924).eligible).toBe(false);
    });
});
