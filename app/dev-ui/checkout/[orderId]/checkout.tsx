'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isDevUiPresentation } from '@/lib/constants/dev-ui';
import { DEV_UI_ORDER_STATUS, DEV_UI_SCENARIO_LABELS, devUiHttpError, readDevUiCompletion, readDevUiOrderPayload, type DevUiOrderView } from '@/lib/services/dev-ui/client';
import { CaseCard, Eyebrow, TopBar } from '@/components/case-ui';

export function DevUiCheckout({ orderId }: { orderId: string }) {
    const router = useRouter();
    const [order, setOrder] = useState<DevUiOrderView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const inFlight = useRef(false);
    const endpoint = `/api/dev-ui/checkout/${encodeURIComponent(orderId)}`;
    const load = useCallback(async (signal?: AbortSignal) => {
        if (!isDevUiPresentation()) throw new Error('테스트 환경에서만 이용할 수 있습니다.');
        const response = await fetch(endpoint, { cache: 'no-store', signal });
        if (!response.ok) throw devUiHttpError(response.status);
        const value = readDevUiOrderPayload(await response.json());
        if (value.orderId !== orderId) throw new Error('테스트 주문을 확인할 수 없습니다.');
        if (signal?.aborted) return;
        setOrder(value);
        if (value.status === 'success' && value.runStatus !== 'expired') router.replace(value.nextUrl);
    }, [endpoint, orderId, router]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError('테스트 주문을 확인할 수 없습니다. 등록된 테스트 계정과 접근 권한을 확인해주세요.'); });
        return () => controller.abort();
    }, [load]);

    const complete = async (outcome: 'success' | 'cancel' | 'failure') => {
        if (inFlight.current || !order || order.status !== 'pending') return;
        inFlight.current = true; setPending(true); setError(null);
        try {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome }) });
            if (!response.ok) throw devUiHttpError(response.status);
            const completion = readDevUiCompletion(await response.json(), orderId);
            if (completion.status === 'success') router.replace(`/progress/${completion.runId}`);
            else await load();
        } catch { setError('모의 결제 처리 결과를 확인할 수 없습니다. 다시 조회해 같은 주문을 복구해주세요.'); }
        finally { inFlight.current = false; setPending(false); }
    };

    return <div className="min-h-dvh"><TopBar /><main className="mx-auto max-w-[500px] px-5 pb-12 pt-7">
        <Eyebrow>Dev · 모의 결제</Eyebrow><h1 className="mt-3 text-[26px] font-extrabold text-fg">테스트 결제창</h1>
        <p className="mt-3 text-[13px] text-fg-dim">실제 카드 과금은 발생하지 않습니다. 성공 선택 후 합성 분석이 자동으로 진행됩니다.</p>
        {error && <div className="mt-6" role="alert"><p className="text-[13px] text-blood-2">{error}</p><button className="mt-3 text-[13px] underline" onClick={() => { setError(null); void load().catch(() => setError('테스트 주문 조회에 실패했습니다.')); }}>다시 조회</button></div>}
        {order && <CaseCard className="mt-7 p-5"><dl className="space-y-3 text-[14px] text-fg">
            <div><dt className="text-fg-mute">합성 대상</dt><dd>@{order.targetInstagramId}</dd></div>
            <div><dt className="text-fg-mute">플랜 / 표시 금액</dt><dd>{order.planId} · {order.price.status === 'quoted' ? `${order.price.amountKrw.toLocaleString('ko-KR')}원` : '금액 미정'}</dd></div>
            <div><dt className="text-fg-mute">상태 / 합성 시나리오</dt><dd>{DEV_UI_ORDER_STATUS[order.status]} · {DEV_UI_SCENARIO_LABELS[order.fixtureScenario]}</dd></div>
        </dl>
        {order.status === 'pending' && <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {([['success', '모의 결제 성공'], ['cancel', '모의 결제 취소'], ['failure', '모의 결제 실패']] as const).map(([outcome, label]) => <button key={outcome} className="min-h-12 border border-line px-3 py-3 text-[13px] text-fg disabled:opacity-50" disabled={pending} onClick={() => void complete(outcome)}>{label}</button>)}
        </div>}
        {order.status !== 'pending' && order.status !== 'success' && <p className="mt-5 text-[13px] text-fg-dim">분석 실행은 생성되지 않았습니다. 새 사전 점검으로 다시 테스트할 수 있습니다.</p>}
        {order.runStatus === 'expired' && <p className="mt-5 text-[13px] text-fg-dim">합성 실행의 보존 기간이 지났습니다.</p>}
        </CaseCard>}
        {!order && !error && <p className="mt-7 text-[13px] text-fg-dim" role="status">주문 확인 중…</p>}
        <nav className="mt-7 flex gap-6 text-[13px] text-fg-dim"><Link href="/analyze">새 사전 점검</Link><Link href="/mypage">모의 주문 보관함</Link></nav>
    </main></div>;
}
