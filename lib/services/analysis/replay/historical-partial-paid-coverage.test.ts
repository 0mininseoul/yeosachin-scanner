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

    it('uses persisted exact unavailable counts while retaining the legacy 12-item fallback', () => {
        const identities: HistoricalPartialSourceIdentity[] = Array.from(
            { length: 2 },
            (_, index) => ({
                ordinal: index + 1,
                username: `profile_${index + 1}`,
                partition: 'public',
            }),
        );
        const base = {
            sourceUniverseDigest: historicalPartialSourceUniverseDigest(identities),
            sourceIdentities: identities,
            profiles: [{
                ordinal: 1,
                username: 'profile_1',
                isPrivate: false,
                media: Array.from({ length: 5 }),
                coverage: { selectedCount: 5 },
            }],
        };

        expect(historicalPartialPaidCoverage({
            ...base,
            mediaUnavailable: [{ ordinal: 2, selectedMediaCount: 3 }],
        }).conservativeSourceMedia).toBe(8);
        expect(historicalPartialPaidCoverage({
            ...base,
            mediaUnavailable: [{ ordinal: 2 }],
        }).conservativeSourceMedia).toBe(17);
    });

    it('admits the observed 379/385 and 1894/1915 only through exact-count diagnostic mode', () => {
        const retainedProfiles = 379;
        const sourceProfiles = 385;
        const identities: HistoricalPartialSourceIdentity[] = Array.from(
            { length: sourceProfiles },
            (_, index) => ({
                ordinal: index + 1,
                username: `profile_${index + 1}`,
                partition: 'public',
            }),
        );
        const exactCounts = [4, 4, 4, 3, 3, 3];
        const input = {
            sourceUniverseDigest: historicalPartialSourceUniverseDigest(identities),
            sourceIdentities: identities,
            profiles: Array.from({ length: retainedProfiles }, (_, index) => ({
                ordinal: index + 1,
                username: `profile_${index + 1}`,
                isPrivate: false,
                media: index === 0 ? Array.from({ length: 1_894 }) : [],
                coverage: { selectedCount: index === 0 ? 1_894 : 0 },
            })),
            mediaUnavailable: exactCounts.map((selectedMediaCount, index) => ({
                ordinal: retainedProfiles + index + 1,
                selectedMediaCount,
            })),
        };

        const standard = historicalPartialPaidCoverage(input);
        const diagnostic = historicalPartialPaidCoverage(
            input,
            { mode: 'diagnostic-low-partial-coverage' },
        );

        expect(standard).toMatchObject({
            eligible: false,
            conservativeSourceMedia: 1_915,
        });
        expect(diagnostic).toMatchObject({
            eligible: true,
            exactSelectedCountsAvailable: true,
            retainedProfiles: 379,
            sourceProfiles: 385,
            retainedMedia: 1_894,
            conservativeSourceMedia: 1_915,
            profileRetentionBps: 9_844,
            mediaRetentionBps: 9_890,
        });

        const legacy = {
            ...input,
            mediaUnavailable: input.mediaUnavailable.map(({ ordinal }) => ({ ordinal })),
        };
        expect(historicalPartialPaidCoverage(
            legacy,
            { mode: 'diagnostic-low-partial-coverage' },
        )).toMatchObject({ eligible: false, exactSelectedCountsAvailable: false });
    });
});
