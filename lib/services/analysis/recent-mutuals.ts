import { RECENT_MUTUAL_BONUS_MAX } from '@/lib/constants/scoring';

const RECENT_MUTUAL_WINDOW = 10;
const RECENT_MUTUAL_FEMALE_LIMIT = 5;

export type RecentMutualFemaleRank = 1 | 2 | 3 | 4 | 5;

function usernameKey(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

/**
 * The relationship provider returns newest mutuals first. A reciprocal decay keeps the newest
 * relationship meaningful without letting ordering add more than twenty feature-score points.
 * Appending older relationships does not change an existing account's bonus.
 */
export function getRecentMutualBonus(
    username: string,
    orderedMutualUsernames: readonly string[]
): number {
    const target = usernameKey(username);
    if (!target) return 0;

    const seen = new Set<string>();
    let uniqueRank = 0;
    for (const value of orderedMutualUsernames) {
        const key = usernameKey(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        uniqueRank += 1;
        if (key === target) return RECENT_MUTUAL_BONUS_MAX / uniqueRank;
    }

    return 0;
}

export function orderedMutualUsernamesFromStepData(stepData: unknown): string[] {
    if (!stepData || typeof stepData !== 'object' || Array.isArray(stepData)) return [];
    const mutualFollows = (stepData as { mutualFollows?: unknown }).mutualFollows;
    if (!Array.isArray(mutualFollows)) return [];

    return mutualFollows.filter(
        (username): username is string => typeof username === 'string' && usernameKey(username) !== ''
    );
}

export function inferRecentMutualFemaleRanks(
    orderedMutualUsernames: readonly string[],
    publicFemaleUsernames: readonly string[]
): ReadonlyMap<string, RecentMutualFemaleRank> {
    const femaleUsernames = new Set(publicFemaleUsernames.map(usernameKey));
    const ranked = new Map<string, RecentMutualFemaleRank>();
    const seen = new Set<string>();

    for (const username of orderedMutualUsernames.slice(0, RECENT_MUTUAL_WINDOW)) {
        const key = usernameKey(username);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!femaleUsernames.has(key)) continue;

        ranked.set(key, (ranked.size + 1) as RecentMutualFemaleRank);
        if (ranked.size === RECENT_MUTUAL_FEMALE_LIMIT) break;
    }

    return ranked;
}
