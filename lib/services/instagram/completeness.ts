import type { InstagramFollower } from '@/lib/types/instagram';
import { isInstagramUsername } from './username';

export const RELATIONSHIP_MIN_COVERAGE_RATIO = 0.99;

export function expectedRelationshipCount(declaredCount: unknown, limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500_000) {
        throw new Error('SCRAPING_CONFIG_ERROR: relationship limit is invalid.');
    }
    if (!Number.isSafeInteger(declaredCount) || (declaredCount as number) < 0) {
        throw new Error('SCRAPING_SCHEMA_ERROR: profile relationship count is invalid.');
    }
    return Math.min(declaredCount as number, limit);
}

export function minimumCompleteRelationshipCount(expectedCount: number): number {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new Error('SCRAPING_CONFIG_ERROR: expected relationship count is invalid.');
    }
    return Math.ceil(expectedCount * RELATIONSHIP_MIN_COVERAGE_RATIO);
}

export function validateRelationshipCompleteness<T extends InstagramFollower>(
    result: T[],
    expectedCount: number
): T[] {
    const unique = new Map<string, T>();
    for (const row of result) {
        const username = typeof row?.username === 'string' ? row.username.trim() : '';
        if (!isInstagramUsername(username)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: relationship row username is invalid.');
        }
        const key = username.toLowerCase();
        if (!unique.has(key)) unique.set(key, row);
    }

    const uniqueResult = [...unique.values()];
    const minimumComplete = minimumCompleteRelationshipCount(expectedCount);
    if (uniqueResult.length < minimumComplete) {
        throw new Error(
            `SCRAPING_INCOMPLETE_ERROR: collected ${uniqueResult.length} unique of ${expectedCount} relationships; ` +
            `${RELATIONSHIP_MIN_COVERAGE_RATIO * 100}% coverage is required.`
        );
    }
    return uniqueResult;
}
