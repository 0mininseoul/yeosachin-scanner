import { numberSetting } from '@/lib/services/instagram/providers/apify-relationship';
import { checkedMaximumCharge } from './v2-provider-identity';

export const ANALYSIS_V2_TARGET_LIKER_LIMIT = 150;
export const ANALYSIS_V2_TARGET_COMMENT_LIMIT = 15;
export const ANALYSIS_V2_TARGET_LIKER_POST_LIMIT = 4;
export const ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT = 6;
export const ANALYSIS_V2_MAX_REVERSE_CANDIDATES = 10;
export const ANALYSIS_V2_REVERSE_LIKE_LIMIT = 100;

export function relationshipMaximumCharge(
    declaredCount: number,
    env: Record<string, string | undefined>
): number {
    const costPerResult = numberSetting(
        env,
        'APIFY_RELATIONSHIP_ESTIMATED_COST_PER_RESULT_USD',
        0.00085,
        0,
        100
    );
    const maximum = numberSetting(
        env,
        'APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION',
        1.1,
        0.00000001,
        100_000
    );
    return checkedMaximumCharge(
        Math.max(25, declaredCount) * costPerResult,
        maximum,
        'relationship'
    );
}

export function profileMaximumCharge(
    count: number,
    env: Record<string, string | undefined>
): number {
    const costPerResult = numberSetting(
        env,
        'APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD',
        0.0026,
        0,
        100
    );
    const maximum = numberSetting(
        env,
        'APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION',
        1,
        0.00000001,
        100_000
    );
    return checkedMaximumCharge(
        count * costPerResult,
        maximum,
        'profile fallback'
    );
}

export function interactionMaximumCharge(
    kind: 'likers' | 'comments',
    postCount: number,
    limitPerPost: number,
    env: Record<string, string | undefined>
): number {
    const prefix = kind === 'likers' ? 'APIFY_LIKERS' : 'APIFY_COMMENTS';
    const defaultCost = kind === 'likers' ? 0.00155 : 0.0026;
    const costPerResult = numberSetting(
        env,
        `${prefix}_ESTIMATED_COST_PER_RESULT_USD`,
        defaultCost,
        0.00000001,
        100
    );
    const maximum = numberSetting(
        env,
        `${prefix}_MAX_ESTIMATED_COST_USD_PER_OPERATION`,
        (kind === 'likers' ? 1_500 : 90) * defaultCost,
        0.00000001,
        100_000
    );
    return checkedMaximumCharge(
        postCount * limitPerPost * costPerResult,
        maximum,
        `target ${kind}`
    );
}

export function reverseLikeMaximumCharge(
    candidateCount: number,
    env: Record<string, string | undefined>
): number {
    const costPerResult = numberSetting(
        env,
        'APIFY_LIKERS_ESTIMATED_COST_PER_RESULT_USD',
        0.00155,
        0.00000001,
        100
    );
    const maximum = numberSetting(
        env,
        'APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION',
        1_500 * 0.00155,
        0.00000001,
        100_000
    );
    const estimated = Number((
        candidateCount * ANALYSIS_V2_REVERSE_LIKE_LIMIT * costPerResult
    ).toFixed(12));
    if (estimated > maximum + Number.EPSILON) {
        throw new Error('ANALYSIS_V2_REVERSE_LIKE_BUDGET_EXCEEDED');
    }
    return estimated;
}
