import { createHmac } from 'node:crypto';
import { requestClientIp } from '@/lib/services/analysis/anonymous-preflight-claim';
import { createImageProxyPath } from '@/lib/services/media/image-proxy-token';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ensureCustomerKey } from './billing';
import { CHERRY_TERMS_VERSION, type CherryCheckoutOutcome, type CherryTargetView } from './contracts';
import { assertNoDatabaseError, cherryRpc } from './rpc';
import { loadCherrySettings } from './store';
import type { CherryTargetCheck } from './target-checks';
import { readTossConfig } from './toss';

const IP_DAILY_LIMIT = 15;
const TOTAL_DAILY_LIMIT = 1000;

export function cherryIpHash(request: Request, env: Record<string, string | undefined> = process.env): string {
    const secret = env.ANONYMOUS_PREFLIGHT_CLAIM_SECRET?.trim() || env.IMAGE_PROXY_SIGNING_SECRET?.trim();
    if (!secret) throw new Error('CHERRY_RATE_LIMIT_SECRET_MISSING');
    return createHmac('sha256', secret).update(`cherry-ip:v1:${requestClientIp(request)}`).digest('hex');
}

export async function requestTargetCheck(username: string, userId: string | null, ipHash: string): Promise<{ id: string; created: boolean } | 'limited'> {
    const result = await cherryRpc<{ outcome: string; id?: string; created?: boolean }>('cherry_request_target_check', {
        p_username: username, p_user: userId, p_ip_hash: ipHash, p_ip_daily_limit: IP_DAILY_LIMIT, p_total_daily_limit: TOTAL_DAILY_LIMIT,
    });
    return result.outcome === 'accepted' && result.id ? { id: result.id, created: result.created === true } : 'limited';
}

/** The row ID is an unguessable capability; a row already tied to a member is shown only to that member. */
export async function loadTargetCheck(id: string, userId: string | null): Promise<CherryTargetCheck | null> {
    const { data, error } = await supabaseAdmin.from('cherry_target_checks').select('*').eq('id', id).maybeSingle();
    assertNoDatabaseError('target_check', error);
    const row = data as CherryTargetCheck | null;
    if (!row || Date.parse(row.expires_at) <= Date.now() || (row.user_id && row.user_id !== userId)) return null;
    return row;
}

function proxiedImage(url: string | null): string | null {
    if (!url) return null;
    try {
        return createImageProxyPath(url) ?? null;
    } catch {
        return null;
    }
}

export function targetView(row: CherryTargetCheck): CherryTargetView {
    const done = row.status === 'done' || row.status === 'failed';
    const visible = row.result_code === 'ok' || row.result_code === 'too_large';
    return {
        id: row.id, status: done ? 'done' : 'pending', result: row.status === 'failed' ? 'unavailable' : row.result_code, username: row.username,
        fullName: visible ? row.full_name : null, followersCount: visible ? row.followers_count : null,
        followingCount: visible ? row.following_count : null, postsCount: visible ? row.posts_count : null,
        imagePath: visible ? proxiedImage(row.profile_pic_url) : null,
    };
}

export interface CherryOffer { code: string; name: string; priceKrw: number; lockMonths: number | null }

export async function resolveCherryOffer(userId: string): Promise<CherryOffer | null> {
    const rows = await cherryRpc<{ code: string; name: string; price_krw: number; lock_months: number | null }[]>('cherry_resolve_offer', { p_user: userId });
    const row = rows[0];
    return row ? { code: row.code, name: row.name, priceKrw: row.price_krw, lockMonths: row.lock_months } : null;
}

export async function cherrySalesOpenFor(userId: string | null): Promise<boolean> {
    const settings = await loadCherrySettings();
    return settings.sales_enabled || (userId !== null && settings.tester_user_ids.includes(userId));
}

interface CheckoutRow {
    outcome: CherryCheckoutOutcome; orderRef?: string; amountKrw?: number; provider?: 'groble' | 'toss'; grobleAddress?: string | null;
}
export type CherryCheckout =
    | { outcome: 'ready'; provider: 'groble'; amountKrw: number; redirectUrl: string }
    | { outcome: 'ready'; provider: 'toss'; amountKrw: number; clientKey: string; customerKey: string }
    | { outcome: Exclude<CherryCheckoutOutcome, 'ready'> };

export function cherryGrobleUrl(address: string, orderRef: string): string {
    const url = new URL(`https://groble.im/payment/${encodeURIComponent(address)}`);
    url.searchParams.set('ref', orderRef);
    return url.toString();
}

async function toCheckout(row: CheckoutRow, userId: string): Promise<CherryCheckout> {
    if (row.outcome !== 'ready') return { outcome: row.outcome };
    if (row.provider === 'groble' && row.grobleAddress && row.orderRef) {
        return { outcome: 'ready', provider: 'groble', amountKrw: row.amountKrw ?? 0, redirectUrl: cherryGrobleUrl(row.grobleAddress, row.orderRef) };
    }
    const toss = readTossConfig();
    if (row.provider !== 'toss' || !toss) return { outcome: 'payment_unavailable' };
    return { outcome: 'ready', provider: 'toss', amountKrw: row.amountKrw ?? 0, clientKey: toss.clientKey, customerKey: await ensureCustomerKey(userId) };
}

export async function beginCherryCheckout(userId: string, targetCheckId: string): Promise<CherryCheckout> {
    return toCheckout(await cherryRpc<CheckoutRow>('cherry_begin_checkout', {
        p_user: userId, p_target_check: targetCheckId, p_terms_version: CHERRY_TERMS_VERSION,
    }), userId);
}

export async function beginCherryRenewal(userId: string): Promise<CherryCheckout> {
    return toCheckout(await cherryRpc<CheckoutRow>('cherry_begin_renewal', { p_user: userId }), userId);
}
