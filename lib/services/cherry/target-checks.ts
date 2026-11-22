import { randomUUID } from 'node:crypto';
import {
    createApifyAccountCreditInventoryStore, type ApifyAccountCreditInventoryClient,
} from '@/lib/services/analysis/apify-account-credit-inventory';
import { selectPreflightApifyCredentialSlot } from '@/lib/services/instagram/providers/apify-relationship';
import { APIFY_CREDENTIAL_TOKEN_ENV, type ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { collectCherryProfiles } from './checks';
import { CherryDeferError } from './errors';
import type { CherryProfile } from './instagram';
import { assertNoDatabaseError } from './rpc';
import { isCherryTargetBlocked, loadCherrySettings } from './store';

const LEASE_SECONDS = 150;
const MAX_ATTEMPTS = 4;
/** A list this short says too little to be useful and is usually a new or empty account. */
const MIN_RELATIONSHIPS = 2;

export type CherryTargetResult = 'ok' | 'private' | 'not_found' | 'too_large' | 'too_small' | 'verified' | 'blocked' | 'unavailable';

export interface CherryTargetCheck {
    id: string;
    username: string;
    status: 'queued' | 'running' | 'done' | 'failed';
    result_code: CherryTargetResult | null;
    instagram_id: string | null;
    full_name: string | null;
    followers_count: number | null;
    following_count: number | null;
    posts_count: number | null;
    profile_pic_url: string | null;
    attempts: number;
    user_id: string | null;
    expires_at: string;
}

export function judgeTarget(profile: CherryProfile, limits: { maxRelationships: number }): CherryTargetResult {
    if (profile.isPrivate) return 'private';
    // Verified accounts often return only the first page of a list.
    if (profile.isVerified) return 'verified';
    const total = profile.followersCount + profile.followingCount;
    if (total > limits.maxRelationships) return 'too_large';
    if (total < MIN_RELATIONSHIPS) return 'too_small';
    return 'ok';
}

/** Uses the free account with the most credit left; the paid account never pays for a lookup. */
async function lookupSlot(checkId: string): Promise<ApifyCredentialSlot> {
    try {
        const inventory = await createApifyAccountCreditInventoryStore(supabaseAdmin as unknown as ApifyAccountCreditInventoryClient).load(900);
        const best = inventory
            .filter(row => row.workloadRole === 'free' && !row.manuallyExcluded && row.healthState === 'healthy'
                && (row.effectiveRemainingUsd ?? 0) > 0.05 && Boolean(process.env[APIFY_CREDENTIAL_TOKEN_ENV[row.credentialSlot]]?.trim()))
            .sort((a, b) => (b.effectiveRemainingUsd ?? 0) - (a.effectiveRemainingUsd ?? 0))[0];
        if (best) return best.credentialSlot;
    } catch {
        // An unreadable balance falls back to the same fixed spread the analyzer uses.
    }
    return selectPreflightApifyCredentialSlot(checkId);
}

async function claim(id: string): Promise<(CherryTargetCheck & { lease_token: string }) | null> {
    const now = new Date();
    const { data: current, error: readError } = await supabaseAdmin.from('cherry_target_checks').select('attempts').eq('id', id).maybeSingle();
    assertNoDatabaseError('target_check_read', readError);
    if (!current) return null;
    const { data, error } = await supabaseAdmin.from('cherry_target_checks').update({
        status: 'running', attempts: current.attempts + 1, lease_token: randomUUID(),
        lease_expires_at: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
    }).eq('id', id).eq('attempts', current.attempts)
        .or(`status.eq.queued,and(status.eq.running,lease_expires_at.lt."${now.toISOString()}")`).select('*');
    assertNoDatabaseError('target_check_claim', error);
    return (data?.[0] as (CherryTargetCheck & { lease_token: string }) | undefined) ?? null;
}

async function finish(check: { id: string; lease_token: string }, patch: Record<string, unknown>): Promise<void> {
    const { error } = await supabaseAdmin.from('cherry_target_checks')
        .update({ ...patch, lease_token: null, lease_expires_at: null }).eq('id', check.id).eq('lease_token', check.lease_token);
    assertNoDatabaseError('target_check_finish', error);
}

export async function processTargetCheck(id: string, deadlineAtMs: number): Promise<'done' | 'deferred' | 'skipped'> {
    const check = await claim(id);
    if (!check) return 'skipped';
    const complete = (result_code: CherryTargetResult, profile?: CherryProfile) => finish(check, {
        status: 'done', result_code, completed_at: new Date().toISOString(),
        ...(profile ? {
            instagram_id: profile.id, full_name: profile.fullName, followers_count: profile.followersCount,
            following_count: profile.followingCount, posts_count: profile.postsCount, profile_pic_url: profile.profilePicUrl,
        } : {}),
    });
    try {
        const profiles = await collectCherryProfiles({
            ownerKey: `target:${check.id}`, operation: 'profile', subscriptionId: null, slot: await lookupSlot(check.id),
            usernames: [check.username], deadlineAtMs, reuseSeconds: 3600,
        });
        const result = profiles.get(check.username);
        if (result?.status === 'not_found') await complete('not_found');
        else if (result?.status === 'found') {
            const settings = await loadCherrySettings();
            const blocked = await isCherryTargetBlocked(result.profile.id, result.profile.username);
            await complete(blocked ? 'blocked' : judgeTarget(result.profile, { maxRelationships: settings.max_relationships }), result.profile);
        } else await complete('unavailable');
        return 'done';
    } catch (error) {
        const stop = check.attempts >= MAX_ATTEMPTS || (error instanceof CherryDeferError && error.options.terminal);
        if (stop) await complete('unavailable');
        else await finish(check, { status: 'queued' });
        return stop ? 'done' : 'deferred';
    }
}

export async function pendingTargetChecks(limit: number): Promise<string[]> {
    const { data, error } = await supabaseAdmin.from('cherry_target_checks').select('id').in('status', ['queued', 'running'])
        .gt('created_at', new Date(Date.now() - 30 * 60_000).toISOString()).order('created_at').limit(limit);
    assertNoDatabaseError('target_check_pending', error);
    return (data ?? []).map(row => row.id as string);
}
