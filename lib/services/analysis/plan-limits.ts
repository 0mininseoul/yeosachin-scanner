export const BASIC_RELATIONSHIP_LIMIT = 500;
export const STANDARD_RELATIONSHIP_LIMIT = 1_000;
export const MAX_PUBLIC_PROFILES_PER_ANALYSIS = 350;

export function getRelationshipScrapeLimit(planType: unknown): number {
    return planType === 'standard'
        ? STANDARD_RELATIONSHIP_LIMIT
        : BASIC_RELATIONSHIP_LIMIT;
}

export function capPublicProfiles<T>(profiles: T[]): T[] {
    return profiles.slice(0, MAX_PUBLIC_PROFILES_PER_ANALYSIS);
}
