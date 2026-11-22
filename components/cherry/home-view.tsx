import Link from 'next/link';
import type { MemberOverview } from '@/lib/services/cherry/member';
import type { CherrySubscription } from '@/lib/services/cherry/store';
import { koreanDayTime } from './format';
import { CherryActionButton, CherryRenewButton } from './home-actions';
import { CherryFace, CherryPair } from './shell';

const won = new Intl.NumberFormat('ko-KR');
const day = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
const fullDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
const reportDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' });

const ENDED: Record<string, string> = {
    target_private: '등록한 계정이 비공개로 바뀌어 이용을 멈췄어요.',
    target_not_found: '등록한 계정을 더는 확인할 수 없어 이용을 멈췄어요.',
    target_blocked: '등록한 계정의 확인을 중단했어요.',
    baseline_failed: '첫 목록을 저장하지 못해 이용을 취소했어요.',
    canceled: '해지한 이용 기간이 끝났어요.',
    payment_lapsed: '이용권이 끝났어요.',
    refunded: '환불이 끝나 이용을 멈췄어요.',
    operator: '고객센터 요청으로 이용을 멈췄어요.',
};

export interface CherryHomeRefund { amountKrw: number; status: string }

function PaymentNotice({ pay }: { pay: string | null }) {
    if (pay === 'checking') return <p className="ch-notice" role="status"><strong>결제 결과를 확인하고 있어요</strong>승인되면 자동으로 시작돼요. 다시 결제하지 마세요.</p>;
    if (pay === 'failed') return <p className="ch-error" role="alert" style={{ marginTop: 20 }}>결제가 완료되지 않았어요. 카드를 확인하고 다시 시도해 주세요.</p>;
    return null;
}

export function CherryHomeView({ subscription, overview, refund, pay, nowMs }: {
    subscription: CherrySubscription | null; overview: MemberOverview | null; refund: CherryHomeRefund | null; pay: string | null; nowMs: number;
}) {
    if (!subscription || !overview) {
        return <>
            <h1 className="ch-title">아직 등록한 계정이 없어요</h1>
            <PaymentNotice pay={pay} />
            <p className="ch-lead">방금 결제했다면 확인까지 1~2분 걸릴 수 있어요.</p>
            <div className="ch-form"><Link href="/cherry/start" className="ch-button">계정 등록하기</Link></div>
        </>;
    }
    const target = `@${subscription.target_username}`;
    const ended = subscription.status === 'ended';
    const periodEnd = subscription.current_period_end;
    const renewable = subscription.payment_provider === 'groble' && periodEnd !== null && !subscription.cancel_at_period_end
        && ['active', 'past_due'].includes(subscription.status) && Date.parse(periodEnd) - nowMs < 7 * 86_400_000;
    const automatic = subscription.payment_provider === 'toss' && !subscription.cancel_at_period_end;
    const declined = automatic && subscription.status === 'past_due';
    const latePreparing = subscription.status === 'preparing' && subscription.first_paid_at !== null
        && nowMs - Date.parse(subscription.first_paid_at) > 86_400_000;

    return <>
        <PaymentNotice pay={pay} />
        {ended ? null : <div style={{ marginTop: 20 }}>
            <CherryPair left={<CherryFace src={null} name={subscription.target_username} />} right={<CherryFace src={null} name="" open />} />
        </div>}
        <h1 className="ch-title" style={{ marginTop: 18 }}>{target}</h1>
        <p className="ch-state ch-lead">
            {subscription.status === 'preparing' ? '지금의 맞팔 목록을 저장하고 있어요. 보통 10분 안에 끝나요.' : null}
            {subscription.status === 'active' ? `맞팔 ${won.format(overview.mutuals)}명을 기준으로 매일 확인하고 있어요.` : null}
            {subscription.status === 'paused' ? '확인을 잠시 멈췄어요.' : null}
            {subscription.status === 'past_due' ? declined
                ? '결제가 승인되지 않아 확인을 멈췄어요. 4일 안에 카드를 바꾸면 이어서 확인해요.'
                : '이용권이 끝나 확인을 멈췄어요. 4일 안에 연장하면 기존 목록에서 이어서 확인해요.' : null}
            {ended ? ENDED[subscription.status_reason ?? ''] ?? '이용이 끝났어요.' : null}
        </p>
        {refund ? <p className="ch-notice"><strong>{refund.status === 'done' ? '환불을 마쳤어요' : '환불을 진행하고 있어요'}</strong>{won.format(refund.amountKrw)}원을 결제한 수단으로 돌려드려요.</p> : null}
        {latePreparing ? <div className="ch-notice">
            <strong>첫 목록 저장이 늦어지고 있어요</strong>계속 기다리거나 전액을 환불받을 수 있어요.
            <CherryActionButton action="cancel_preparing" label="전액 환불받기" />
        </div> : null}
        {renewable ? <div className="ch-actions"><CherryRenewButton label={`월 ${won.format(subscription.price_krw)}원으로 연장하기`} /></div> : null}
        {declined ? <div className="ch-actions"><CherryRenewButton label="카드 바꾸고 다시 결제하기" /></div> : null}
        {ended ? <div className="ch-form"><Link href="/cherry/start" className="ch-button">계정 다시 등록하기</Link></div> : null}

        <section className="ch-section">
            <h2 className="ch-heading">새 맞팔 리포트</h2>
            {overview.reports.length > 0 ? <div className="ch-lines">
                {overview.reports.map(report => <Link key={report.id} href={`/cherry/reports/${report.id}`} className="ch-report-link" prefetch={false}>
                    <span className="ch-report-count">{report.newCount}</span>
                    <span>
                        <span className="ch-report-names">{report.accounts.map(account => `@${account}`).join(', ')}{report.newCount > report.accounts.length ? ` 외 ${report.newCount - report.accounts.length}명` : ''}</span>
                        <br /><span className="ch-note">{reportDay.format(new Date(`${report.date}T00:00:00Z`))}</span>
                    </span>
                </Link>)}
            </div> : <p className="ch-empty">{subscription.status === 'preparing' ? '목록을 저장하면 그때부터 새로 생긴 맞팔을 확인해요.' : '아직 새로 확인한 맞팔이 없어요. 생기면 바로 알려드릴게요.'}</p>}
        </section>

        {overview.supplements.length > 0 ? <section className="ch-section">
            <h2 className="ch-heading">나중에 보인 맞팔</h2>
            <p className="ch-note" style={{ marginTop: 6 }}>앞선 목록에서 빠져 있던 계정이에요. 언제 맞팔이 됐는지 알 수 없어 따로 알리지 않았어요.</p>
            <dl className="ch-lines">{overview.supplements.map(item => <div key={`${item.username}-${item.detectedAt}`}>
                <dt>@{item.username}</dt><dd>{day.format(new Date(item.detectedAt))}</dd>
            </div>)}</dl>
        </section> : null}

        <section className="ch-section">
            <h2 className="ch-heading">이용 정보</h2>
            <dl className="ch-lines">
                {subscription.last_checked_at ? <div><dt>마지막 확인</dt><dd>{koreanDayTime(subscription.last_checked_at)}</dd></div> : null}
                {subscription.status === 'active' && subscription.next_check_at ? <div><dt>다음 확인</dt><dd>{koreanDayTime(subscription.next_check_at)} 무렵</dd></div> : null}
                <div><dt>요금</dt><dd>{subscription.payment_provider === 'grant' ? '무료 제공' : `월 ${won.format(subscription.price_krw)}원`}</dd></div>
                {subscription.price_lock_until && Date.parse(subscription.price_lock_until) > nowMs ? <div><dt>혜택 요금 적용</dt><dd>{fullDay.format(new Date(subscription.price_lock_until))}까지 결제분</dd></div> : null}
                {periodEnd && !ended ? <div><dt>{subscription.payment_provider === 'toss' && !subscription.cancel_at_period_end ? '다음 결제' : '이용 종료'}</dt><dd>{day.format(new Date(periodEnd))}</dd></div> : null}
                {overview.cardLabel && subscription.payment_provider === 'toss' ? <div><dt>결제 카드</dt><dd>{overview.cardLabel}</dd></div> : null}
                {subscription.recipient_phone ? <div><dt>알림 받는 번호</dt><dd>{subscription.recipient_phone.replace(/^\+82(\d{2})(\d{4})(\d{4})$/, '0$1-****-$3')}</dd></div> : null}
            </dl>
            <div className="ch-actions">
                {automatic && subscription.status === 'active' ? <CherryRenewButton label="결제 카드 바꾸기" quiet /> : null}
                {subscription.status === 'active' && !subscription.cancel_at_period_end ? <CherryActionButton action="cancel" label="해지하기" /> : null}
                {subscription.status === 'active' && subscription.cancel_at_period_end && subscription.payment_provider !== 'grant'
                    ? <CherryActionButton action="resume" label="해지 취소하기" /> : null}
                <a className="ch-text-button" href="mailto:contact@ascentum.co.kr">문의하기</a>
            </div>
        </section>
    </>;
}
