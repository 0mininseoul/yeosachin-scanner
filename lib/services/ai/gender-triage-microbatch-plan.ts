import { GENDER_TRIAGE_V29_MAX_ACCOUNTS_PER_BATCH } from './v2-staged-analysis';

export interface GenderTriageMicrobatchPlanMember<T> {
    readonly accountId: string;
    readonly value: T;
}

/**
 * Mirrors the production v2.9 topology: coalesce identical opaque accounts,
 * sort by opaque ID, then form stable batches of at most two accounts.
 */
export function planGenderTriageMicrobatches<T>(
    members: readonly GenderTriageMicrobatchPlanMember<T>[],
): readonly (readonly GenderTriageMicrobatchPlanMember<T>[])[] {
    const unique = new Map<string, GenderTriageMicrobatchPlanMember<T>>();
    for (const member of members) {
        if (!unique.has(member.accountId)) unique.set(member.accountId, member);
    }
    const ordered = [...unique.values()].sort((left, right) => (
        left.accountId.localeCompare(right.accountId)
    ));
    const batches: GenderTriageMicrobatchPlanMember<T>[][] = [];
    for (
        let index = 0;
        index < ordered.length;
        index += GENDER_TRIAGE_V29_MAX_ACCOUNTS_PER_BATCH
    ) {
        batches.push(ordered.slice(
            index,
            index + GENDER_TRIAGE_V29_MAX_ACCOUNTS_PER_BATCH,
        ));
    }
    return batches;
}
