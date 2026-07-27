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
        expect(coverage(380, 385, 990, 1_000).eligible).toBe(true);
        expect(coverage(379, 385, 990, 1_000).eligible).toBe(false);
    });

    it('accepts exactly 99% media coverage and rejects one item below it', () => {
        expect(coverage(200, 200, 990, 1_000).eligible).toBe(true);
        expect(coverage(200, 200, 989, 1_000).eligible).toBe(false);
    });
});
