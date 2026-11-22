import { supabaseAdmin } from '@/lib/supabase/admin';
import type { CherryRelation } from './detection';
import { assertNoDatabaseError, cherryRpc } from './rpc';

export interface CherrySettings {
    sales_enabled: boolean;
    monitoring_enabled: boolean;
    notifications_enabled: boolean;
    ai_enabled: boolean;
    auto_refund_enabled: boolean;
    payment_provider: 'groble' | 'toss';
    analyzer_reserve_usd: number;
    max_active_runs: number;
    max_relationships: number;
    monthly_item_limit: number;
    check_hour_kst: number;
    notify_hour_kst: number;
    apify_limit_usd: number | null;
    apify_usage_usd: number | null;
    apify_cycle_end_at: string | null;
    apify_observed_at: string | null;
    updated_at: string;
}

export type CherrySubscriptionStatus = 'awaiting_payment' | 'preparing' | 'active' | 'paused' | 'past_due' | 'ended';

export interface CherrySubscription {
    id: string;
    user_id: string;
    status: CherrySubscriptionStatus;
    status_reason: string | null;
    target_instagram_id: string;
    target_username: string;
    target_full_name: string | null;
    target_profile_pic_url: string | null;
    recipient_phone: string | null;
    recipient_email: string | null;
    offer_code: string;
    price_krw: number;
    price_lock_until: string | null;
    payment_provider: 'groble' | 'toss';
    first_paid_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    followers_count: number | null;
    following_count: number | null;
    followers_listed_at: string | null;
    following_listed_at: string | null;
    followers_gap: number;
    following_gap: number;
    baseline_at: string | null;
    last_checked_at: string | null;
    next_check_at: string | null;
    unavailable_code: 'private' | 'not_found' | null;
    items_period_start: string | null;
    items_used: number;
    failure_streak: number;
    ended_at: string | null;
    created_at: string;
}

export interface CherryCheck {
    id: string;
    subscription_id: string;
    kind: 'baseline' | 'daily';
    check_date: string;
    attempts: number;
    lease_token: string;
    created_at: string;
}

export interface CherryReportRow {
    id: string;
    subscription_id: string;
    check_id: string;
    report_date: string;
    status: 'building' | 'ready';
    new_count: number;
    attempts: number;
    lease_token: string | null;
    created_at: string;
    ready_at: string | null;
}

export interface CherryEventRow {
    id: string;
    report_id: string | null;
    certainty: 'confirmed' | 'possible';
    position: number;
    instagram_id: string;
    username: string;
    full_name: string | null;
    is_private: boolean;
    is_verified: boolean;
    detected_at: string;
    detail_status: 'pending' | 'done' | 'failed' | 'skipped';
    profile: CherryEventProfile | null;
    images: CherryEventImage[];
    ai_status: 'pending' | 'done' | 'failed' | 'skipped';
    summary: CherryEventSummary | null;
}

export interface CherryEventProfile {
    biography: string;
    followersCount: number;
    followingCount: number;
    postsCount: number;
}
export interface CherryEventImage { key: string; role: 'profile' | 'post'; shortCode: string | null }
export interface CherryEventSummary {
    headline: string;
    description: string;
    interest: string | null;
    posts: string | null;
    tags: string[];
    gender: 'female' | 'male' | 'unknown';
}

export async function loadCherrySettings(): Promise<CherrySettings> {
    const { data, error } = await supabaseAdmin.from('cherry_settings').select('*').eq('id', true).single();
    assertNoDatabaseError('settings', error);
    const row = data as Record<string, unknown>;
    return {
        ...row,
        analyzer_reserve_usd: Number(row.analyzer_reserve_usd),
        apify_limit_usd: row.apify_limit_usd === null ? null : Number(row.apify_limit_usd),
        apify_usage_usd: row.apify_usage_usd === null ? null : Number(row.apify_usage_usd),
    } as CherrySettings;
}

export async function loadCherrySubscription(id: string): Promise<CherrySubscription | null> {
    const { data, error } = await supabaseAdmin.from('cherry_subscriptions').select('*').eq('id', id).maybeSingle();
    assertNoDatabaseError('subscription', error);
    return data as CherrySubscription | null;
}

/** The newest subscription a member should see. Live ones win over old ones. */
export async function loadMemberSubscription(userId: string): Promise<CherrySubscription | null> {
    const { data, error } = await supabaseAdmin.from('cherry_subscriptions').select('*').eq('user_id', userId)
        .neq('status', 'awaiting_payment').is('purged_at', null)
        .order('created_at', { ascending: false }).limit(5);
    assertNoDatabaseError('member_subscription', error);
    const rows = (data ?? []) as CherrySubscription[];
    return rows.find(row => row.status !== 'ended') ?? rows[0] ?? null;
}

export async function loadCherryRelations(subscriptionId: string): Promise<Map<string, CherryRelation>> {
    const relations = new Map<string, CherryRelation>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabaseAdmin.from('cherry_relations').select('*')
            .eq('subscription_id', subscriptionId).order('instagram_id').range(from, from + pageSize - 1);
        assertNoDatabaseError('relations', error);
        for (const row of data ?? []) {
            relations.set(row.instagram_id, {
                id: row.instagram_id, username: row.username, fullName: row.full_name, isPrivate: row.is_private,
                isVerified: row.is_verified, follower: row.is_follower, following: row.is_following,
                followerNew: row.follower_new_at !== null, followingNew: row.following_new_at !== null,
                followerMisses: row.follower_misses, followingMisses: row.following_misses,
                followerMissingSince: row.follower_missing_since, followingMissingSince: row.following_missing_since,
            });
        }
        if ((data?.length ?? 0) < pageSize) return relations;
    }
}

export async function isCherryTargetBlocked(instagramId: string, username: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin.from('cherry_target_blocks').select('id')
        .or(`instagram_id.eq.${instagramId},username.eq."${username.replace(/["\\]/g, '')}"`).limit(1);
    assertNoDatabaseError('target_blocks', error);
    return (data?.length ?? 0) > 0;
}

export async function recordCherryAudit(
    actorId: string | null, action: string, subject: string | null, detail: Record<string, unknown> = {},
): Promise<void> {
    const { error } = await supabaseAdmin.from('cherry_audit_log').insert({ actor_id: actorId, action, subject, detail });
    assertNoDatabaseError('audit', error);
}

export function claimCherryChecks(limit: number, leaseSeconds: number): Promise<CherryCheck[]> {
    return cherryRpc<CherryCheck[]>('cherry_claim_checks', { p_limit: limit, p_lease_seconds: leaseSeconds });
}
