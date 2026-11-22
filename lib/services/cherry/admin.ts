import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { refundWithToss } from './billing';
import { CHERRY_TERMS_VERSION } from './contracts';
import { normalizeTargetUsername } from './instagram';
import { assertNoDatabaseError, cherryRpc } from './rpc';
import { loadCherrySettings, recordCherryAudit, type CherrySettings } from './store';
import { readCherryEmailConfig } from './notifications';
import { readSolapiConfig } from './solapi';
import { readTossConfig } from './toss';
import { kickCherryWorker } from './worker-kick';

const uuid = z.string().uuid();

export const cherryAdminActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('settings'), patch: z.object({
        sales_enabled: z.boolean(), monitoring_enabled: z.boolean(), notifications_enabled: z.boolean(), ai_enabled: z.boolean(),
        auto_refund_enabled: z.boolean(), payment_provider: z.enum(['groble', 'toss']),
        analyzer_reserve_usd: z.number().min(0).max(1000), max_active_runs: z.number().int().min(1).max(8),
        monthly_item_limit: z.number().int().min(1000).max(100_000),
    }).partial().strict().refine(value => Object.keys(value).length > 0) }).strict(),
    z.object({ action: z.literal('offer'), code: z.string().regex(/^[a-z0-9_]{2,40}$/), patch: z.object({
        name: z.string().trim().min(1).max(60), price_krw: z.number().int().min(100).max(1_000_000),
        audience: z.enum(['everyone', 'reservation']), lock_months: z.number().int().min(1).max(24).nullable(), active: z.boolean(),
        starts_at: z.string().datetime({ offset: true }).nullable(), ends_at: z.string().datetime({ offset: true }).nullable(),
        groble_product_id: z.string().trim().min(1).max(128).nullable(), groble_payment_address: z.string().trim().min(1).max(128).nullable(),
    }).partial().strict() }).strict(),
    z.object({ action: z.literal('tester'), email: z.string().trim().email(), enabled: z.boolean() }).strict(),
    z.object({ action: z.literal('grant'), email: z.string().trim().email(), username: z.string().min(1).max(120) }).strict(),
    z.object({ action: z.literal('recheck'), subscriptionId: uuid }).strict(),
    z.object({ action: z.literal('end'), subscriptionId: uuid }).strict(),
    z.object({ action: z.literal('refund_approve'), refundId: uuid }).strict(),
    z.object({ action: z.literal('refund_done'), refundId: uuid }).strict(),
    z.object({ action: z.literal('resend'), notificationId: uuid }).strict(),
    z.object({ action: z.literal('block'), username: z.string().min(1).max(120), note: z.string().max(500).default('') }).strict(),
    z.object({ action: z.literal('unblock'), blockId: uuid }).strict(),
]);
export type CherryAdminAction = z.infer<typeof cherryAdminActionSchema>;

async function rows(table: string, query: (builder: ReturnType<typeof supabaseAdmin.from>) => unknown): Promise<Record<string, unknown>[]> {
    const { data, error } = await (query(supabaseAdmin.from(table)) as PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>);
    assertNoDatabaseError(`admin_${table}`, error);
    return (data ?? []) as Record<string, unknown>[];
}

function tally(list: Record<string, unknown>[], key: string): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const row of list) totals[String(row[key])] = (totals[String(row[key])] ?? 0) + 1;
    return totals;
}

export async function loadCherryAdminOverview() {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [settings, offers, subscriptions, checks, runs, notifications, refunds, reviews, events, blocks, waitlist] = await Promise.all([
        loadCherrySettings(),
        rows('cherry_offers', table => table.select('*').order('price_krw')),
        rows('cherry_subscriptions', table => table.select('id, status, status_reason, target_username, recipient_email, price_krw, payment_provider, current_period_end, cancel_at_period_end, baseline_at, last_checked_at, next_check_at, items_used, failure_streak, followers_count, following_count, created_at')
            .neq('status', 'awaiting_payment').is('purged_at', null).order('created_at', { ascending: false }).limit(200)),
        rows('cherry_checks', table => table.select('id, subscription_id, kind, status, error_code, attempts, created_at, result').gte('created_at', dayAgo).order('created_at', { ascending: false }).limit(500)),
        rows('cherry_provider_runs', table => table.select('status, credential_slot, estimated_cost_usd, created_at').gte('created_at', monthAgo).limit(1000)),
        rows('cherry_notifications', table => table.select('id, subscription_id, kind, status, channel, error_code, created_at').gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString()).order('created_at', { ascending: false }).limit(300)),
        rows('cherry_refunds', table => table.select('id, subscription_id, amount_krw, reason, status, failure_code, requested_at, cherry_payments(provider, provider_payment_id)').order('requested_at', { ascending: false }).limit(50)),
        rows('cherry_payments', table => table.select('id, subscription_id, provider, status, review_reason, amount_krw, provider_payment_id, paid_at, updated_at').in('status', ['review', 'processing']).order('updated_at', { ascending: false }).limit(50)),
        rows('cherry_payment_events', table => table.select('event_id, provider, event_type, disposition, amount_krw, provider_payment_id, received_at').in('disposition', ['unmatched', 'review', 'cancel_requested']).order('received_at', { ascending: false }).limit(30)),
        rows('cherry_target_blocks', table => table.select('id, username, note, created_at').order('created_at', { ascending: false }).limit(100)),
        rows('cherry_capacity_waitlist', table => table.select('user_id').is('notified_at', null).limit(1000)),
    ]);
    return {
        settings: { ...settings, tester_count: settings.tester_user_ids.length, tester_user_ids: undefined } as Omit<CherrySettings, 'tester_user_ids'> & { tester_count: number },
        channels: { alimtalk: Boolean(readSolapiConfig()?.channelId), sms: Boolean(readSolapiConfig()), email: Boolean(readCherryEmailConfig()), toss: Boolean(readTossConfig()) },
        availableUsd: await cherryRpc<number | string>('cherry_available_budget_usd').then(Number),
        offers, subscriptions, refunds, reviews, events, blocks, capacityWaiting: waitlist.length,
        subscriptionTotals: tally(subscriptions, 'status'),
        checkTotals: tally(checks, 'status'),
        failedChecks: checks.filter(check => check.status === 'failed' || (check.status === 'queued' && Number(check.attempts) >= 3)).slice(0, 50),
        runTotals: { ...tally(runs, 'status') },
        estimatedCostUsd: runs.reduce((sum, run) => sum + Number(run.estimated_cost_usd ?? 0), 0),
        notificationTotals: tally(notifications, 'status'),
        notificationProblems: notifications.filter(item => item.status === 'failed' || item.status === 'unconfirmed').slice(0, 50),
    };
}

async function findUserId(email: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
    assertNoDatabaseError('admin_user', error);
    return (data as { id: string } | null)?.id ?? null;
}

async function updateOne(table: string, id: string, statuses: string[], patch: Record<string, unknown>): Promise<string> {
    const { data, error } = await supabaseAdmin.from(table).update(patch).eq('id', id).in('status', statuses).select('id');
    assertNoDatabaseError(`admin_${table}`, error);
    return (data?.length ?? 0) > 0 ? 'done' : 'not_allowed';
}

async function apply(action: CherryAdminAction, operatorId: string): Promise<string> {
    const now = new Date().toISOString();
    switch (action.action) {
        case 'settings': {
            const { error } = await supabaseAdmin.from('cherry_settings').update({ ...action.patch, updated_at: now, updated_by: operatorId }).eq('id', true);
            assertNoDatabaseError('admin_settings', error);
            return 'done';
        }
        case 'offer': {
            // A locked price is a promise to the members who have it; a different price is a new offer.
            if (action.patch.price_krw !== undefined) {
                const { data: locked, error: lockError } = await supabaseAdmin.from('cherry_subscriptions').select('id')
                    .eq('offer_code', action.code).neq('status', 'ended').not('price_lock_until', 'is', null).limit(1);
                assertNoDatabaseError('admin_offer', lockError);
                if ((locked?.length ?? 0) > 0) return 'offer_in_use';
            }
            const { data, error } = await supabaseAdmin.from('cherry_offers').update({ ...action.patch, updated_at: now }).eq('code', action.code).select('code');
            assertNoDatabaseError('admin_offer', error);
            if ((data?.length ?? 0) > 0) return 'done';
            if (!action.patch.name || !action.patch.price_krw || !action.patch.audience) return 'not_allowed';
            const { error: insertError } = await supabaseAdmin.from('cherry_offers').insert({ active: false, ...action.patch, code: action.code });
            assertNoDatabaseError('admin_offer', insertError);
            return 'done';
        }
        case 'tester': {
            const userId = await findUserId(action.email);
            if (!userId) return 'user_not_found';
            const settings = await loadCherrySettings();
            const testers = new Set(settings.tester_user_ids);
            if (action.enabled) testers.add(userId); else testers.delete(userId);
            const { error } = await supabaseAdmin.from('cherry_settings').update({ tester_user_ids: [...testers], updated_at: now, updated_by: operatorId }).eq('id', true);
            assertNoDatabaseError('admin_tester', error);
            return 'done';
        }
        case 'grant': {
            const userId = await findUserId(action.email);
            const username = normalizeTargetUsername(action.username);
            if (!userId || !username) return userId ? 'username_invalid' : 'user_not_found';
            const request = await cherryRpc<{ outcome: string; id?: string; created?: boolean }>('cherry_request_target_check', {
                p_username: username, p_user: userId, p_ip_hash: `operator:${operatorId}`, p_ip_daily_limit: 100, p_total_daily_limit: 5000,
            });
            if (!request.id) return 'limited';
            if (request.created) await kickCherryWorker({ kind: 'target_check', id: request.id });
            const { data, error } = await supabaseAdmin.from('cherry_target_checks').select('status, result_code').eq('id', request.id).single();
            assertNoDatabaseError('admin_grant_check', error);
            if (data?.status !== 'done') return 'checking';
            if (data.result_code !== 'ok') return `target_${data.result_code}`;
            return (await cherryRpc<{ outcome: string }>('cherry_grant', {
                p_user: userId, p_target_check: request.id, p_terms_version: `${CHERRY_TERMS_VERSION}-operator`,
            })).outcome;
        }
        case 'recheck':
            return (await cherryRpc<{ outcome: string }>('cherry_operator_requeue', { p_subscription: action.subscriptionId })).outcome;
        case 'end': {
            const result = await cherryRpc<{ ended: boolean; refundKrw?: number }>('cherry_end_with_refund', { p_subscription: action.subscriptionId, p_reason: 'operator' });
            if (!result.ended) return 'not_allowed';
            await cherryRpc('cherry_queue_notification', {
                p_subscription: action.subscriptionId, p_kind: 'target_unavailable', p_dedupe: `unavailable:${action.subscriptionId}`,
                p_payload: { code: 'operator', refundKrw: result.refundKrw ?? 0 }, p_report: null,
            });
            return 'done';
        }
        case 'refund_approve': {
            const toss = readTossConfig();
            if (!toss) return 'payment_unavailable';
            // A request whose answer was lost is repeated with the same idempotency key.
            const stale = new Date(Date.now() - 15 * 60_000).toISOString();
            const { data, error } = await supabaseAdmin.from('cherry_refunds').update({ status: 'processing', updated_at: now })
                .eq('id', action.refundId).or(`status.eq.pending,and(status.eq.processing,updated_at.lt."${stale}")`).select('*');
            assertNoDatabaseError('admin_refund', error);
            if (!data?.[0]) return 'not_allowed';
            await refundWithToss(data[0], toss);
            return 'done';
        }
        case 'refund_done': {
            const outcome = await updateOne('cherry_refunds', action.refundId, ['manual_required'], { status: 'done', done_at: now, updated_at: now });
            if (outcome === 'done') {
                const { data, error } = await supabaseAdmin.from('cherry_refunds').select('subscription_id, amount_krw').eq('id', action.refundId).single();
                assertNoDatabaseError('admin_refund', error);
                await cherryRpc('cherry_queue_notification', {
                    p_subscription: data!.subscription_id, p_kind: 'refund_done', p_dedupe: `refund:${action.refundId}`,
                    p_payload: { refundKrw: data!.amount_krw }, p_report: null,
                });
            }
            return outcome;
        }
        case 'resend':
            return updateOne('cherry_notifications', action.notificationId, ['failed', 'unconfirmed', 'canceled'], { status: 'queued', send_after: now, error_code: null });
        case 'block': {
            const username = normalizeTargetUsername(action.username);
            if (!username) return 'username_invalid';
            const { data: known } = await supabaseAdmin.from('cherry_subscriptions').select('target_instagram_id').eq('target_username', username).limit(1);
            const { error } = await supabaseAdmin.from('cherry_target_blocks').upsert({
                username, note: action.note || null, created_by: operatorId,
                ...(known?.[0] ? { instagram_id: known[0].target_instagram_id } : {}),
            }, { onConflict: 'username' });
            assertNoDatabaseError('admin_block', error);
            return 'done';
        }
        case 'unblock': {
            const { error } = await supabaseAdmin.from('cherry_target_blocks').delete().eq('id', action.blockId);
            assertNoDatabaseError('admin_unblock', error);
            return 'done';
        }
    }
}

/** Every change is written to the audit log with its result; contact details are not. */
export async function runCherryAdminAction(action: CherryAdminAction, operatorId: string): Promise<string> {
    const outcome = await apply(action, operatorId);
    const subject = 'subscriptionId' in action ? action.subscriptionId : 'refundId' in action ? action.refundId
        : 'notificationId' in action ? action.notificationId : 'code' in action ? action.code : 'blockId' in action ? action.blockId : null;
    await recordCherryAudit(operatorId, action.action, subject, {
        outcome, ...(action.action === 'settings' || action.action === 'offer' ? { patch: action.patch } : {}),
    });
    return outcome;
}
