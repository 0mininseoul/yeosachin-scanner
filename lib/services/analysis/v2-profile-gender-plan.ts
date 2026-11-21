import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { retryPostgresAbortedRpc } from '@/lib/supabase/rpc-retry';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { planGenderTriageMicrobatches } from '@/lib/services/ai/gender-triage-microbatch-plan';
import {
    plannedGenderTriageOperationKey,
    type GenderTriagePlanAccount,
} from '@/lib/services/ai/v2-staged-analysis';
import { ANALYSIS_V2_PROFILE_BATCH_LIMIT } from './v2-dag-planner';
import { AnalysisV2JobFenceError } from './v2-job-store';

const operationKey = z.string().regex(/^gender-triage:[a-f0-9]{64}$/);
const accountId = z.string().regex(/^account:[a-f0-9]{64}$/);
const group = z.object({
    operationKey,
    accountIds: z.array(accountId).min(1).max(2),
}).strict();
const historicalGroup = group.extend({ accountIds: group.shape.accountIds.nullable() });
const reply = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('pinned'),
        groups: z.array(group).max(ANALYSIS_V2_PROFILE_BATCH_LIMIT),
    }).strict(),
    z.object({
        kind: z.literal('history'),
        groups: z.array(historicalGroup).max(ANALYSIS_V2_PROFILE_BATCH_LIMIT),
    }).strict(),
]);
export type ProfileGenderGroup = z.infer<typeof group>;
export type ProfileGenderPlanReply = z.infer<typeof reply>;
export interface ProfileGenderPlanFence {
    requestId: string;
    jobKey: string;
    claimToken: string;
    inputHash: string;
}
export type PinProfileGenderPlan = (
    fence: ProfileGenderPlanFence, groups: readonly ProfileGenderGroup[],
) => Promise<ProfileGenderPlanReply>;

export const pinProfileGenderPlan: PinProfileGenderPlan = async (fence, groups) => {
    const { data, error } = await retryPostgresAbortedRpc(() => supabaseAdmin.rpc(
        'pin_analysis_v2_profile_gender_plan',
        {
            p_request_id: fence.requestId,
            p_job_key: fence.jobKey,
            p_claim_token: fence.claimToken,
            p_input_hash: fence.inputHash,
            p_groups: groups,
        },
    ));
    if (error) {
        switch (error.message) {
        case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH':
            throw new AnalysisV2JobFenceError();
        case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_POLICY_MISMATCH':
            throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
        case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT':
        case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID':
            return drift();
        default:
            throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_PERSISTENCE_ERROR');
        }
    }
    const parsed = reply.safeParse(data);
    if (!parsed.success) drift();
    return parsed.data;
};

function drift(): never {
    throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
}

export async function planProfileGender(
    accounts: readonly GenderTriagePlanAccount[], fence: ProfileGenderPlanFence,
    pin: PinProfileGenderPlan = pinProfileGenderPlan,
): Promise<readonly ProfileGenderGroup[]> {
    if (accounts.length > ANALYSIS_V2_PROFILE_BATCH_LIMIT) drift();
    const unique = new Map(accounts.map(account => [account.accountId, account]));
    const mark = (members: readonly GenderTriagePlanAccount[]): ProfileGenderGroup => ({
        accountIds: members.map(member => member.accountId),
        operationKey: plannedGenderTriageOperationKey(members, AI_STAGE_POLICY_V211_VERSION),
    });
    const makeGroups = (members: readonly GenderTriagePlanAccount[]) => planGenderTriageMicrobatches(
        members.map(value => ({ accountId: value.accountId, value })),
    ).map(chunk => mark(chunk.map(row => row.value)));
    const proposed = makeGroups([...unique.values()]);
    let stored = await pin(fence, proposed);
    if (stored.kind === 'history') {
        const unmatched = new Set(stored.groups.filter(row => row.accountIds === null).map(row => row.operationKey));
        const adopted: ProfileGenderGroup[] = [];
        const used = new Set<string>();
        const adopt = (item: ProfileGenderGroup) => {
            for (const id of item.accountIds) {
                if (used.has(id) || !unique.has(id)) drift();
                used.add(id);
            }
            adopted.push(item);
            unmatched.delete(item.operationKey);
        };
        for (const row of stored.groups) {
            if (!row.accountIds) continue;
            const verified = mark(row.accountIds.map(id => unique.get(id) ?? drift()));
            if (verified.operationKey !== row.operationKey) drift();
            adopt(verified);
        }
        for (const row of proposed) {
            if (unmatched.has(row.operationKey)) adopt(row);
        }
        // Legacy claims and attempt-only rows contain no member IDs. Hash only compact evidence
        // for the still-unmatched historical keys. No JPEG is re-read or re-hashed in this search.
        const available = [...unique.values()].filter(value => !used.has(value.accountId));
        for (let first = 0; first < available.length && unmatched.size; first++) {
            for (let second = first; second < available.length && unmatched.size; second++) {
                const members = first === second ? [available[first]!] : [available[first]!, available[second]!];
                const item = mark(members);
                if (unmatched.has(item.operationKey)) adopt(item);
            }
        }
        if (unmatched.size) drift();
        const rest = [...unique.values()].filter(account => !used.has(account.accountId));
        stored = await pin(fence, [...adopted, ...makeGroups(rest)]);
        if (stored.kind !== 'pinned') drift();
    }
    const covered = new Set<string>();
    for (const row of stored.groups) {
        const members = row.accountIds.map(id => {
            if (covered.has(id)) drift();
            covered.add(id);
            return unique.get(id) ?? drift();
        });
        if (mark(members).operationKey !== row.operationKey) drift();
    }
    if (covered.size !== unique.size) drift();
    return stored.groups;
}
