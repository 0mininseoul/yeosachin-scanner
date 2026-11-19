'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApifyAccountCreditInventoryRow } from '@/lib/contracts/apify-account-credit-inventory';
import type { OrderAuditSummary } from '@/lib/services/analysis/order-audit-bundle';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    PAGE_SIZE,
    accountTone,
    adminOrderStatus,
    adminOrdersSchema,
    errorMessage,
    formatDateTime,
    inventoryEnvelopeSchema,
    overviewSchema,
    requestJson,
    type AdminOrderRow,
    type ConsoleOverview,
} from './console-data';
import { AccountsView } from './accounts-view';
import { LeadsView } from './leads-view';
import { OrderDetailView } from './order-detail-view';
import { OrdersView } from './orders-view';
import { OverviewView } from './overview-view';
import { UsersView } from './users-view';

type View = 'overview' | 'orders' | 'users' | 'accounts' | 'leads';
type Selection = { requestId: string | null; order: AdminOrderRow | null };

const VIEWS: readonly View[] = ['overview', 'orders', 'users', 'accounts', 'leads'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TITLES: Record<View, { title: string; description: string }> = {
    overview: { title: '개요', description: '지금 조치가 필요한 항목과 리소스 상태를 한 화면에서 확인합니다.' },
    orders: { title: '주문 감사', description: '결제 완료된 모든 주문 · 결제 시각 최신순 · 감사 번들이 있으면 함께 표시합니다.' },
    users: { title: '유저', description: '유저 DB의 모든 컬럼과 유저별 결제·분석 입력 합계' },
    accounts: { title: 'Apify 계정', description: '잔액 스냅샷과 배차 상태 · 유료 1개 + 무료 9개' },
    leads: { title: '리드', description: '유저가 분석할 계정을 입력한 기록 · 최신순' },
};

function NavIcon({ view }: { view: View }) {
    const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
    if (view === 'overview') return <svg {...common}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>;
    if (view === 'orders') return <svg {...common}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>;
    if (view === 'users') return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>;
    if (view === 'accounts') return <svg {...common}><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M6 15h4" /></svg>;
    return <svg {...common}><circle cx="9" cy="8" r="4" /><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M17 4a4 4 0 0 1 0 8M22 21c0-2.9-1.7-5.4-4.2-6.4" /></svg>;
}

function parseView(value: string | undefined): View {
    return VIEWS.includes(value as View) ? value as View : 'overview';
}

function writeLocation(view: View, requestId: string | null) {
    const url = new URL(window.location.href);
    if (view === 'overview' && !requestId) url.searchParams.delete('view'); else url.searchParams.set('view', view);
    if (requestId) url.searchParams.set('requestId', requestId); else url.searchParams.delete('requestId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function AdminConsole({ initialRequestId, initialView }: { initialRequestId: string; initialView?: string }) {
    const [view, setView] = useState<View>(() => (UUID.test(initialRequestId) ? 'orders' : parseView(initialView)));
    const [selection, setSelection] = useState<Selection | null>(
        UUID.test(initialRequestId) ? { requestId: initialRequestId, order: null } : null,
    );
    const [detailSummary, setDetailSummary] = useState<OrderAuditSummary | null>(null);
    const [search, setSearch] = useState('');
    const [searchError, setSearchError] = useState<string | null>(null);
    const [syncedAt, setSyncedAt] = useState<string | null>(null);

    const [overview, setOverview] = useState<ConsoleOverview | null>(null);
    const [overviewError, setOverviewError] = useState<string | null>(null);

    const [inventory, setInventory] = useState<readonly ApifyAccountCreditInventoryRow[] | null>(null);
    const [inventoryError, setInventoryError] = useState<string | null>(null);
    const [inventoryActionError, setInventoryActionError] = useState<string | null>(null);
    const [busySlot, setBusySlot] = useState<ApifyCredentialSlot | null>(null);
    const [paidBusy, setPaidBusy] = useState(false);

    const [orders, setOrders] = useState<readonly AdminOrderRow[]>([]);
    const [ordersCursor, setOrdersCursor] = useState<string | null>(null);
    const [ordersLoading, setOrdersLoading] = useState(true);
    const [ordersError, setOrdersError] = useState<string | null>(null);
    const ordersSequence = useRef(0);

    const loadOverview = useCallback(async () => {
        setOverviewError(null);
        try {
            setOverview(await requestJson('/api/admin/overview', overviewSchema));
        } catch (caught) {
            setOverviewError(errorMessage(caught, '개요 지표를 불러오지 못했습니다.'));
        }
    }, []);

    const loadInventory = useCallback(async () => {
        setInventoryError(null);
        try {
            setInventory((await requestJson('/api/admin/apify-accounts', inventoryEnvelopeSchema)).inventory);
            setInventoryActionError(null);
        } catch (caught) {
            setInventory(null);
            setInventoryError(errorMessage(caught, '계정 상태를 불러오지 못했습니다.'));
        }
    }, []);

    const loadOrders = useCallback(async (cursor: string | null) => {
        const sequence = ordersSequence.current + 1;
        ordersSequence.current = sequence;
        setOrdersLoading(true);
        setOrdersError(null);
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (cursor) params.set('cursor', cursor);
        try {
            const payload = await requestJson(`/api/admin/orders?${params.toString()}`, adminOrdersSchema);
            if (ordersSequence.current !== sequence) return;
            setOrders(previous => (cursor ? [...previous, ...payload.rows] : payload.rows));
            setOrdersCursor(payload.nextCursor);
        } catch (caught) {
            if (ordersSequence.current !== sequence) return;
            if (!cursor) { setOrders([]); setOrdersCursor(null); }
            setOrdersError(errorMessage(caught, '주문 목록을 불러오지 못했습니다.'));
        } finally {
            if (ordersSequence.current === sequence) setOrdersLoading(false);
        }
    }, []);

    const refreshAll = useCallback(() => {
        void Promise.allSettled([loadOverview(), loadInventory(), loadOrders(null)])
            .then(() => setSyncedAt(new Date().toISOString()));
    }, [loadInventory, loadOrders, loadOverview]);

    useEffect(() => { refreshAll(); }, [refreshAll]);

    const toggleExclusion = useCallback(async (row: ApifyAccountCreditInventoryRow) => {
        setBusySlot(row.credentialSlot);
        setInventoryActionError(null);
        try {
            const body = await requestJson('/api/admin/apify-accounts', inventoryEnvelopeSchema, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credentialSlot: row.credentialSlot, excluded: !row.manuallyExcluded }),
            });
            setInventory(body.inventory);
        } catch (caught) {
            setInventoryActionError(errorMessage(caught, '배차 상태를 저장하지 못했습니다.'));
        } finally {
            setBusySlot(null);
        }
    }, []);

    const refreshPaid = useCallback(async () => {
        setPaidBusy(true);
        setInventoryActionError(null);
        try {
            const body = await requestJson('/api/admin/apify-accounts', inventoryEnvelopeSchema, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'refresh-paid-secondary' }),
            });
            setInventory(body.inventory);
        } catch (caught) {
            setInventoryActionError(errorMessage(caught, '유료 계정 잔액을 새로고침하지 못했습니다.'));
            // The refresh may still have landed server-side; show the latest snapshot.
            void loadInventory();
        } finally {
            setPaidBusy(false);
        }
    }, [loadInventory]);

    const go = useCallback((next: View) => {
        setView(next);
        setSelection(null);
        setDetailSummary(null);
        setInventoryActionError(null);
        setSearchError(null);
        writeLocation(next, null);
        window.scrollTo({ top: 0 });
    }, []);

    const openOrder = useCallback((order: AdminOrderRow) => {
        setView('orders');
        setSelection({ requestId: order.requestId, order });
        setDetailSummary(null);
        writeLocation('orders', order.requestId);
        window.scrollTo({ top: 0 });
    }, []);

    const openRequest = useCallback((requestId: string) => {
        const known = orders.find(row => row.requestId === requestId);
        if (known) { openOrder(known); return; }
        setView('orders');
        setSelection({ requestId, order: null });
        setDetailSummary(null);
        writeLocation('orders', requestId);
        window.scrollTo({ top: 0 });
    }, [openOrder, orders]);

    const onSearch = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const value = search.trim();
        setSearchError(null);
        if (UUID.test(value)) { openRequest(value.toLowerCase()); setSearch(''); return; }
        const target = value.replace(/^@+/, '').toLowerCase();
        const match = orders.find(row => row.targetInstagramId.toLowerCase() === target);
        if (match) { openOrder(match); setSearch(''); return; }
        setSearchError(target ? '불러온 주문에서 찾지 못했습니다. 요청 ID로 검색해 보세요.' : null);
    };

    const orderAttention = useMemo(() => orders.filter(row => {
        const tone = adminOrderStatus(row).tone;
        return tone === 'warn' || tone === 'block';
    }).length, [orders]);
    const accountAttention = useMemo(() => (inventory ?? []).filter(row => {
        const tone = accountTone(row).tone;
        return tone === 'warn' || tone === 'block';
    }).length, [inventory]);
    const counts: Partial<Record<View, number>> = {
        overview: orderAttention + accountAttention,
        orders: orderAttention,
        accounts: accountAttention,
    };

    const selectedTarget = selection?.order?.targetInstagramId ?? detailSummary?.targetInstagramId;
    const header = selection
        ? { title: `@${selectedTarget ?? '주문'}`, description: selection.requestId ? `주문 · 요청 ${selection.requestId}` : `주문 ${selection.order?.orderId ?? ''}` }
        : TITLES[view];

    let body: ReactNode;
    if (selection) {
        body = <OrderDetailView
            key={selection.order?.orderId ?? selection.requestId ?? 'order'}
            requestId={selection.requestId}
            order={selection.order}
            onSummary={setDetailSummary}
        />;
    } else if (view === 'overview') {
        body = <OverviewView
            overview={overview}
            overviewError={overviewError}
            onRetryOverview={() => void loadOverview()}
            inventory={inventory}
            inventoryError={inventoryError}
            orders={orders}
            ordersLoading={ordersLoading}
            onOpenOrder={openOrder}
            onOpenAccounts={() => go('accounts')}
            onOpenOrders={() => go('orders')}
        />;
    } else if (view === 'orders') {
        body = <OrdersView
            rows={orders}
            loading={ordersLoading}
            error={ordersError}
            hasNext={ordersCursor !== null}
            onNext={() => { if (ordersCursor) void loadOrders(ordersCursor); }}
            onRetry={() => void loadOrders(null)}
            onOpen={openOrder}
        />;
    } else if (view === 'users') {
        body = <UsersView />;
    } else if (view === 'accounts') {
        body = <AccountsView
            inventory={inventory}
            loadError={inventoryError}
            actionError={inventoryActionError}
            busySlot={busySlot}
            paidBusy={paidBusy}
            onRetry={() => void loadInventory()}
            onToggle={row => void toggleExclusion(row)}
            onRefreshPaid={() => void refreshPaid()}
        />;
    } else {
        body = <LeadsView />;
    }

    return <div className="ac-app">
        <aside className="ac-side">
            <Link className="ac-brand" href="/admin0min" aria-label="위장여사친 판독기 운영 콘솔 처음으로">
                <Image src="/logo.png" alt="" width={34} height={34} className="ac-brand-logo" priority />
                <span><b>위장여사친 <em>판독기</em></b><small>운영 콘솔 · production</small></span>
            </Link>
            <nav className="ac-nav" aria-label="콘솔 메뉴">
                <div className="ac-nav-label">운영</div>
                {VIEWS.map(item => <button
                    key={item}
                    type="button"
                    className={`ac-nav-btn${view === item ? ' is-active' : ''}`}
                    aria-current={view === item ? 'page' : undefined}
                    onClick={() => go(item)}
                >
                    <NavIcon view={item} />{TITLES[item].title}
                    {counts[item] ? <span className="ac-nav-count">{counts[item]}</span> : null}
                </button>)}
            </nav>
            <div className="ac-side-foot"><span className="ac-live-dot" />operator session<br />응답 캐시 private / no-store<br />확인할 수 없는 값은 <b>미상</b>으로 표시</div>
        </aside>
        <main className="ac-main"><div className="ac-wrap">
            <header className="ac-top">
                <div>
                    <div className="ac-crumb">{selection
                        ? <><button type="button" className="ac-link" onClick={() => go('orders')}>← 주문 감사</button><span>/</span><span className="ac-tabular">@{selectedTarget ?? '주문'}</span></>
                        : <span>운영 콘솔</span>}</div>
                    <h1>{header.title}</h1>
                    <p>{header.description}</p>
                </div>
                <div className="ac-top-tools">
                    <form className="ac-search" role="search" onSubmit={onSearch}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                        <label className="ac-sr" htmlFor="ac-search-input">요청 ID 또는 대상 검색</label>
                        <input id="ac-search-input" type="search" value={search} placeholder="요청 ID 또는 @대상으로 바로 열기" onChange={event => setSearch(event.target.value)} />
                    </form>
                    <span className="ac-meta">{syncedAt ? `동기화 ${formatDateTime(syncedAt)}` : '동기화 중'}</span>
                    <button type="button" className="ac-btn" onClick={refreshAll}>새로고침</button>
                </div>
            </header>
            {searchError ? <p className="ac-alert ac-alert--soft" role="status">{searchError}</p> : null}
            {body}
        </div></main>
    </div>;
}
