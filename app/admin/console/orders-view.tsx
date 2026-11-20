'use client';

import { useState } from 'react';
import {
    adminOrderStatus,
    formatDateTime,
    formatKrw,
    orderCost,
    orderCustomerOf,
    type AdminOrderRow,
    type OrderCustomer,
} from './console-data';
import { Chip, EmptyRow, Segmented } from './console-ui';
import { TablePanel, TableTools, type ActiveFilter } from './table-panel';

type StatusFilter = 'all' | 'attention' | 'ok';
type PlanFilter = 'all' | 'basic' | 'standard' | 'plus';

export function CustomerCell({ customer }: { customer: OrderCustomer | undefined }) {
    if (!customer) return <span className="ac-muted">미상</span>;
    const facts = [customer.gender, customer.birthyear ? `${customer.birthyear}년생` : null, customer.deviceLabel]
        .filter(Boolean).join(' · ');
    return <>
        <b className="ac-strong">{customer.userName ?? '이름 미상'}</b>
        <span className="ac-sub">{facts || '프로필 정보 없음'}</span>
    </>;
}

const STATUS_LABEL: Record<StatusFilter, string> = { all: '전체', attention: '확인 필요', ok: '정상' };

export function OrdersView({ rows, loading, error, hasNext, onNext, onRetry, onOpen }: {
    rows: readonly AdminOrderRow[];
    loading: boolean;
    error: string | null;
    hasNext: boolean;
    onNext: () => void;
    onRetry: () => void;
    onOpen: (row: AdminOrderRow) => void;
}) {
    const [status, setStatus] = useState<StatusFilter>('all');
    const [plan, setPlan] = useState<PlanFilter>('all');
    const [query, setQuery] = useState('');
    const decorated = rows.map(row => ({ row, status: adminOrderStatus(row), customer: orderCustomerOf(row) }));
    const attentionCount = decorated.filter(item => item.status.tone === 'warn' || item.status.tone === 'block').length;
    const okCount = decorated.filter(item => item.status.tone === 'ok').length;
    const needle = query.trim().replace(/^@+/, '').toLowerCase();
    const visible = decorated.filter(item => {
        const tone = item.status.tone;
        const statusMatch = status === 'all' || (status === 'attention' ? tone === 'warn' || tone === 'block' : tone === 'ok');
        const textMatch = !needle
            || item.row.targetInstagramId.toLowerCase().includes(needle)
            || (item.row.excludedInstagramId ?? '').toLowerCase().includes(needle)
            || (item.customer?.userName ?? '').toLowerCase().includes(needle);
        return statusMatch && textMatch && (plan === 'all' || item.row.planId === plan);
    });
    const activeFilters: ActiveFilter[] = [
        ...(status !== 'all' ? [{ key: 'status', label: STATUS_LABEL[status], onClear: () => setStatus('all') }] : []),
        ...(plan !== 'all' ? [{ key: 'plan', label: `요금제 ${plan}`, onClear: () => setPlan('all') }] : []),
    ];
    const filtered = visible.length !== rows.length;

    return <TablePanel
        tools={<TableTools
            summary={<><b>결제 주문</b><span className="ac-muted">{filtered ? `${visible.length} / ${rows.length}건` : `${rows.length}건`} · 결제 시각 최신순</span></>}
            search={{ value: query, onChange: setQuery, label: '주문 검색', placeholder: '대상 · 제외 계정 · 고객 이름' }}
            activeFilters={activeFilters}
            filters={<>
                <Segmented
                    label="주문 상태 필터"
                    value={status}
                    onChange={setStatus}
                    options={[
                        { value: 'all', label: <>전체 <em>{rows.length}</em></> },
                        { value: 'attention', label: <>확인 필요 <em>{attentionCount}</em></> },
                        { value: 'ok', label: <>정상 <em>{okCount}</em></> },
                    ]}
                />
                <label className="ac-field ac-field--inline">요금제
                    <select value={plan} onChange={event => setPlan(event.target.value as PlanFilter)}>
                        <option value="all">전체</option><option value="basic">basic</option><option value="standard">standard</option><option value="plus">plus</option>
                    </select>
                </label>
                <span className="ac-meta">검색·필터는 불러온 주문에 적용됩니다</span>
            </>}
        />}
        error={error}
        onRetry={onRetry}
        loading={loading}
        loadedLabel={`${rows.length}건 불러옴`}
        hasNext={hasNext}
        onLoadMore={onNext}
    >
        <table className="ac-table">
            <caption className="ac-sr">결제 주문 목록</caption>
            <thead><tr>
                <th scope="col">대상 · 결제 시각</th><th scope="col">고객</th><th scope="col">유입 경로</th>
                <th scope="col" className="ac-num">결제</th><th scope="col" className="ac-num">실측 원가</th>
                <th scope="col">상태</th><th scope="col">결함 코드</th>
                <th scope="col"><span className="ac-sr">열기</span></th>
            </tr></thead>
            <tbody>
                {visible.length === 0 && !loading ? <EmptyRow colSpan={8}>{error ? '주문 목록을 확인할 수 없습니다.' : '조건에 맞는 주문이 없습니다.'}</EmptyRow> : null}
                {visible.map(({ row, status: rowStatus, customer }) => {
                    const cost = orderCost(row);
                    return <tr key={row.orderId} className={rowStatus.tone === 'block' ? 'is-block' : rowStatus.tone === 'warn' ? 'is-flag' : undefined}>
                        <td><button type="button" className="ac-link" onClick={() => onOpen(row)}>@{row.targetInstagramId}</button><span className="ac-sub">{formatDateTime(row.paidAt)}{row.excludedInstagramId ? ` · 제외 @${row.excludedInstagramId}` : ''}</span></td>
                        <td><CustomerCell customer={customer} /></td>
                        <td>{row.attributionLabel ?? <span className="ac-muted">미상</span>}</td>
                        <td className="ac-num"><b className="ac-strong">{formatKrw(row.paidAmountKrw)}</b><span className="ac-sub">{row.planId}</span></td>
                        <td className="ac-num"><b className="ac-strong">{cost.known}</b>{cost.conservative ? <span className="ac-sub">보수 추정 {cost.conservative}</span> : null}</td>
                        <td><Chip tone={rowStatus.tone}>{rowStatus.label}</Chip><span className="ac-sub">{rowStatus.reason}</span></td>
                        <td>{row.bundle && row.bundle.gapCodes.length > 0 ? row.bundle.gapCodes.map(code => <span key={code} className="ac-gap">{code}</span>) : <span className="ac-muted">{row.bundle ? '없음' : '—'}</span>}</td>
                        <td><button type="button" className="ac-btn ac-btn--sm" aria-label={`@${row.targetInstagramId} 주문 열기`} onClick={() => onOpen(row)}>열기</button></td>
                    </tr>;
                })}
            </tbody>
        </table>
    </TablePanel>;
}
