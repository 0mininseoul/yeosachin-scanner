'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthButtons } from '@/components/auth-buttons';
import {
    CHERRY_CONSENTS, CHERRY_LIST_PRICE_KRW, CHERRY_TERMS_VERSION, type CherryConsentId, type CherryTargetView,
} from '@/lib/services/cherry/contracts';
import { CherryFace } from './shell';
import { openTossBilling } from './toss-billing';

const POLL_MS = 1500;
const POLL_LIMIT_MS = 120_000;
const won = new Intl.NumberFormat('ko-KR');

const RESULT_MESSAGES: Record<string, string> = {
    private: '비공개 계정이에요. 공개 계정만 등록할 수 있어요.',
    not_found: '찾을 수 없는 아이디예요. 철자를 다시 확인해 주세요.',
    too_large: '팔로워와 팔로잉을 합쳐 1,500명이 넘는 계정은 아직 등록할 수 없어요.',
    too_small: '맞팔을 확인하기에는 팔로워와 팔로잉이 너무 적어요.',
    verified: '인증 배지가 있는 계정은 목록을 끝까지 확인할 수 없어 등록할 수 없어요.',
    blocked: '등록할 수 없는 계정이에요.',
    unavailable: '지금은 계정을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
};
const OUTCOME_MESSAGES: Record<string, string> = {
    sales_closed: '지금은 신규 등록을 받지 않고 있어요.',
    account_unavailable: '이용할 수 없는 계정이에요. contact@ascentum.co.kr로 문의해 주세요.',
    phone_required: '알림을 받을 휴대폰 번호가 필요해요. 카카오로 다시 로그인하고 전화번호 제공에 동의해 주세요.',
    already_subscribed: '이미 이용 중인 계정이 있어요. 내 서비스에서 확인해 주세요.',
    target_check_required: '계정 확인 시간이 지났어요. 아이디를 다시 확인해 주세요.',
    target_blocked: '등록할 수 없는 계정이에요.',
    capacity_wait: '지금 등록할 수 있는 자리가 모두 찼어요. 청구된 금액은 없고, 자리가 나면 알려드릴게요.',
    payment_unavailable: '지금은 결제를 시작할 수 없어요. 잠시 뒤 다시 시도해 주세요.',
    payment_in_progress: '앞서 시작한 결제를 확인하고 있어요. 잠시 뒤 내 서비스에서 확인해 주세요.',
};

export interface CherryStartOffer { code: string; name: string; priceKrw: number; lockMonths: number | null }

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
    return { status: response.status, data: await response.json().catch(() => ({})) as Record<string, unknown> };
}

export function CherryAccountCard({ target }: { target: CherryTargetView }) {
    return <div className="ch-account">
        <CherryFace src={target.imagePath} name={target.username} />
        <div>
            <h2>@{target.username}</h2>
            {target.fullName ? <p className="ch-note">{target.fullName}</p> : null}
            <dl className="ch-counts">
                <div><dt>팔로워</dt><dd>{won.format(target.followersCount ?? 0)}</dd></div>
                <div><dt>팔로잉</dt><dd>{won.format(target.followingCount ?? 0)}</dd></div>
            </dl>
        </div>
    </div>;
}

export function CherryPrice({ offer }: { offer: CherryStartOffer | null }) {
    const price = offer?.priceKrw ?? CHERRY_LIST_PRICE_KRW;
    return <div className="ch-price">
        <strong>월 {won.format(price)}원</strong>
        {price < CHERRY_LIST_PRICE_KRW ? <del>월 {won.format(CHERRY_LIST_PRICE_KRW)}원</del> : null}
        {offer && price < CHERRY_LIST_PRICE_KRW
            ? <span>{offer.name}{offer.lockMonths ? `, 첫 결제일부터 ${offer.lockMonths === 12 ? '1년간' : `${offer.lockMonths}개월간`} 적용돼요` : '이 적용돼요'}</span>
            : null}
    </div>;
}

function Consents({ accepted, onChange }: {
    accepted: ReadonlySet<CherryConsentId>; onChange: (next: Set<CherryConsentId>) => void;
}) {
    const [open, setOpen] = useState<CherryConsentId | null>(null);
    const all = CHERRY_CONSENTS.every(item => accepted.has(item.id));
    return <div className="ch-consents">
        <div className="ch-consent ch-consent-row ch-consent-all">
            <input id="ch-all" type="checkbox" checked={all} onChange={event =>
                onChange(new Set(event.target.checked ? CHERRY_CONSENTS.map(item => item.id) : []))} />
            <label htmlFor="ch-all">모두 확인했고 동의해요</label>
        </div>
        {CHERRY_CONSENTS.map(item => <div className="ch-consent" key={item.id}>
            <div className="ch-consent-row">
                <input id={`ch-${item.id}`} type="checkbox" checked={accepted.has(item.id)} onChange={event => {
                    const next = new Set(accepted);
                    if (event.target.checked) next.add(item.id); else next.delete(item.id);
                    onChange(next);
                }} />
                <label htmlFor={`ch-${item.id}`}>{item.label}</label>
                <button type="button" aria-expanded={open === item.id} aria-controls={`ch-${item.id}-detail`}
                    onClick={() => setOpen(open === item.id ? null : item.id)}>{open === item.id ? '접기' : '내용 보기'}</button>
            </div>
            <div className="ch-consent-detail" id={`ch-${item.id}-detail`} hidden={open !== item.id}>
                {item.detail.map(line => <p key={line}>{line}</p>)}
            </div>
        </div>)}
    </div>;
}

export function CherryStartFlow({ signedIn, salesOpen, offer, email, initialCheckId, paymentFailed }: {
    signedIn: boolean; salesOpen: boolean; offer: CherryStartOffer | null; email: string | null;
    initialCheckId: string | null; paymentFailed: boolean;
}) {
    const [username, setUsername] = useState('');
    const [checkId, setCheckId] = useState(initialCheckId);
    const [target, setTarget] = useState<CherryTargetView | null>(null);
    const [error, setError] = useState<string | null>(paymentFailed ? '결제가 완료되지 않았어요. 다시 시도하거나 다른 카드를 사용해 주세요.' : null);
    const [accepted, setAccepted] = useState<Set<CherryConsentId>>(new Set());
    const [busy, setBusy] = useState(false);
    const [relogin, setRelogin] = useState(false);
    const submitted = useRef(false);

    const restart = useCallback((message: string | null = null) => {
        setCheckId(null);
        setTarget(null);
        setError(message);
        setAccepted(new Set());
        window.history.replaceState(null, '', '/cherry/start');
    }, []);

    useEffect(() => {
        if (!checkId || target?.status === 'done') return;
        const controller = new AbortController();
        const startedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const response = await fetch(`/api/cherry/target-checks/${checkId}`, { cache: 'no-store', signal: controller.signal });
                if (response.status === 404) return restart('계정 확인 시간이 지났어요. 아이디를 다시 입력해 주세요.');
                if (response.ok) {
                    const view = await response.json() as CherryTargetView;
                    if (view.status === 'done') return setTarget(view);
                }
            } catch {
                if (controller.signal.aborted) return;
            }
            if (Date.now() - startedAt > POLL_LIMIT_MS) return restart(RESULT_MESSAGES.unavailable);
            timer = setTimeout(poll, POLL_MS);
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [checkId, restart, target]);

    async function findAccount() {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const { status, data } = await postJson('/api/cherry/target-checks', { username });
            if (status === 200 && typeof data.id === 'string') {
                setTarget(null);
                setCheckId(data.id);
                window.history.replaceState(null, '', `/cherry/start?check=${data.id}`);
            } else {
                setError(status === 400 ? '인스타그램 아이디를 다시 확인해 주세요. 영문, 숫자, 마침표, 밑줄만 쓸 수 있어요.'
                    : status === 429 ? '오늘 확인할 수 있는 횟수를 모두 썼어요. 내일 다시 시도해 주세요.'
                        : RESULT_MESSAGES.unavailable);
            }
        } catch {
            setError('인터넷 연결을 확인하고 다시 시도해 주세요.');
        } finally {
            setBusy(false);
        }
    }

    async function pay() {
        if (submitted.current || !checkId) return;
        submitted.current = true;
        setBusy(true);
        setError(null);
        try {
            const { status, data } = await postJson('/api/cherry/checkout', {
                targetCheckId: checkId, termsVersion: CHERRY_TERMS_VERSION,
                consents: Object.fromEntries(CHERRY_CONSENTS.map(item => [item.id, accepted.has(item.id)])),
            });
            if (status === 401) return window.location.reload();
            if (data.outcome === 'ready' && data.provider === 'groble' && typeof data.redirectUrl === 'string') {
                return window.location.assign(data.redirectUrl);
            }
            if (data.outcome === 'ready' && data.provider === 'toss') {
                return await openTossBilling({
                    clientKey: String(data.clientKey), customerKey: String(data.customerKey), email, checkId,
                });
            }
            setRelogin(data.outcome === 'phone_required');
            setError(OUTCOME_MESSAGES[String(data.outcome)] ?? OUTCOME_MESSAGES.payment_unavailable);
        } catch {
            setError('결제창을 열지 못했어요. 잠시 뒤 다시 시도해 주세요.');
        }
        submitted.current = false;
        setBusy(false);
    }

    if (!salesOpen) {
        return <>
            <h1 className="ch-title">지금은 신규 등록을 받지 않고 있어요</h1>
            <p className="ch-lead">등록이 열리면 이 화면에서 바로 시작할 수 있어요.</p>
            <div className="ch-form"><Link className="ch-button" href="/cherry" prefetch={false}>체리 소개 보기</Link></div>
        </>;
    }

    if (checkId && !target) {
        return <section aria-live="polite">
            <h1 className="ch-title">공개 프로필을 확인하고 있어요</h1>
            <p className="ch-lead">보통 30초 안에 끝나요. 이 계정에는 아무 알림도 가지 않아요.</p>
            <div className="ch-spinner" role="status"><span className="sr-only">확인 중</span></div>
        </section>;
    }

    if (target && target.result === 'ok') {
        const price = offer?.priceKrw ?? CHERRY_LIST_PRICE_KRW;
        const ready = CHERRY_CONSENTS.every(item => accepted.has(item.id));
        return <>
            <h1 className="ch-title">이 계정이 맞나요?</h1>
            <CherryAccountCard target={target} />
            <button type="button" className="ch-text-button" onClick={() => restart()}>다른 계정 확인하기</button>
            <section className="ch-section">
                <h2 className="ch-heading">이용 요금</h2>
                <CherryPrice offer={offer} />
                <p className="ch-note">등록 계정 1개의 매일 확인, 새 맞팔 알림, 상세 리포트가 포함돼요. 부가세 포함 금액이에요.</p>
            </section>
            {signedIn ? <section className="ch-section">
                <h2 className="ch-heading">결제 전 확인</h2>
                <Consents accepted={accepted} onChange={setAccepted} />
                <p className="ch-note" style={{ margin: '14px 0' }}>
                    <Link href="/terms" target="_blank" className="underline">이용약관</Link>과{' '}
                    <Link href="/privacy" target="_blank" className="underline">개인정보처리방침</Link>도 함께 적용돼요.
                </p>
                {error ? <p className="ch-error" role="alert" style={{ marginBottom: 14 }}>{error}</p> : null}
                {relogin
                    ? <div className="ch-kakao"><AuthButtons redirectTo={`/cherry/start?check=${target.id}`} promptKakaoLogin kakaoLabel="카카오로 다시 로그인하기" /></div>
                    : <button type="button" className="ch-button" disabled={!ready || busy} onClick={pay}>
                        {busy ? '결제창을 여는 중' : `월 ${won.format(price)}원 결제하기`}
                    </button>}
            </section> : <section className="ch-section">
                <h2 className="ch-heading">알림 받을 카카오 계정</h2>
                <p className="ch-note" style={{ margin: '6px 0 14px' }}>카카오 계정의 휴대폰 번호로 알림을 보내요. 사전 예약 혜택도 이 번호로 확인해요.</p>
                <div className="ch-kakao"><AuthButtons redirectTo={`/cherry/start?check=${target.id}`} kakaoLabel="카카오로 계속하기" /></div>
            </section>}
        </>;
    }

    const problem = target?.result ? RESULT_MESSAGES[target.result] ?? RESULT_MESSAGES.unavailable : null;
    return <>
        <h1 className="ch-title">어떤 계정의 새 맞팔을 확인할까요?</h1>
        <form className="ch-form" onSubmit={event => { event.preventDefault(); void findAccount(); }}>
            <div className="ch-field">
                <label htmlFor="ch-username">인스타그램 아이디</label>
                <div className="ch-input">
                    <span aria-hidden="true">@</span>
                    <input id="ch-username" name="username" value={username} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                        autoComplete="off" inputMode="text" maxLength={120} placeholder="아이디 또는 프로필 링크" required
                        onChange={event => setUsername(event.target.value)} data-amp-mask />
                </div>
            </div>
            {error || problem ? <p className="ch-error" role="alert">{error ?? problem}</p> : null}
            <button type="submit" className="ch-button" disabled={busy || username.trim() === ''}>{busy ? '확인 요청 중' : '계정 확인하기'}</button>
        </form>
        <ul className="ch-facts">
            <li>공개 계정만 등록할 수 있어요.</li>
            <li>팔로워와 팔로잉을 합쳐 1,500명까지 확인해요.</li>
            <li>확인하는 계정에 로그인하거나 알림을 보내지 않아요.</li>
        </ul>
    </>;
}
