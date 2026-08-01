import { getAnalysisPlan, type PlanId } from '@/lib/domain/analysis/plan-catalog';
import type { BetaProviderOperationBudgetMap } from './authorized-test-provider-policy';
import { ANALYSIS_V2_PROFILE_BATCH_LIMIT } from './v2-dag-planner';
import {
    ANALYSIS_V2_MAX_REVERSE_CANDIDATES,
    ANALYSIS_V2_TARGET_COMMENT_LIMIT,
    ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT,
    ANALYSIS_V2_TARGET_LIKER_LIMIT,
    ANALYSIS_V2_TARGET_LIKER_POST_LIMIT,
    interactionMaximumCharge,
    profileMaximumCharge,
    relationshipMaximumCharge,
    reverseLikeMaximumCharge,
} from './v2-apify-operation-costs';
import { profileRepairMaximumCharge } from './v2-profile-repair';

export const BETA_APIFY_TARGET_PROFILE_BUDGET_USD = 0.0052;
export const BETATEST_APIFY_FROZEN_BUDGET_CATALOG_VERSION = 'betatest-free-pool-v1' as const;

/**
 * Immutable provider-budget contract mirrored byte-for-byte by the 0800 DB helper.
 * General Apify cost env overrides may tighten runtime requirements, but can never
 * rewrite an already-reviewed beta reservation policy.
 */
export const BETATEST_APIFY_FROZEN_OPERATION_BUDGETS = Object.freeze({
    basic: Object.freeze({
        'target-profile': 0.0052,
        'relationship-followers': 0.68,
        'relationship-following': 0.68,
        'profile-fallback': 0.782600000001,
        'profile-repair': 0.81,
        'target-likers': 0.93,
        'target-comments': 0.234,
        'candidate-likers': 1.55,
    }),
    standard: Object.freeze({
        'target-profile': 0.0052,
        'relationship-followers': 1.36,
        'relationship-following': 1.36,
        'profile-fallback': 1.5626,
        'profile-repair': 1.62,
        'target-likers': 0.93,
        'target-comments': 0.234,
        'candidate-likers': 1.55,
    }),
    plus: Object.freeze({
        'target-profile': 0.0052,
        'relationship-followers': 2.04,
        'relationship-following': 2.04,
        'profile-fallback': 2.3426,
        'profile-repair': 2.43,
        'target-likers': 0.93,
        'target-comments': 0.234,
        'candidate-likers': 1.55,
    }),
} satisfies Readonly<Record<PlanId, Readonly<BetaProviderOperationBudgetMap>>>);

function completeFamilyBudget(value: number): number {
    const normalized = Math.ceil(value * 1_000_000_000_000)
        / 1_000_000_000_000;
    if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1_000) {
        throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE');
    }
    return normalized;
}

/**
 * Complete conservative family budgets from the exact starts allowed by the frozen plan:
 * two relationship attempts per side; one fallback and repair per 30-profile candidate batch;
 * one independent target-profile fallback; the bounded target interaction topologies; and one
 * bounded reverse-like run.
 */
export function getRequiredBetaApifyOperationBudgetCatalog(
    selectedPlanId: PlanId,
    env: Record<string, string | undefined> = process.env
): Readonly<BetaProviderOperationBudgetMap> {
    const plan = getAnalysisPlan(selectedPlanId);
    const profileBatchCount = Math.ceil(
        plan.detailedMutualLimit / ANALYSIS_V2_PROFILE_BATCH_LIMIT
    );
    return Object.freeze({
        'target-profile': BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
        'relationship-followers': completeFamilyBudget(
            relationshipMaximumCharge(plan.relationshipCapacity.followers, env) * 2
        ),
        'relationship-following': completeFamilyBudget(
            relationshipMaximumCharge(plan.relationshipCapacity.following, env) * 2
        ),
        'profile-fallback': completeFamilyBudget(
            profileMaximumCharge(ANALYSIS_V2_PROFILE_BATCH_LIMIT, env) * profileBatchCount
                + profileMaximumCharge(1, env)
        ),
        'profile-repair': completeFamilyBudget(
            profileRepairMaximumCharge(ANALYSIS_V2_PROFILE_BATCH_LIMIT) * profileBatchCount
        ),
        'target-likers': completeFamilyBudget(interactionMaximumCharge(
            'likers',
            ANALYSIS_V2_TARGET_LIKER_POST_LIMIT,
            ANALYSIS_V2_TARGET_LIKER_LIMIT,
            env
        )),
        'target-comments': completeFamilyBudget(interactionMaximumCharge(
            'comments',
            ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT,
            ANALYSIS_V2_TARGET_COMMENT_LIMIT,
            env
        )),
        'candidate-likers': completeFamilyBudget(reverseLikeMaximumCharge(
            ANALYSIS_V2_MAX_REVERSE_CANDIDATES,
            env
        )),
    });
}

/** Returns only the reviewed immutable policy map; env is accepted for API compatibility. */
export function getBetaApifyOperationBudgetCatalog(
    selectedPlanId: PlanId,
    _env: Record<string, string | undefined> = process.env
): Readonly<BetaProviderOperationBudgetMap> {
    void _env;
    return BETATEST_APIFY_FROZEN_OPERATION_BUDGETS[selectedPlanId];
}
