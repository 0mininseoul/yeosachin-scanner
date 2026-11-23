'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NAMCHIN_ADMIN_CONSOLE_PATH } from '@/lib/contracts/admin-console';
import type { loadCherryAdminOverview, CherryAdminAction } from '@/lib/services/cherry/admin';
import { ConsoleWorkspaceSwitch } from './console-workspace-switch';
import { Card, Chip, EmptyRow, ErrorNotice, Loading } from './console-ui';

type Overview = Awaited<ReturnType<typeof loadCherryAdminOverview>>;
const DATE_TIME = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const WON = new Intl.NumberFormat('ko-KR');
export const CHERRY_SERVICE_CONSOLE_PATH = `${NAMCHIN_ADMIN_CONSOLE_PATH}&view=service`;

const OUTCOMES: Record<string, string> = {
    done: '반영했습니다.', queued: '다시 확인하도록 예약했습니다.', running: '지금 확인 중입니다.', not_allowed: '지금 상태에서는 할 수 없습니다.',
    user_not_found: '해당 이메일의 회원이 없습니다.', username_invalid: '아이디 형식을 확인하세요.', checking: '계정을 확인하고 있습니다. 1분 뒤 다시 누르세요.',
    granted: '무료 이용권을 시작했습니다.', already_subscribed: '이미 이용 중인 회원입니다.', limited: '조회 한도를 넘었습니다.',
    payment_unavailable: '토스 설정이 없습니다.', offer_in_use: '이 요금을 약속받은 회원이 있어 금액을 바꿀 수 없습니다. 새 혜택을 추가하세요.', invalid: '지급할 수 없는 상태입니다.',
};
const TOGGLES = [
    ['sales_enabled', '판매'], ['monitoring_enabled', '감시'], ['notifications_enabled', '알림 발송'],
    ['ai_enabled', 'AI 요약'], ['auto_refund_enabled', '토스 자동 환불'],
] as const;

function text(value: unknown): string {
    return value === null || value === undefined || value === '' ? '-' : String(value);
}
function when(value: unknown): string {
    return typeof value === 'string' ? DATE_TIME.format(new Date(value)) : '-';
}

function Table({ label, head, children, empty }: { label: string; head: string[]; children: ReactNode[]; empty: string }) {
    return <div className="ac-table-box"><table className="ac-table" aria-label={label}>
        <thead><tr>{head.map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead>
        <tbody>{children.length > 0 ? children : <EmptyRow colSpan={head.length}>{empty}</EmptyRow>}</tbody>
    </table></div>;
}

export function CherryServiceConsole() {
    const [overview, setOverview] = useState<Overview | null>(null);
    const [failed, setFailed] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [block, setBlock] = useState('');

    const load = useCallback(async () => {
        try {
            const response = await fetch('/api/admin/cherry', { cache: 'no-store' });
            if (!response.ok) throw new Error('unavailable');
            setOverview(await response.json() as Overview);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);
    useEffect(() => {
        // The first load also sets state from an external system.
        const timer = setTimeout(() => void load(), 0);
        return () => clearTimeout(timer);
    }, [load]);

    const act = async (action: CherryAdminAction, confirmText?: string) => {
        if (busy || (confirmText && !window.confirm(confirmText))) return;
        setBusy(true);
        setMessage(null);
        try {
            const response = await fetch('/api/admin/cherry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), cache: 'no-store' });
            const data = await response.json() as { outcome?: string };
            setMessage(response.ok ? OUTCOMES[data.outcome ?? ''] ?? `결과: ${data.outcome}` : '처리하지 못했습니다.');
            await load();
        } catch {
            setMessage('처리하지 못했습니다.');
        }
        setBusy(false);
    };

    const settings = overview?.settings;
    return <div className="ac-app ac-namchin">
        <aside className="ac-side">
            <Link className="ac-brand" href={CHERRY_SERVICE_CONSOLE_PATH}>
                <Image src="/cherry/logo.png" className="ac-namchin-mark" alt="" width={34} height={34} unoptimized />
                <span><b>체리</b><small>운영 콘솔</small></span>
            </Link>
            <nav className="ac-nav" aria-label="콘솔 메뉴">
                <div className="ac-nav-label">운영</div>
                <Link className="ac-nav-btn is-active" href={CHERRY_SERVICE_CONSOLE_PATH} aria-current="page">서비스 운영</Link>
                <Link className="ac-nav-btn" href={NAMCHIN_ADMIN_CONSOLE_PATH}>사전 예약 명단</Link>
            </nav>
            <div className="ac-side-bottom"><ConsoleWorkspaceSwitch active="namchin" /></div>
        </aside>
        <main className="ac-main"><div className="ac-wrap">
            <header className="ac-top">
                <div>
                    <div className="ac-crumb"><span>운영 콘솔</span><span aria-hidden="true">/</span><span>체리(남친 맞팔 알리미)</span></div>
                    <h1>서비스 운영</h1>
                    <p>판매와 감시를 켜고 끄며 구독, 수집, 알림, 환불을 처리합니다.</p>
                </div>
                <button type="button" className="ac-btn" onClick={() => void load()}>새로고침</button>
            </header>
            <ErrorNotice message={failed ? '운영 정보를 불러오지 못했습니다.' : null} onRetry={() => void load()} />
            {message ? <p className="ac-alert" role="status">{message}</p> : null}
            {!overview || !settings ? (failed ? null : <Loading label="불러오는 중…" />) : <>
                <Card title="스위치" description={`테스트 결제 허용 회원 ${settings.tester_count}명 · 결제 수단 ${settings.payment_provider === 'toss' ? '토스 자동결제' : '그로블 1개월 이용권'}`}>
                    <div className="ac-tools-bar">
                        {TOGGLES.map(([key, label]) => <button key={key} type="button" className="ac-btn" disabled={busy} aria-pressed={settings[key]}
                            onClick={() => act({ action: 'settings', patch: { [key]: !settings[key] } }, `${label}을(를) ${settings[key] ? '끌까요' : '켤까요'}?`)}>
                            <Chip tone={settings[key] ? 'ok' : 'none'}>{label} {settings[key] ? '켜짐' : '꺼짐'}</Chip>
                        </button>)}
                        <button type="button" className="ac-btn" disabled={busy} onClick={() => act({ action: 'settings', patch: { payment_provider: settings.payment_provider === 'toss' ? 'groble' : 'toss' } }, '결제 수단을 바꿀까요? 새 결제부터 적용됩니다.')}>
                            {settings.payment_provider === 'toss' ? '그로블로 바꾸기' : '토스로 바꾸기'}
                        </button>
                    </div>
                </Card>
                <Card title="예산과 상태" description={`Apify 잔액 확인 ${when(settings.apify_observed_at)} · 초기화 ${when(settings.apify_cycle_end_at)}`}>
                    <Table label="예산과 상태" head={['항목', '값']} empty="">
                        {[
                            ['Apify 사용 / 한도', `$${text(settings.apify_usage_usd)} / $${text(settings.apify_limit_usd)}`],
                            ['체리가 더 쓸 수 있는 금액', `$${overview.availableUsd.toFixed(2)} (판독기 몫 $${settings.analyzer_reserve_usd} 제외)`],
                            ['최근 30일 체리 추정 비용', `$${overview.estimatedCostUsd.toFixed(2)}`],
                            ['구독', Object.entries(overview.subscriptionTotals).map(([key, value]) => `${key} ${value}`).join(', ') || '없음'],
                            ['최근 24시간 확인 작업', Object.entries(overview.checkTotals).map(([key, value]) => `${key} ${value}`).join(', ') || '없음'],
                            ['최근 7일 알림', Object.entries(overview.notificationTotals).map(([key, value]) => `${key} ${value}`).join(', ') || '없음'],
                            ['알림 채널', `알림톡 ${overview.channels.alimtalk ? '가능' : '없음'}, 문자 ${overview.channels.sms ? '가능' : '없음'}, 이메일 ${overview.channels.email ? '가능' : '없음'}, 토스 ${overview.channels.toss ? '설정됨' : '없음'}`],
                            ['예산 부족으로 기다리는 회원', `${overview.capacityWaiting}명`],
                        ].map(([name, value]) => <tr key={name}><td><b>{name}</b></td><td>{value}</td></tr>)}
                    </Table>
                </Card>
                <Card title="요금과 혜택" description="새 혜택은 코드와 그로블 상품을 등록한 뒤 켭니다. 회원에게는 쓸 수 있는 요금 중 가장 낮은 요금이 적용됩니다.">
                    <Table label="요금과 혜택" head={['코드', '이름', '금액', '대상', '가격 유지', '그로블 상품', '상태']} empty="요금이 없습니다.">
                        {overview.offers.map(offer => <tr key={String(offer.code)}>
                            <td><b>{text(offer.code)}</b></td><td>{text(offer.name)}</td><td className="ac-tabular">{WON.format(Number(offer.price_krw))}원</td>
                            <td>{offer.audience === 'reservation' ? '사전 예약자' : '모두'}</td><td>{offer.lock_months ? `${offer.lock_months}개월` : '-'}</td>
                            <td><button type="button" className="ac-link" disabled={busy} onClick={() => {
                                const product = window.prompt('그로블 상품 ID', text(offer.groble_product_id).replace('-', ''));
                                const address = product ? window.prompt('그로블 결제 주소(groble.im/payment/ 뒤)', text(offer.groble_payment_address).replace(/^-$/, '')) : null;
                                if (product && address) void act({ action: 'offer', code: String(offer.code), patch: { groble_product_id: product.trim(), groble_payment_address: address.trim() } });
                            }}>{offer.groble_product_id ? text(offer.groble_product_id) : '등록하기'}</button></td>
                            <td><button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'offer', code: String(offer.code), patch: { active: !offer.active } }, '이 요금의 판매 상태를 바꿀까요?')}>{offer.active ? '켜짐' : '꺼짐'}</button></td>
                        </tr>)}
                    </Table>
                    <div className="ac-tools-bar"><button type="button" className="ac-btn" disabled={busy} onClick={() => {
                        const code = window.prompt('새 혜택 코드(영문 소문자, 숫자, _)');
                        const name = code ? window.prompt('화면에 보일 이름') : null;
                        const price = name ? Number(window.prompt('월 금액(원)')) : 0;
                        const months = price ? Number(window.prompt('가격 유지 개월 수(없으면 0)')) : 0;
                        if (code && name && price) void act({ action: 'offer', code, patch: { name, price_krw: price, audience: 'everyone', lock_months: months > 0 ? months : null } });
                    }}>혜택 추가</button></div>
                </Card>
                <Card title="검증용 이용권" description="결제 없이 1개월을 시작하거나, 판매가 꺼진 동안 결제를 시험할 회원을 지정합니다.">
                    <form className="ac-tools-bar" onSubmit={event => { event.preventDefault(); void act({ action: 'grant', email, username }); }}>
                        <input type="email" required value={email} placeholder="회원 이메일" aria-label="회원 이메일" onChange={event => setEmail(event.target.value)} autoComplete="off" />
                        <input value={username} placeholder="인스타그램 아이디" aria-label="인스타그램 아이디" onChange={event => setUsername(event.target.value)} autoComplete="off" />
                        <button type="submit" className="ac-btn" disabled={busy || !username}>무료로 시작</button>
                        <button type="button" className="ac-btn" disabled={busy || !email} onClick={() => act({ action: 'tester', email, enabled: true })}>테스트 결제 허용</button>
                        <button type="button" className="ac-link" disabled={busy || !email} onClick={() => act({ action: 'tester', email, enabled: false })}>허용 해제</button>
                    </form>
                </Card>
                <Card title="환불" description="그로블 환불은 그로블에서 처리한 뒤 완료로 표시합니다.">
                    <Table label="환불" head={['요청', '금액', '사유', '상태', '처리']} empty="환불 요청이 없습니다.">
                        {overview.refunds.map(refund => <tr key={String(refund.id)}>
                            <td>{when(refund.requested_at)}</td><td className="ac-tabular">{WON.format(Number(refund.amount_krw))}원</td><td>{text(refund.reason)}</td>
                            <td>{text(refund.status)}{refund.failure_code ? ` (${refund.failure_code})` : ''}</td>
                            <td>{refund.status === 'manual_required' ? <button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'refund_done', refundId: String(refund.id) }, '결제사에서 환불을 마쳤나요?')}>완료로 표시</button>
                                : refund.status === 'pending' || refund.status === 'processing' ? <button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'refund_approve', refundId: String(refund.id) }, `토스에서 ${WON.format(Number(refund.amount_krw))}원을 환불할까요? 되돌릴 수 없습니다.`)}>토스로 환불</button> : '-'}</td>
                        </tr>)}
                    </Table>
                </Card>
                <Card title="확인이 필요한 결제">
                    <Table label="확인이 필요한 결제" head={['시각', '결제사', '금액', '내용', '결제번호']} empty="확인할 결제가 없습니다.">
                        {[...overview.reviews.map(payment => <tr key={String(payment.id)}>
                            <td>{when(payment.updated_at)}</td><td>{text(payment.provider)}</td><td className="ac-tabular">{WON.format(Number(payment.amount_krw))}원</td>
                            <td>{payment.status === 'processing' ? '승인 확인 중' : text(payment.review_reason)}</td><td>{text(payment.provider_payment_id)}</td>
                        </tr>), ...overview.events.map(event => <tr key={String(event.event_id)}>
                            <td>{when(event.received_at)}</td><td>{text(event.provider)}</td><td className="ac-tabular">{event.amount_krw ? `${WON.format(Number(event.amount_krw))}원` : '-'}</td>
                            <td>{event.disposition === 'cancel_requested' ? '구매자 취소 요청' : event.disposition === 'unmatched' ? '주문을 찾지 못한 결제' : '결제 내용 불일치'}</td><td>{text(event.provider_payment_id)}</td>
                        </tr>)]}
                    </Table>
                </Card>
                <Card title="구독">
                    <Table label="구독" head={['계정', '회원', '상태', '요금', '기준 목록', '마지막 확인', '이용 종료', '이번 달 수집', '처리']} empty="구독이 없습니다.">
                        {overview.subscriptions.map(row => <tr key={String(row.id)}>
                            <td><b>@{text(row.target_username)}</b><br />{text(row.followers_count)} / {text(row.following_count)}</td><td>{text(row.recipient_email)}</td>
                            <td><Chip tone={row.status === 'active' ? 'ok' : row.status === 'ended' ? 'none' : 'warn'}>{text(row.status)}</Chip>{row.status_reason ? ` ${row.status_reason}` : ''}{Number(row.failure_streak) > 0 ? ` 실패 ${row.failure_streak}` : ''}</td>
                            <td className="ac-tabular">{row.payment_provider === 'grant' ? '무료' : `${WON.format(Number(row.price_krw))}원`}</td><td>{when(row.baseline_at)}</td><td>{when(row.last_checked_at)}</td>
                            <td>{when(row.current_period_end)}{row.cancel_at_period_end ? ' 해지' : ''}</td><td className="ac-tabular">{WON.format(Number(row.items_used))}</td>
                            <td>{row.status === 'preparing' || row.status === 'active' ? <>
                                <button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'recheck', subscriptionId: String(row.id) }, '지금 다시 확인할까요? 수집 비용이 듭니다.')}>다시 확인</button>{' '}
                                <button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'end', subscriptionId: String(row.id) }, '이용을 끝내고 남은 기간 환불을 만들까요?')}>종료</button>
                            </> : '-'}</td>
                        </tr>)}
                    </Table>
                </Card>
                <Card title="실패하거나 늦어지는 확인">
                    <Table label="실패한 확인" head={['시각', '종류', '상태', '오류', '시도', '처리']} empty="문제가 없습니다.">
                        {overview.failedChecks.map(check => <tr key={String(check.id)}>
                            <td>{when(check.created_at)}</td><td>{check.kind === 'baseline' ? '첫 목록' : '매일 확인'}</td><td>{text(check.status)}</td><td>{text(check.error_code)}</td><td>{text(check.attempts)}</td>
                            <td><button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'recheck', subscriptionId: String(check.subscription_id) })}>다시 확인</button></td>
                        </tr>)}
                    </Table>
                </Card>
                <Card title="보내지 못했거나 결과를 모르는 알림" description="결과를 모르는 알림은 이미 도착했을 수 있어 자동으로 다시 보내지 않습니다.">
                    <Table label="알림 문제" head={['시각', '종류', '상태', '채널', '오류', '처리']} empty="문제가 없습니다.">
                        {overview.notificationProblems.map(item => <tr key={String(item.id)}>
                            <td>{when(item.created_at)}</td><td>{text(item.kind)}</td><td>{item.status === 'unconfirmed' ? '결과 모름' : '실패'}</td><td>{text(item.channel)}</td><td>{text(item.error_code)}</td>
                            <td><button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'resend', notificationId: String(item.id) }, '다시 보낼까요?')}>다시 보내기</button></td>
                        </tr>)}
                    </Table>
                </Card>
                <Card title="등록을 막은 계정" description="삭제·중단 요청을 받은 계정입니다. 이용 중이면 다음 확인 때 종료하고 환불을 만듭니다.">
                    <form className="ac-tools-bar" onSubmit={event => { event.preventDefault(); void act({ action: 'block', username: block, note: '' }, `@${block} 등록을 막을까요?`); setBlock(''); }}>
                        <input required value={block} placeholder="인스타그램 아이디" aria-label="막을 인스타그램 아이디" onChange={event => setBlock(event.target.value)} autoComplete="off" />
                        <button type="submit" className="ac-btn" disabled={busy}>등록 막기</button>
                    </form>
                    <Table label="등록을 막은 계정" head={['아이디', '추가', '처리']} empty="막은 계정이 없습니다.">
                        {overview.blocks.map(item => <tr key={String(item.id)}>
                            <td>@{text(item.username)}</td><td>{when(item.created_at)}</td>
                            <td><button type="button" className="ac-link" disabled={busy} onClick={() => act({ action: 'unblock', blockId: String(item.id) }, '차단을 풀까요?')}>풀기</button></td>
                        </tr>)}
                    </Table>
                </Card>
            </>}
        </div></main>
    </div>;
}
