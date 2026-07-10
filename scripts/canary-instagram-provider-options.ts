import type { FlashRelationshipKind } from '../lib/services/instagram/providers/flashapi';
import type {
    ProviderCallContext,
    ScraperProvider,
} from '../lib/services/instagram/providers/types';
import type { InstagramFollower } from '../lib/types/instagram';
import { validateRelationshipCompleteness } from '../lib/services/instagram/completeness';

export type CanaryRelationship = FlashRelationshipKind | 'both';

export class CanaryRelationshipResultError extends Error {
    constructor(
        readonly originalError: unknown,
        readonly rows: InstagramFollower[]
    ) {
        super(originalError instanceof Error ? originalError.message : 'canary relationship failure');
        this.name = 'CanaryRelationshipResultError';
    }
}

export function parseCanaryRelationship(value: string | undefined): CanaryRelationship | null {
    if (value === undefined) return 'both';
    return value === 'followers' || value === 'following' || value === 'both'
        ? value
        : null;
}

export function shouldRunCanaryRelationship(
    selection: CanaryRelationship,
    kind: FlashRelationshipKind
): boolean {
    return selection === 'both' || selection === kind;
}

export function canaryRelationshipCallLimit(
    cliLimit: number,
    expectedCount?: number
): number {
    return expectedCount === undefined
        ? cliLimit
        : Math.min(cliLimit, expectedCount);
}

export function callCanaryRelationshipProvider(
    provider: ScraperProvider,
    target: string,
    kind: FlashRelationshipKind,
    cliLimit: number,
    expectedCount: number | undefined,
    context: ProviderCallContext
): Promise<InstagramFollower[]> {
    const method = kind === 'followers' ? provider.getFollowers : provider.getFollowing;
    if (!method) throw new Error('unsupported canary capability');
    return method.call(
        provider,
        target,
        canaryRelationshipCallLimit(cliLimit, expectedCount),
        context
    );
}

export function parseCanaryDeclaredCount(value: string | undefined): number | null | undefined {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function requireCanaryRelationshipRows(
    rows: InstagramFollower[],
    expectedCount?: number
): void {
    if (expectedCount !== undefined) {
        validateRelationshipCompleteness(rows, expectedCount);
        return;
    }
    if (rows.length === 0) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: CANARY_EMPTY_RELATIONSHIP_RESULT selected relationship returned no rows.'
        );
    }
}
