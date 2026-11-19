'use client';

import { useState } from 'react';
import type { OrderAuditListRow } from '@/lib/services/analysis/order-audit-list';
import {
    formatDateTime,
    formatKrw,
    formatUsd,
    knownCostLabel,
    listRowStatus,
    shortId,
    type OrderCustomer,
} from './console-data';
import { Card, Chip, EmptyRow, ErrorNotice, Segmented } from './console-ui';

type StatusFilter = 'all' | 'attention' | 'ok';
type PlanFilter = 'all' | OrderAuditListRow['planId'];

export function CustomerCell({ customer }: { customer: OrderCustomer | undefined }) {
    if (!customer) return <span className="ac-muted">미상</span>;
    const facts = [customer.gender, customer.birthyear ? `${customer.birthyear}년생` : null, customer.deviceLabel]
        .filter(Boolean).join(' · ');
    return <>
        <b className="ac-strong">{customer.userName ?? '이름 미상'}</b>
        <span className="ac-sub">{facts || '프로필 정보 없음'}</span>
    </>;
}

export function OrdersView({ rows, customers, loading, error, hasNext, onNext, onRetry, onOpen }: {
    rows: readonly OrderAuditListRow[];
    customers: ReadonlyMap<string, OrderCustomer>;
    loading: boolean;
    error: string | null;
    hasNext: boolean;
    onNext: () => void;
    onRetry: () => void;
    onOpen: (requestId: string) => void;
}) {
    const [status, setStatus] = useState<StatusFilter>('all');
    const [plan, setPlan] = useState<PlanFilter>('all');
    const decorated = rows.map(row => ({ row, status: listRowStatus(row) }));
    const attentionCount = decorated.filter(item => item.status.tone !== 'ok').length;
    const visible = decorated.filter(item => (status === 'all' || (status === 'attention' ? item.status.tone !== 'ok' : item.status.tone === 'ok'))
        && (plan === 'all' || item.row.planId === plan));

    return <Card>
        <div className="ac-toolbar">
            <Segmented
                label="주문 상태 필터"
                value={status}
                onChange={setStatus}
                options={[
                    { value: 'all', label: <>전체 <em>{rows.length}</em></> },
                    { value: 'attention', label: <>확인 필요 <em>{attentionCount}</em></> },
                    { value: 'ok', label: <>정상 <em>{rows.length - attentionCount}</em></> },
                ]}
            />
            <label className="ac-field ac-field--inline">요금제
                <select value={plan} onChange={event => setPlan(event.target.value as PlanFilter)}>
                    <option value="all">전체</option><option value="basic">basic</option><option value="standard">standard</option><option value="plus">plus</option>
                </select>
            </label>
            <span className="ac-spacer" />
            <span className="ac-meta">필터는 현재 불러온 {rows.length}건에 적용됩니다</span>
        </div>
        <ErrorNotice message={error} onRetry={onRetry} />
        <div className="ac-table-box"><table className="ac-table">
            <caption className="ac-sr">주문 감사 목록</caption>
            <thead><tr>
                <th scope="col">대상 · 요청</th><th scope="col">고객</th><th scope="col">유입 경로</th>
                <th scope="col" className="ac-num">결제</th><th scope="col" className="ac-num">실측 원가</th>
                <th scope="col">상태</th><th scope="col">결함 코드</th><th scope="col">조립 시각</th>
                <th scope="col"><span className="ac-sr">열기</span></th>
            </tr></thead>
            <tbody>
                {visible.length === 0 && !loading ? <EmptyRow colSpan={9}>{error ? '주문 목록을 확인할 수 없습니다.' : '조건에 맞는 주문이 없습니다.'}</EmptyRow> : null}
                {visible.map(({ row, status: rowStatus }) => {
                    const customer = customers.get(row.requestId);
                    return <tr key={row.requestId} className={rowStatus.tone === 'block' ? 'is-block' : rowStatus.tone === 'warn' ? 'is-flag' : undefined}>
                        <td><button type="button" className="ac-link" onClick={() => onOpen(row.requestId)}>@{row.targetInstagramId ?? '대상 미상'}</button><span className="ac-sub ac-tabular">{shortId(row.requestId)}</span></td>
                        <td><CustomerCell customer={customer} /></td>
                        <td>{customer?.attributionLabel ?? <span className="ac-muted">미상</span>}</td>
                        <td className="ac-num"><b className="ac-strong">{formatKrw(customer?.paidAmountKrw)}</b><span className="ac-sub">{row.planId}</span></td>
                        <td className="ac-num"><b className="ac-strong">{knownCostLabel(row.cost.knownUsd, row.cost.status)}</b>{row.cost.status !== 'complete' ? <span className="ac-sub">보수 추정 {formatUsd(row.cost.conservativeUsd)}</span> : null}</td>
                        <td><Chip tone={rowStatus.tone}>{rowStatus.label}</Chip><span className="ac-sub">{rowStatus.reason}</span></td>
                        <td>{row.gapCodes.length > 0 ? row.gapCodes.map(code => <span key={code} className="ac-gap">{code}</span>) : <span className="ac-muted">없음</span>}</td>
                        <td className="ac-muted">{formatDateTime(row.assembledAt)}</td>
                        <td><button type="button" className="ac-btn ac-btn--sm" aria-label={`@${row.targetInstagramId ?? '대상 미상'} 감사 번들 열기`} onClick={() => onOpen(row.requestId)}>열기</button></td>
                    </tr>;
                })}
            </tbody>
        </table></div>
        <div className="ac-pager" aria-live="polite">
            <span>{loading ? '주문 목록을 불러오는 중…' : `${rows.length}건을 불러왔습니다${hasNext ? ' · 다음 페이지 있음' : ''}`}</span>
            <button type="button" className="ac-btn ac-btn--sm" disabled={loading || !hasNext} onClick={onNext}>{loading ? '불러오는 중…' : '다음 25건'}</button>
        </div>
    </Card>;
}
