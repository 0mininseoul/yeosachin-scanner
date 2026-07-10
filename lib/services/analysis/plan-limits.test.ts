import { describe, expect, it } from 'vitest';
import {
    MAX_PUBLIC_PROFILES_PER_ANALYSIS,
    capPublicProfiles,
    getRelationshipScrapeLimit,
} from './plan-limits';

describe('analysis plan collection limits', () => {
    it('maps Basic and Standard to their relationship caps', () => {
        expect(getRelationshipScrapeLimit('basic')).toBe(500);
        expect(getRelationshipScrapeLimit('standard')).toBe(1_000);
        expect(getRelationshipScrapeLimit(undefined)).toBe(500);
        expect(getRelationshipScrapeLimit('unknown')).toBe(500);
    });

    it('caps only the downstream public profile analysis stage', () => {
        const profiles = Array.from({ length: 400 }, (_, index) => index);
        expect(capPublicProfiles(profiles)).toHaveLength(MAX_PUBLIC_PROFILES_PER_ANALYSIS);
        expect(profiles).toHaveLength(400);
    });
});
