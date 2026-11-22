import { Resend } from 'resend';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertNoDatabaseError, cherryRpc } from './rpc';
import { readSolapiConfig, sendSolapi, SolapiRejectedError, SolapiUnknownError, type SolapiConfig } from './solapi';
import { loadCherrySubscription, type CherrySubscription } from './store';

export type CherryNotificationKind = 'new_mutual' | 'baseline_ready' | 'baseline_delayed' | 'target_unavailable'
    | 'renewal_due' | 'subscription_lapsed' | 'payment_failed' | 'price_change' | 'refund_done';

export interface CherryNotificationRow {
    id: string;
    subscription_id: string;
    kind: CherryNotificationKind;
    report_id: string | null;
    payload: Record<string, unknown>;
    lease_token: string;
    attempts: number;
}

export interface CherryMessage { subject: string; text: string; variables: Record<string, string> }
export interface CherryEmailConfig { apiKey: string; from: string }

const won = new Intl.NumberFormat('ko-KR');
const koreanDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

export function readCherryEmailConfig(env: Record<string, string | undefined> = process.env): CherryEmailConfig | null {
    const apiKey = env.RESEND_API_KEY?.trim();
    const from = env.CHERRY_EMAIL_FROM?.trim();
    return apiKey && apiKey !== 'xxx' && from ? { apiKey, from } : null;
}

function date(value: unknown): string {
    return typeof value === 'string' ? koreanDate.format(new Date(value)) : '';
}

/** Variable names are what the Alimtalk templates must use. */
export function buildCherryMessage(
    kind: CherryNotificationKind, target: string, payload: Record<string, unknown>,
    context: { reportId: string | null; accounts: string[] },
): CherryMessage {
    const home = `${CANONICAL_APP_ORIGIN}/cherry/home`;
    const id = `@${target}`;
    switch (kind) {
        case 'new_mutual': {
            const count = Number(payload.count ?? context.accounts.length);
            const listed = context.accounts.slice(0, 3).map(account => `@${account}`);
            const rest = Math.max(0, count - listed.length);
            const list = rest > 0 ? [...listed, `외 ${rest}명`].join('\n') : listed.join('\n');
            const link = `${CANONICAL_APP_ORIGIN}/cherry/reports/${context.reportId}`;
            return {
                subject: '체리 새 맞팔 알림',
                text: `[체리] 등록하신 ${id} 계정에서 새 맞팔 ${count}명을 확인했어요.\n\n${list}\n\n리포트 보기\n${link}`,
                variables: { target: id, count: String(count), accounts: list, link },
            };
        }
        case 'baseline_ready':
            return { subject: '체리 확인 시작',
                text: `[체리] ${id} 계정의 현재 맞팔 ${Number(payload.mutuals ?? 0)}명을 저장했어요.\n이제부터 새로 확인한 맞팔을 알려드릴게요.\n\n내 서비스\n${home}`,
                variables: { target: id, count: String(payload.mutuals ?? 0), link: home } };
        case 'baseline_delayed':
            return { subject: '체리 준비 지연 안내',
                text: `[체리] ${id} 계정의 첫 목록을 아직 저장하지 못했어요. 계속 준비하거나 전액 취소를 선택할 수 있어요.\n\n선택하기\n${home}`,
                variables: { target: id, link: home } };
        case 'target_unavailable': {
            const refund = Number(payload.refundKrw ?? 0);
            const reason = payload.code === 'private' ? '비공개로 전환되어' : '확인되지 않아';
            return { subject: '체리 이용 중지 안내',
                text: `[체리] ${id} 계정이 ${reason} 이용을 중지했어요. 다음 결제는 청구되지 않아요.${refund > 0 ? `\n남은 기간 요금 ${won.format(refund)}원을 환불해 드려요.` : ''}\n\n내 서비스\n${home}`,
                variables: { target: id, reason, refund: won.format(refund), link: home } };
        }
        case 'renewal_due':
            return { subject: '체리 이용권 만료 예정',
                text: `[체리] 이용권이 ${date(payload.periodEnd)}에 끝나요. 이어서 이용하려면 연장해 주세요.\n\n연장하기\n${home}`,
                variables: { date: date(payload.periodEnd), link: home } };
        case 'subscription_lapsed':
            return { subject: '체리 이용권 만료',
                text: `[체리] 이용권이 끝나 ${id} 계정 확인을 멈췄어요. 4일 안에 연장하면 기존 목록에서 이어서 확인해요.\n\n연장하기\n${home}`,
                variables: { target: id, link: home } };
        case 'payment_failed':
            return { subject: '체리 결제 실패',
                text: `[체리] 정기 결제가 승인되지 않았어요. 결제 수단을 확인해 주세요.\n\n확인하기\n${home}`, variables: { link: home } };
        case 'price_change':
            return { subject: '체리 요금 안내',
                text: `[체리] 혜택 기간이 끝나 ${date(payload.periodEnd)} 이후 결제부터 월 ${won.format(Number(payload.priceKrw ?? 0))}원이 적용돼요. 원하지 않으면 그 전에 해지할 수 있어요.\n\n내 서비스\n${home}`,
                variables: { date: date(payload.periodEnd), price: won.format(Number(payload.priceKrw ?? 0)), link: home } };
        case 'refund_done':
            return { subject: '체리 환불 완료',
                text: `[체리] ${won.format(Number(payload.refundKrw ?? 0))}원 환불을 마쳤어요. 카드사에 따라 3~4영업일이 걸릴 수 있어요.\n\n내 서비스\n${home}`,
                variables: { refund: won.format(Number(payload.refundKrw ?? 0)), link: home } };
    }
}

export interface CherryDeliveryDeps {
    solapi: SolapiConfig | null;
    email: CherryEmailConfig | null;
    sendSolapi: typeof sendSolapi;
    sendEmail(config: CherryEmailConfig, input: { to: string; subject: string; text: string; key: string }): Promise<string>;
}

export type CherryDelivery =
    | { status: 'sent'; channel: 'alimtalk' | 'sms' | 'email'; messageId: string }
    | { status: 'failed'; code: string }
    | { status: 'unconfirmed'; channel: 'alimtalk' | 'sms'; code: string };

/** Moves to the next channel only after a clear refusal; an unknown outcome stops for an operator. */
export async function deliverCherryMessage(
    input: { id: string; kind: CherryNotificationKind; phone: string | null; email: string | null; message: CherryMessage },
    deps: CherryDeliveryDeps,
): Promise<CherryDelivery> {
    let code = 'no_channel';
    if (deps.solapi && input.phone) {
        const templateId = deps.solapi.channelId ? deps.solapi.templates[input.kind] : undefined;
        for (const channel of templateId ? ['alimtalk', 'sms'] as const : ['sms'] as const) {
            try {
                const result = await deps.sendSolapi(deps.solapi, {
                    to: input.phone, subject: input.message.subject, text: input.message.text,
                    ...(channel === 'alimtalk' && templateId ? { kakao: { templateId, variables: input.message.variables } } : {}),
                });
                return { status: 'sent', channel, messageId: result.groupId };
            } catch (error) {
                if (error instanceof SolapiUnknownError) return { status: 'unconfirmed', channel, code: 'provider_unknown' };
                code = error instanceof SolapiRejectedError ? error.code : 'provider_error';
            }
        }
    }
    if (deps.email && input.email) {
        try {
            const messageId = await deps.sendEmail(deps.email, {
                to: input.email, subject: input.message.subject, text: input.message.text, key: `cherry-${input.id}`,
            });
            return { status: 'sent', channel: 'email', messageId };
        } catch {
            code = 'email_failed';
        }
    }
    return { status: 'failed', code };
}

async function sendEmailWithResend(
    config: CherryEmailConfig, input: { to: string; subject: string; text: string; key: string },
): Promise<string> {
    // The key makes a retried request return the first message instead of sending another.
    const { data, error } = await new Resend(config.apiKey).emails.send(
        { from: config.from, to: input.to, subject: `[체리] ${input.subject.replace(/^체리 /, '')}`, text: input.text },
        { idempotencyKey: input.key },
    );
    if (error || !data) throw new Error('CHERRY_EMAIL_FAILED');
    return data.id;
}

export function cherryDeliveryDeps(env: Record<string, string | undefined> = process.env): CherryDeliveryDeps {
    return { solapi: readSolapiConfig(env), email: readCherryEmailConfig(env), sendSolapi, sendEmail: sendEmailWithResend };
}

async function accountsForReport(reportId: string | null): Promise<string[]> {
    if (!reportId) return [];
    const { data, error } = await supabaseAdmin.from('cherry_mutual_events').select('username').eq('report_id', reportId)
        .order('position').limit(3);
    assertNoDatabaseError('notification_accounts', error);
    return (data ?? []).map(row => row.username as string);
}

async function settle(row: CherryNotificationRow, patch: Record<string, unknown>): Promise<void> {
    const { error } = await supabaseAdmin.from('cherry_notifications')
        .update({ ...patch, lease_token: null, lease_expires_at: null })
        .eq('id', row.id).eq('status', 'sending').eq('lease_token', row.lease_token);
    assertNoDatabaseError('notification_settle', error);
}

export async function processCherryNotifications(limit: number, deps = cherryDeliveryDeps()): Promise<number> {
    if (!deps.solapi && !deps.email) return 0;
    const rows = await cherryRpc<CherryNotificationRow[]>('cherry_claim_notifications', { p_limit: limit, p_lease_seconds: 120 });
    for (const row of rows) {
        const subscription: CherrySubscription | null = await loadCherrySubscription(row.subscription_id);
        if (!subscription || (!subscription.recipient_phone && !subscription.recipient_email)) {
            await settle(row, { status: 'canceled', error_code: 'recipient_removed' });
            continue;
        }
        const message = buildCherryMessage(row.kind, subscription.target_username, row.payload, {
            reportId: row.report_id, accounts: await accountsForReport(row.report_id),
        });
        const result = await deliverCherryMessage({
            id: row.id, kind: row.kind, phone: subscription.recipient_phone, email: subscription.recipient_email, message,
        }, deps);
        await settle(row, result.status === 'sent'
            ? { status: 'sent', channel: result.channel, provider_message_id: result.messageId, sent_at: new Date().toISOString(), error_code: null }
            : result.status === 'unconfirmed'
                ? { status: 'unconfirmed', channel: result.channel, error_code: result.code }
                : { status: 'failed', error_code: result.code });
    }
    return rows.length;
}
