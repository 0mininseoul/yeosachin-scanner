'use client';

import { useMemo, useState } from 'react';
import type { ApifyAccountCreditInventoryRow } from '@/lib/contracts/apify-account-credit-inventory';
import { APIFY_FREE_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';
import type { OrderAuditListRow } from '@/lib/services/analysis/order-audit-list';
import {
    accountTone,
    formatCount,
    formatUsd,
    listRowStatus,
    remainingRatio,
    type ConsoleOverview,
    type OverviewBucket,
} from './console-data';
import { Card, Chip, ErrorNotice, Loading, Meter, Segmented } from './console-ui';
import { TrendChart } from './trend-chart';

type AttentionItem = {
    key: string;
    tone: 'warn' | 'block';
    title: string;
    detail: string;
    action: string;
    onOpen: () => void;
};

function kstDayLabel(start: string): string {
    const [, month, day] = start.split('-');
    return `${Number(month)}/${Number(day)}`;
}

function bucketLabels(buckets: readonly OverviewBucket[], weekly: boolean) {
    const last = buckets.length - 1;
    const axis = buckets.map((bucket, i) => {
        if (i === last) return weekly ? '이번 주' : '오늘';
        if (weekly) return kstDayLabel(bucket.start);
        return i % 3 === 0 && i < last - 1 ? kstDayLabel(bucket.start) : '';
    });
    const tooltip = buckets.map((bucket, i) => {
        const base = weekly ? `${kstDayLabel(bucket.start)} 주` : kstDayLabel(bucket.start);
        return i === last ? `${base} · ${weekly ? '이번 주' : '오늘'}` : base;
    });
    return { axis, tooltip };
}

function sum(values: readonly (number | null)[]): number | null {
    let total = 0;
    for (const value of values) {
        if (value === null) return null;
        total += value;
    }
    return total;
}

export function OverviewView({
    overview, overviewError, onRetryOverview,
    inventory, inventoryError, orders, ordersLoading,
    onOpenOrder, onOpenAccounts, onOpenOrders,
}: {
    overview: ConsoleOverview | null;
    overviewError: string | null;
    onRetryOverview: () => void;
    inventory: readonly ApifyAccountCreditInventoryRow[] | null;
    inventoryError: string | null;
    orders: readonly OrderAuditListRow[];
    ordersLoading: boolean;
    onOpenOrder: (requestId: string) => void;
    onOpenAccounts: () => void;
    onOpenOrders: () => void;
}) {
    const [period, setPeriod] = useState<'daily' | 'weekly'>('daily');
    const paid = inventory?.find(row => row.credentialSlot === 'secondary');
    const free = APIFY_FREE_CREDENTIAL_SLOTS.map(slot => ({ slot, row: inventory?.find(row => row.credentialSlot === slot) }));
    const freeReady = free.filter(item => accountTone(item.row).tone === 'ok').length;
    const freeTones = free.map(item => accountTone(item.row).tone);

    const attention = useMemo<AttentionItem[]>(() => {
        const orderItems = orders.map(row => ({ row, status: listRowStatus(row) }))
            .filter(item => item.status.tone !== 'ok')
            .map(item => ({
                key: `order:${item.row.requestId}`,
                tone: item.status.tone === 'block' ? 'block' as const : 'warn' as const,
                title: `주문 @${item.row.targetInstagramId ?? '대상 미상'}`,
                detail: item.row.gapCodes.length > 0 ? `${item.status.reason} · ${item.row.gapCodes.join(', ')}` : item.status.reason,
                action: '주문 열기',
                onOpen: () => onOpenOrder(item.row.requestId),
            }));
        const accountItems = inventory ? inventory
            .map(row => ({ row, tone: accountTone(row) }))
            .filter(item => item.tone.tone === 'warn' || item.tone.tone === 'block')
            .map(item => ({
                key: `account:${item.row.credentialSlot}`,
                tone: item.tone.tone as 'warn' | 'block',
                title: `${item.row.credentialSlot} 계정`,
                detail: item.tone.reason,
                action: '계정 보기',
                onOpen: onOpenAccounts,
            })) : [];
        return [...orderItems, ...accountItems].sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'block' ? -1 : 1));
    }, [inventory, onOpenAccounts, onOpenOrder, orders]);

    const buckets = overview ? (period === 'daily' ? overview.daily : overview.weekly) : [];
    const labels = bucketLabels(buckets, period === 'weekly');
    const span = period === 'daily' ? '최근 14일' : '최근 8주';
    const visitors = buckets.map(bucket => bucket.visitors);
    const visitorTotal = sum(visitors);
    const today = overview?.today;

    return <div className="ac-stack">
        <ErrorNotice message={overviewError} onRetry={onRetryOverview} />
        <div className="ac-kpis ac-kpis--main">
            <Card className="ac-kpi ac-kpi--main">
                <div className="ac-kpi-l">현재 접속 중인 유저<span className="ac-live"><i />실시간</span></div>
                <div className="ac-kpi-v">{overview ? formatCount(overview.activeUsersNow) : '…'}<small>명</small></div>
                <div className="ac-meta">{overview?.visitorSource === 'unavailable' ? 'Amplitude 연결 전 · 미상' : '최근 5분 내 활동 · Amplitude'}</div>
            </Card>
            <Card className="ac-kpi ac-kpi--main">
                <div className="ac-kpi-l">누적 가입자<span className="ac-kpi-tag">카카오 가입</span></div>
                <div className="ac-kpi-v">{overview ? formatCount(overview.signups.total) : '…'}<small>명</small></div>
                <div className="ac-meta">{overview ? `오늘 +${formatCount(overview.signups.today)} · 최근 7일 +${formatCount(overview.signups.last7Days)}` : '불러오는 중'}</div>
            </Card>
            <Card className="ac-kpi ac-kpi--main">
                <div className="ac-kpi-l">방문자 대비 결제전환율<span className="ac-kpi-tag">11/19 이후</span></div>
                <div className="ac-kpi-v">{overview ? (overview.conversion.ratePercent === null ? '미상' : overview.conversion.ratePercent.toFixed(2)) : '…'}{overview?.conversion.ratePercent !== null ? <small>%</small> : null}</div>
                <div className="ac-meta">{overview ? `결제자 ${formatCount(overview.conversion.payers)}명 / 순방문자 ${formatCount(overview.conversion.visitors)}명` : '불러오는 중'}</div>
            </Card>
        </div>

        <div className="ac-kpis">
            <Card className="ac-kpi ac-kpi--alert">
                <div className="ac-kpi-l">확인 필요<Chip tone="block">조치</Chip></div>
                <div className="ac-kpi-v">{attention.length}<small>건</small></div>
                <div className="ac-meta">주문 {attention.filter(item => item.key.startsWith('order')).length} · 계정 {attention.filter(item => item.key.startsWith('account')).length} · 로드된 데이터 기준</div>
            </Card>
            <Card className="ac-kpi">
                <div className="ac-kpi-l">유료 계정 잔액<span className="ac-kpi-tag">secondary</span></div>
                <div className="ac-kpi-v">{paid && paid.freshnessState === 'fresh' ? formatUsd(paid.effectiveRemainingUsd) : '미상'}<small>/ {paid && paid.freshnessState === 'fresh' ? formatUsd(paid.monthlyLimitUsd) : '미상'}</small></div>
                <Meter ratio={remainingRatio(paid)} />
                <div className="ac-meta">{inventoryError ? '계정 상태를 불러오지 못했습니다' : `이번 주기 사용 ${paid && paid.freshnessState === 'fresh' ? formatUsd(paid.monthlyUsageUsd) : '미상'}`}</div>
            </Card>
            <Card className="ac-kpi">
                <div className="ac-kpi-l">Apify 사용 가능 무료 토큰<span className="ac-kpi-tag">무료 9개 중</span></div>
                <div className="ac-kpi-v">{inventory ? freeReady : '…'}<small>/ 9개</small></div>
                <div className="ac-meta">주의 {freeTones.filter(t => t === 'warn').length} · 차단 {freeTones.filter(t => t === 'block').length} · 제외 {freeTones.filter(t => t === 'none').length}</div>
            </Card>
            <Card className="ac-kpi">
                <div className="ac-kpi-l">오늘 총 원가<span className="ac-kpi-tag">모든 호출 · KST</span></div>
                <div className="ac-kpi-v">{today ? formatUsd(today.knownCostUsd) : '…'}<small>확정</small></div>
                <div className="ac-meta">{today ? `보수 추정 상한 ${formatUsd(today.conservativeCostUsd)} · 미정산 호출 ${formatCount(today.unsettledCalls)}건` : '불러오는 중'}</div>
                {today ? <div className="ac-meta">preflight {formatUsd(today.preflightCostUsd)} · 분석 수집 {formatUsd(today.analysisCostUsd)} · AI {formatUsd(today.aiCostUsd)}</div> : null}
            </Card>
        </div>

        <div className="ac-cols">
            <Card title="확인 필요" description="심각도 순 · 현재 로드된 주문과 계정에서만 계산" actions={<button type="button" className="ac-btn ac-btn--sm" onClick={onOpenOrders}>주문 전체 보기</button>}>
                {ordersLoading && orders.length === 0 ? <Loading label="확인 필요 항목을 계산하는 중…" /> : attention.length === 0
                    ? <p className="ac-empty">현재 로드된 데이터에서 확인이 필요한 항목이 없습니다.</p>
                    : <ul className="ac-attention">{attention.map(item => <li key={item.key}>
                        <Chip tone={item.tone}>{item.tone === 'block' ? '차단' : '주의'}</Chip>
                        <div className="ac-attention-body"><b>{item.title}</b><span>{item.detail}</span></div>
                        <button type="button" className="ac-link" onClick={item.onOpen}>{item.action} →</button>
                    </li>)}</ul>}
            </Card>
            <Card title="Apify 계정 풀" description="잔여 USD · 스냅샷 신선도 반영" actions={<button type="button" className="ac-btn ac-btn--sm" onClick={onOpenAccounts}>관리</button>}>
                {!inventory ? <Loading label={inventoryError ?? '계정 상태를 불러오는 중…'} /> : <div className="ac-pool">
                    <div className="ac-pool-item is-paid">
                        <div className="ac-pool-top"><span className="ac-pool-name">secondary <span className="ac-role">유료 · 우선순위 1</span></span><b>{paid && paid.freshnessState === 'fresh' ? formatUsd(paid.effectiveRemainingUsd) : '미상'}</b></div>
                        <Meter ratio={remainingRatio(paid)} />
                    </div>
                    {free.map(item => {
                        const tone = accountTone(item.row);
                        return <div key={item.slot} className="ac-pool-item">
                            <div className="ac-pool-top"><span className="ac-pool-name"><span className={`ac-sd ac-sd-${tone.tone}`} aria-label={tone.label} /> {item.slot}</span><b>{item.row && item.row.freshnessState === 'fresh' ? formatUsd(item.row.effectiveRemainingUsd) : '미상'}</b></div>
                            <Meter ratio={remainingRatio(item.row)} tone={tone.tone} />
                        </div>;
                    })}
                </div>}
            </Card>
        </div>

        <Card
            title="추이"
            description={`${span} · ${period === 'daily' ? '일간' : '주간 (월요일 시작)'} · KST · 마지막 지점은 진행 중인 기간`}
            actions={<Segmented label="차트 기간 단위" value={period} onChange={setPeriod} options={[{ value: 'daily', label: '일간' }, { value: 'weekly', label: '주간' }]} />}
        >
            {!overview ? <Loading label={overviewError ? '추이를 불러오지 못했습니다.' : '추이를 불러오는 중…'} /> : <div className="ac-charts">
                <TrendChart
                    title="순방문자"
                    total={visitorTotal === null ? '미상' : `${formatCount(visitorTotal)}명`}
                    totalNote={`${span} 합계`}
                    labels={labels.axis}
                    tooltipLabels={labels.tooltip}
                    series={[{ name: '순방문자', color: '#2f5bea', fill: 'rgba(47,91,234,0.2)', values: visitors }]}
                    format={value => `${formatCount(value)}명`}
                    note={overview.visitorSource === 'unavailable' ? 'Amplitude 연결 전이라 방문자 수는 미상으로 표시됩니다.' : period === 'daily' ? '기간별 고유 방문자 · 같은 사람이 여러 번 와도 1명' : '주별 고유 방문자 · 주 안에서 중복 제거'}
                />
                <TrendChart
                    title="결제자"
                    total={`${formatCount(buckets.reduce((t, b) => t + b.payers, 0))}명`}
                    totalNote={`${span} 합계`}
                    labels={labels.axis}
                    tooltipLabels={labels.tooltip}
                    series={[
                        { name: 'Standard', color: '#2e9e5b', fill: 'rgba(46,158,91,0.24)', values: buckets.map(b => b.standardPayers) },
                        { name: 'Basic', color: '#8ccba5', fill: 'rgba(140,203,165,0.24)', values: buckets.map(b => b.basicPayers) },
                    ]}
                    format={value => `${formatCount(value)}명`}
                    note="결제 완료 기준 · 환불·취소 제외 · 같은 기간 중복 결제자는 1명"
                />
                <TrendChart
                    title="지출된 원가"
                    total={formatUsd(buckets.reduce((t, b) => t + b.knownCostUsd, 0))}
                    totalNote={`${span} 합계 · 확정`}
                    labels={labels.axis}
                    tooltipLabels={labels.tooltip}
                    series={[
                        { name: '확정 원가', color: '#c47a06', fill: 'rgba(217,139,11,0.24)', values: buckets.map(b => b.knownCostUsd) },
                        { name: '미확정 추정분', color: '#edbe6e', fill: 'rgba(237,190,110,0.24)', values: buckets.map(b => Math.max(0, b.conservativeCostUsd - b.knownCostUsd)) },
                    ]}
                    format={formatUsd}
                    note="결제하지 않은 preflight를 포함한 모든 Apify·AI 호출 · 인프라 비용 제외"
                />
            </div>}
        </Card>
    </div>;
}
