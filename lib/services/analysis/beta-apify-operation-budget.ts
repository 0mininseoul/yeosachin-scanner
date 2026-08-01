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
export function getBetaApifyOperationBudgetCatalog(
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
