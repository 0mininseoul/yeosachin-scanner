'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { isDevUiPresentation } from '@/lib/constants/dev-ui';
import { DEV_UI_ORDER_STATUS, DEV_UI_SCENARIO_LABELS, devUiHttpError, readDevUiOrderListPayload, readDevUiOrderPayload, type DevUiOrderView } from '@/lib/services/dev-ui/client';

export function DevUiOrderList({ administrator = false }: { administrator?: boolean }) {
    const [orders, setOrders] = useState<DevUiOrderView[] | null>(null);
    const [detail, setDetail] = useState<DevUiOrderView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const endpoint = administrator ? '/api/admin/order-audit' : '/api/dev-ui/orders';
    const load = useCallback(async (signal?: AbortSignal) => {
        if (!isDevUiPresentation()) throw new Error('테스트 환경에서만 이용할 수 있습니다.');
        const response = await fetch(endpoint, { cache: 'no-store', signal });
        if (!response.ok) throw devUiHttpError(response.status);
        const values = readDevUiOrderListPayload(await response.json());
        if (!signal?.aborted) setOrders(values);
    }, [endpoint]);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError('모의 주문 조회에 실패했습니다. 등록된 테스트 계정과 접근 권한을 확인해주세요.'); });
        return () => controller.abort();
    }, [load]);
    const readDetail = async (orderId: string) => {
        setError(null);
        try {
            const response = await fetch(`/api/admin/order-audit/${orderId}`, { cache: 'no-store' });
            if (!response.ok) throw devUiHttpError(response.status);
            const value = readDevUiOrderPayload(await response.json());
            if (value.orderId !== orderId) throw new Error();
            setDetail(value);
        } catch { setError('모의 감사 상세 조회에 실패했습니다.'); }
    };
    return <section aria-label={administrator ? 'Dev 모의 주문 감사' : 'Dev 모의 주문 보관함'}>
        <p className="text-[13px] text-fg-dim">모의 결제와 합성 실행 기록입니다. 실제 결제·수집·AI 실행을 하지 않습니다.</p>
        <button className="mt-4 min-h-10 text-[13px] underline" onClick={() => { setError(null); void load().catch(() => setError('모의 주문 조회에 실패했습니다.')); }}>주문 다시 조회</button>
        {error && <p className="mt-4 text-[13px] text-blood-2" role="alert">{error}</p>}
        {orders === null && !error && <p className="mt-5 text-[13px] text-fg-dim" role="status">모의 주문 조회 중…</p>}
        {orders?.length === 0 && <div className="mt-7 border border-line p-5"><p>모의 주문이 없습니다.</p><Link className="mt-3 inline-block text-[13px] underline" href="/analyze">테스트 시작하기</Link></div>}
        <ul className="mt-5 space-y-4">{orders?.map(order => <li key={order.orderId} className="border border-line p-5">
            <p className="font-semibold text-fg">@{order.targetInstagramId}</p>
            <p className="mt-2 text-[13px] text-fg-dim">{order.planId} · {DEV_UI_ORDER_STATUS[order.status]} · {DEV_UI_SCENARIO_LABELS[order.fixtureScenario]}</p>
            <p className="mt-2 text-[12px] text-fg-mute">{order.runStatus ? `합성 실행: ${order.runStatus}` : '분석 시작 전'} · {new Date(order.createdAt).toLocaleString('ko-KR')}</p>
            {administrator ? <button className="mt-3 min-h-10 text-[13px] underline" onClick={() => void readDetail(order.orderId)}>모의 감사 상세</button>
                : order.runStatus !== 'expired' && <Link className="mt-3 inline-block min-h-10 text-[13px] underline" href={order.nextUrl}>{order.status === 'success' ? '합성 실행 확인' : '모의 주문 확인'}</Link>}
        </li>)}</ul>
        {detail && <div className="mt-6 border border-line p-5" aria-label="모의 감사 상세">
            <p className="font-semibold">@{detail.targetInstagramId} · {DEV_UI_ORDER_STATUS[detail.status]}</p>
            <p className="mt-2 text-[13px] text-fg-dim">{DEV_UI_SCENARIO_LABELS[detail.fixtureScenario]} · {detail.runStatus ?? '실행 없음'} · {detail.price.status === 'quoted' ? `${detail.price.amountKrw.toLocaleString('ko-KR')}원 표시` : '금액 미정'}</p>
            <p className="mt-2 text-[12px] text-fg-mute">주문과 합성 실행 연결을 읽기 전용으로 확인합니다.</p>
        </div>}
    </section>;
}
