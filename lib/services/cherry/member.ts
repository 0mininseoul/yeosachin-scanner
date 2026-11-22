import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertNoDatabaseError } from './rpc';
import type { CherryEventRow, CherryReportRow, CherrySubscription } from './store';

export interface MemberReportSummary { id: string; date: string; newCount: number; accounts: string[] }
export interface MemberOverview { mutuals: number; reports: MemberReportSummary[]; supplements: { username: string; detectedAt: string }[]; cardLabel: string | null }

export async function loadMemberOverview(subscription: CherrySubscription): Promise<MemberOverview> {
    const [mutual, reports, supplements, card] = await Promise.all([
        supabaseAdmin.from('cherry_relations').select('instagram_id', { count: 'exact', head: true })
            .eq('subscription_id', subscription.id).eq('is_follower', true).eq('is_following', true),
        supabaseAdmin.from('cherry_reports').select('id, report_date, new_count, cherry_mutual_events(username, position)')
            .eq('subscription_id', subscription.id).eq('status', 'ready').order('report_date', { ascending: false }).limit(30),
        supabaseAdmin.from('cherry_mutual_events').select('username, detected_at').eq('subscription_id', subscription.id)
            .eq('kind', 'supplement').order('detected_at', { ascending: false }).limit(10),
        supabaseAdmin.from('cherry_billing_keys').select('card_label').eq('user_id', subscription.user_id).maybeSingle(),
    ]);
    for (const result of [mutual, reports, supplements, card]) assertNoDatabaseError('member_overview', result.error);
    return {
        mutuals: mutual.count ?? 0,
        reports: (reports.data ?? []).map(row => ({
            id: row.id, date: row.report_date, newCount: row.new_count,
            accounts: [...(row.cherry_mutual_events as { username: string; position: number }[])]
                .sort((a, b) => a.position - b.position).slice(0, 3).map(event => event.username),
        })),
        supplements: (supplements.data ?? []).map(row => ({ username: row.username, detectedAt: row.detected_at })),
        cardLabel: card.data?.card_label ?? null,
    };
}

export interface MemberReport { report: CherryReportRow; targetUsername: string; events: CherryEventRow[] }

/** A report is readable only by the member who owns its subscription. */
export async function loadMemberReport(reportId: string, userId: string): Promise<MemberReport | null> {
    const { data, error } = await supabaseAdmin.from('cherry_reports')
        .select('*, cherry_subscriptions!inner(user_id, target_username, purged_at)').eq('id', reportId)
        .eq('status', 'ready').eq('cherry_subscriptions.user_id', userId).maybeSingle();
    assertNoDatabaseError('member_report', error);
    if (!data || data.cherry_subscriptions.purged_at) return null;
    const { data: events, error: eventError } = await supabaseAdmin.from('cherry_mutual_events').select('*').eq('report_id', reportId).order('position');
    assertNoDatabaseError('member_report_events', eventError);
    return { report: data as CherryReportRow, targetUsername: data.cherry_subscriptions.target_username, events: (events ?? []) as CherryEventRow[] };
}

export async function loadMemberImageKey(eventId: string, index: number, userId: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin.from('cherry_mutual_events')
        .select('images, cherry_subscriptions!inner(user_id)').eq('id', eventId).eq('cherry_subscriptions.user_id', userId).maybeSingle();
    assertNoDatabaseError('member_image', error);
    const images = (data?.images ?? []) as { key?: string }[];
    return images[index]?.key ?? null;
}
