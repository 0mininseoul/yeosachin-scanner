'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
    orderAuditLoadPayloadSchema,
    type GenderAuditRow,
    type InteractionAuditRow,
    type MutualAuditRow,
    type OrderAuditLoadPayload,
    type OrderAuditSummary,
    type RiskAuditRow,
} from '@/lib/services/analysis/order-audit-bundle';
import { deriveFirstDivergence } from '@/lib/services/analysis/operator-console-model';
import { stageSpecs } from '../analysis-audit/workbench';
import {
    PAGE_SIZE,
    errorMessage,
    formatCount,
    formatDateTime,
    formatKrw,
    formatUsd,
    knownCostLabel,
    adminOrderStatus,
    loadOrderCustomers,
    orderCost,
    orderCustomerOf,
    orderStatus,
    requestJson,
    shortId,
    type AdminOrderRow,
    type OrderCustomer,
    type Tone,
} from './console-data';
import { Card, Chip, ErrorNotice, Loading, Meter, Segmented } from './console-ui';

type StageSpec = ReturnType<typeof stageSpecs>[number];
type NumberedStage = StageSpec & { number: number };

const RETENTION_LABEL: Record<OrderAuditSummary['retention']['state'], string> = {
    retained: '영구 보관됨', pending: '보관 대기', fenced: '보관 차단', unknown: '보관 미상',
};
const RETENTION_TONE: Record<OrderAuditSummary['retention']['state'], Tone> = {
    retained: 'ok', pending: 'warn', fenced: 'block', unknown: 'none',
};
const COST_LABEL: Record<OrderAuditSummary['cost']['status'], string> = {
    complete: '완전', partial: '부분', unknown: '미상', not_available: '원장 없음',
};
const GENDER_LABEL: Record<NonNullable<GenderAuditRow['initial']['output']>, string> = {
    female: '여성', male: '남성', unknown: '불명', unavailable: '조회 불가',
};
const COMPONENT_LABEL: Record<string, string> = {
    candidateToTargetLikes: '상대 → 대상 좋아요',
    candidateToTargetComments: '상대 → 대상 댓글',
    candidateToTargetTagOrCaptionMention: '상대 → 대상 태그·멘션',
    targetToCandidateTagOrCaptionMention: '대상 → 상대 태그·멘션',
    targetToCandidateLike: '대상 → 상대 좋아요',
    recentMutual: '최근 맞팔 가산',
    appearanceExposure: '공개 프로필 특성',
    weakPartnerAdjustment: '관계 안전 조정',
};

function stageTone(spec: StageSpec): Tone {
    if (spec.declared === null || spec.collected === null || (spec.declared === 0 && spec.collected === 0)) return 'none';
    if (spec.declared === spec.collected) return 'ok';
    return spec.collected === 0 ? 'block' : 'warn';
}

const STAGE_LABEL: Record<Tone, string> = { ok: '완전', warn: '불완전', block: '미수집', none: '미상' };

function ledgerValue(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(1);
    if (typeof value === 'string' && value.length <= 120) return value;
    return '미상';
}

function MutualTable({ rows }: { rows: readonly MutualAuditRow[] }) {
    return <table className="ac-table"><caption className="ac-sr">맞팔 계정 목록</caption>
        <thead><tr><th className="ac-num">#</th><th>계정</th><th>공개 여부</th><th>프로필</th><th>최종 상태</th><th>행 상태</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.candidateId} className={row.completeness === 'partial' ? 'is-flag' : undefined}>
            <td className="ac-num">{formatCount(row.mutualOrdinal)}</td>
            <td className="ac-strong">@{row.username}{row.isVerified ? <span className="ac-muted"> · 인증</span> : null}</td>
            <td>{row.isPrivate ? '비공개' : '공개'}</td>
            <td>{row.profileAvailable ? '수집됨' : <span className="ac-gap">{row.profileFailureCode ?? '미수집'}</span>}</td>
            <td className="ac-tabular">{row.finalInclusionState}</td>
            <td><Chip tone={row.completeness === 'complete' ? 'ok' : 'warn'}>{row.completeness === 'complete' ? '완전' : '부분'}</Chip></td>
        </tr>)}</tbody>
    </table>;
}

function GenderTable({ rows, phase }: { rows: readonly GenderAuditRow[]; phase: 'initial' | 'final' }) {
    return <table className="ac-table"><caption className="ac-sr">{phase === 'initial' ? '1차' : '최종'} 성별 판정 목록</caption>
        <thead><tr><th>계정</th><th>공개 여부</th><th>판정</th><th className="ac-num">확신도</th><th>모델</th><th>근거</th><th>결과 해시</th></tr></thead>
        <tbody>{rows.map(row => {
            const result = row[phase];
            const tone: Tone = result.output === null ? 'block' : result.output === 'female' ? 'ok' : 'none';
            return <tr key={`${row.candidateId}:${phase}`} className={result.output === null ? 'is-block' : undefined}>
                <td className="ac-strong">@{row.username}</td>
                <td>{row.isPrivate ? '비공개' : '공개'}</td>
                <td><Chip tone={tone}>{result.output === null ? '판정 없음' : GENDER_LABEL[result.output]}</Chip></td>
                <td className="ac-num">{result.confidence ?? '미상'}</td>
                <td className="ac-tabular">{result.model ?? '미상'}</td>
                <td className="ac-muted ac-wrap">{result.reason ?? '근거 미상'}</td>
                <td className="ac-muted ac-tabular">{shortId(result.resultHash)}</td>
            </tr>;
        })}</tbody>
    </table>;
}

function InteractionTable({ rows, mode }: { rows: readonly InteractionAuditRow[]; mode: 'likes' | 'comments' }) {
    return <table className="ac-table"><caption className="ac-sr">{mode === 'likes' ? '대상 게시물 좋아요' : '대상 게시물 댓글'} 목록</caption>
        <thead><tr><th className="ac-num">#</th><th>계정</th><th>{mode === 'likes' ? '게시물' : '댓글'}</th><th>발생 시각</th><th>증거 ID</th><th>상태</th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.ordinal}:${row.evidenceId}`} className={row.completeness !== 'complete' ? 'is-flag' : undefined}>
            <td className="ac-num">{row.ordinal}</td>
            <td className="ac-strong">@{row.username ?? '미상'}</td>
            <td className={mode === 'comments' ? 'ac-wrap' : 'ac-tabular'}>{mode === 'comments' ? row.commentText ?? '댓글 내용 미상' : row.sourcePostId ?? '게시물 ID 미상'}</td>
            <td className="ac-muted">{formatDateTime(row.occurredAt)}</td>
            <td className="ac-muted ac-tabular">{row.evidenceId}</td>
            <td>{row.gapCodes.length > 0 ? <span className="ac-gap">{row.gapCodes[0]}</span> : <Chip tone={row.completeness === 'complete' ? 'ok' : 'warn'}>{row.completeness === 'complete' ? '완전' : '부분'}</Chip>}</td>
        </tr>)}</tbody>
    </table>;
}

function RiskTable({ rows, retention }: { rows: readonly RiskAuditRow[]; retention: OrderAuditSummary['retention'] }) {
    const [open, setOpen] = useState<string | null>(null);
    return <table className="ac-table"><caption className="ac-sr">공개 여성 후보별 위험 계산 원장</caption>
        <thead><tr><th className="ac-num">순위</th><th>계정</th><th className="ac-num">최종 점수</th><th>등급</th><th className="ac-num">원점수</th><th className="ac-num">공개 점수</th><th className="ac-num">최근 맞팔</th><th>산식</th></tr></thead>
        <tbody>{rows.map(row => {
            const expanded = open === row.candidateId;
            const panelId = `risk-${row.candidateId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
            return <Fragment key={row.candidateId}>
                <tr className={row.completeness === 'partial' ? 'is-flag' : undefined}>
                    <td className="ac-num">{formatCount(row.finalRank)}</td>
                    <td className="ac-strong">@{row.username}</td>
                    <td className="ac-num ac-strong">{row.finalScore === null ? '미상' : row.finalScore.toFixed(1)}</td>
                    <td>{row.riskBand ?? '미상'}</td>
                    <td className="ac-num ac-muted">{row.rawScore === null ? '미상' : row.rawScore.toFixed(1)}</td>
                    <td className="ac-num ac-muted">{row.publicScore === null ? '미상' : row.publicScore.toFixed(1)}</td>
                    <td className="ac-num ac-muted">{formatCount(row.recentMutualRank)}</td>
                    <td><button type="button" className="ac-link" aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : row.candidateId)}>{expanded ? '산식 닫기' : '산식 보기'}</button></td>
                </tr>
                {expanded ? <tr id={panelId}><td colSpan={8} className="ac-ledger-cell"><div className="ac-ledger">
                    <div><h3>기여도 원장 · {row.riskFormulaVersion ?? '버전 미상'}</h3><dl>
                        {Object.entries(row.riskComponents ?? {}).map(([key, value]) => <div key={key}><dt>{COMPONENT_LABEL[key] ?? key}</dt><dd>{ledgerValue(value)}</dd></div>)}
                        <div className="is-total"><dt>합계 · 원점수</dt><dd>{ledgerValue(row.rawScore)}</dd></div>
                    </dl></div>
                    <div><h3>점수 전이 · 영구 보관</h3><dl>
                        <div><dt>사전 점수</dt><dd>{ledgerValue(row.preScore)}</dd></div>
                        <div><dt>원점수</dt><dd>{ledgerValue(row.rawScore)}</dd></div>
                        <div><dt>공개 점수</dt><dd>{ledgerValue(row.publicScore)}</dd></div>
                        <div><dt>최종 점수</dt><dd>{ledgerValue(row.finalScore)}</dd></div>
                        <div><dt>노출 순위</dt><dd>{ledgerValue(row.featuredRank)}</dd></div>
                        <div><dt>관계 안전 해시</dt><dd className="ac-tabular">{shortId(row.partnerSafety.resultHash)}</dd></div>
                        <div><dt>번들 보관 상태</dt><dd>{RETENTION_LABEL[retention.state]}</dd></div>
                    </dl></div>
                </div></td></tr> : null}
            </Fragment>;
        })}</tbody>
    </table>;
}

function StageRows({ payload, spec }: { payload: OrderAuditLoadPayload; spec: StageSpec }) {
    if (payload.rows.length === 0) return <p className="ac-empty">저장된 행이 없습니다.</p>;
    if (spec.mode === 'mutuals' && payload.section === 'mutuals') return <MutualTable rows={payload.rows} />;
    if ((spec.mode === 'initial' || spec.mode === 'final') && payload.section === 'gender') return <GenderTable rows={payload.rows} phase={spec.mode} />;
    if ((spec.mode === 'likes' || spec.mode === 'comments') && payload.section === 'interactions') return <InteractionTable rows={payload.rows} mode={spec.mode} />;
    if (spec.mode === 'risk' && payload.section === 'risk') return <RiskTable rows={payload.rows} retention={payload.summary.retention} />;
    return <p className="ac-empty">이 구간의 데이터를 찾지 못했습니다.</p>;
}

function StagePanel({ requestId, spec }: { requestId: string; spec: NumberedStage }) {
    const [filter, setFilter] = useState(spec.filter);
    const [cursor, setCursor] = useState(0);
    const [payload, setPayload] = useState<OrderAuditLoadPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams({ section: spec.section, cursor: String(cursor), pageSize: String(PAGE_SIZE), filter });
        requestJson(`/api/admin/order-audit/${encodeURIComponent(requestId)}?${params.toString()}`, orderAuditLoadPayloadSchema, { signal: controller.signal })
            .then(next => {
                if (controller.signal.aborted) return;
                if (next.section !== spec.section) throw new Error('운영 데이터 구간이 일치하지 않습니다.');
                setPayload(next);
            })
            .catch(caught => {
                if (controller.signal.aborted) return;
                setPayload(null);
                setError(errorMessage(caught));
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [cursor, filter, reload, requestId, spec.section]);

    const begin = () => { setLoading(true); setError(null); };

    return <Card
        title={`STEP ${spec.number} · ${spec.title}`}
        description={`${spec.subtitle} · 수집 ${formatCount(spec.collected)} / 선언 ${formatCount(spec.declared)}`}
        actions={spec.filters.length > 1 ? <Segmented label="목록 필터" value={filter} onChange={value => { if (value === filter) return; begin(); setFilter(value); setCursor(0); }} options={spec.filters} /> : null}
    >
        <ErrorNotice message={error} onRetry={() => { begin(); setReload(value => value + 1); }} />
        {loading && !payload ? <Loading label="목록을 불러오는 중…" /> : payload ? <div className="ac-table-box"><StageRows payload={payload} spec={spec} /></div> : null}
        {payload ? <div className="ac-pager">
            <span>{formatCount(payload.total)}건 중 {formatCount(Math.min(cursor + payload.rows.length, payload.total))}건까지 표시</span>
            <div className="ac-row">
                <button type="button" className="ac-btn ac-btn--sm" disabled={loading || cursor === 0} onClick={() => { begin(); setCursor(Math.max(0, cursor - PAGE_SIZE)); }}>이전 25건</button>
                <button type="button" className="ac-btn ac-btn--sm" disabled={loading || payload.nextCursor === null} onClick={() => { if (payload.nextCursor === null) return; begin(); setCursor(payload.nextCursor); }}>다음 25건</button>
            </div>
        </div> : null}
    </Card>;
}

function CustomerFacts({ customer, planId }: { customer: OrderCustomer | undefined; planId: string }) {
    return <Card className="ac-facts ac-facts--customer">
        <div className="ac-fact"><span>고객</span><strong>{customer?.userName ?? '미상'}</strong></div>
        <div className="ac-fact"><span>성별 · 출생연도</span><strong>{[customer?.gender, customer?.birthyear].filter(Boolean).join(' · ') || '미상'}</strong></div>
        <div className="ac-fact"><span>디바이스</span><strong>{customer?.deviceLabel ?? '미상'}</strong></div>
        <div className="ac-fact"><span>유입 경로</span><strong>{customer?.attributionLabel ?? '미상'}</strong></div>
        <div className="ac-fact"><span>결제 금액</span><strong>{formatKrw(customer?.paidAmountKrw)}</strong><small>{planId}</small></div>
    </Card>;
}

/** Paid order without a permanent audit bundle: show the order facts honestly. */
function OrderOnlyView({ order, note }: { order: AdminOrderRow; note: string }) {
    const status = adminOrderStatus(order);
    const cost = orderCost(order);
    return <div className="ac-stack">
        <div className="ac-row ac-row--wrap">
            <Chip tone={status.tone}>{status.label}</Chip>
            <span>{status.reason}</span>
            <span className="ac-meta">· 결제 {formatDateTime(order.paidAt)} · {order.planId} · 주문 상태 {order.orderStatus}</span>
        </div>
        <CustomerFacts customer={orderCustomerOf(order)} planId={order.planId} />
        <div className="ac-kpis">
            <Card className="ac-kpi"><div className="ac-kpi-l">분석 대상</div><div className="ac-kpi-v ac-kpi-v--text">@{order.targetInstagramId}</div><div className="ac-meta">{order.excludedInstagramId ? `제외 @${order.excludedInstagramId}` : '제외 계정 없음'}</div></Card>
            <Card className="ac-kpi"><div className="ac-kpi-l">실측 원가</div><div className="ac-kpi-v">{cost.known}</div><div className="ac-meta">{cost.conservative ? `보수 추정 ${cost.conservative}` : order.costSnapshot || order.bundle ? '확정' : '원가 기록 없음'}</div></Card>
            <Card className="ac-kpi"><div className="ac-kpi-l">요청 ID</div><div className="ac-kpi-v ac-kpi-v--text ac-tabular">{shortId(order.requestId)}</div><div className="ac-meta">주문 {shortId(order.orderId)}</div></Card>
        </div>
        <p className="ac-alert ac-alert--soft" role="note">{note}</p>
    </div>;
}

export function OrderDetailView({ requestId, order, onSummary }: {
    requestId: string | null;
    order: AdminOrderRow | null;
    onSummary: (summary: OrderAuditSummary | null) => void;
}) {
    const [summary, setSummary] = useState<OrderAuditSummary | null>(null);
    const [customer, setCustomer] = useState<OrderCustomer | undefined>(order ? orderCustomerOf(order) : undefined);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(Boolean(requestId) && order?.bundle !== null);
    const [selected, setSelected] = useState<string | null>(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        if (!requestId || order?.bundle === null) return;
        const controller = new AbortController();
        const params = new URLSearchParams({ section: 'summary', pageSize: String(PAGE_SIZE) });
        requestJson(`/api/admin/order-audit/${encodeURIComponent(requestId)}?${params.toString()}`, orderAuditLoadPayloadSchema, { signal: controller.signal })
            .then(payload => {
                if (controller.signal.aborted) return;
                setSummary(payload.summary);
                onSummary(payload.summary);
            })
            .catch(caught => {
                if (controller.signal.aborted) return;
                setSummary(null);
                onSummary(null);
                setError(errorMessage(caught, '주문 번들을 불러오지 못했습니다.'));
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        if (!order) {
            loadOrderCustomers([requestId], controller.signal)
                .then(map => { if (!controller.signal.aborted) setCustomer(map.get(requestId)); })
                .catch(() => { if (!controller.signal.aborted) setCustomer(undefined); });
        }
        return () => controller.abort();
    }, [onSummary, order, reload, requestId]);

    const specs = useMemo(() => (summary ? stageSpecs(summary).map((spec, index) => ({ ...spec, number: index + 1 })) : []), [summary]);
    const divergence = useMemo(() => deriveFirstDivergence(specs.map(spec => ({ key: spec.key, declared: spec.declared, collected: spec.collected }))), [specs]);

    if (order && (order.bundle === null || !requestId)) {
        return <OrderOnlyView order={order} note={order.orderStatus === 'completed'
            ? '이 주문은 영구 감사 번들이 없어 증거 단계별 목록을 볼 수 없습니다. (감사 번들은 2026-09-04 이후 조립된 주문부터 있습니다.)'
            : '분석이 끝나지 않았거나 환불된 주문이라 감사 번들이 없습니다.'} />;
    }
    if (loading && !summary) return <Loading label="주문 번들을 불러오는 중…" />;
    if (error || !summary) return <ErrorNotice message={error ?? '주문 번들을 찾지 못했습니다.'} onRetry={() => { setLoading(true); setError(null); setReload(value => value + 1); }} />;

    const status = orderStatus({ completenessStatus: summary.completeness, costStatus: summary.cost.status, retentionState: summary.retention.state });
    const firstSpec = divergence ? specs.find(spec => spec.key === divergence.key) : undefined;
    const activeKey = selected ?? firstSpec?.key ?? specs[0]?.key;
    const active = specs.find(spec => spec.key === activeKey);
    const slots = summary.providerRuns.filter(run => run.credentialSlot).map(run => `${run.stage}: ${run.credentialSlot}`);

    return <div className="ac-stack">
        <div className="ac-row ac-row--wrap">
            <Chip tone={status.tone}>{status.label}</Chip>
            <span>{status.reason}</span>
            <span className="ac-meta">· 조립 {formatDateTime(summary.assembledAt)} · v{summary.version} · {summary.planId} · {summary.accessMode} · 번들 해시 <span className="ac-tabular">{shortId(summary.bundleHash)}</span></span>
        </div>

        <CustomerFacts customer={customer} planId={summary.planId} />

        <div className="ac-kpis">
            <Card className="ac-kpi"><div className="ac-kpi-l">실측 원가</div><div className="ac-kpi-v">{knownCostLabel(summary.cost.knownUsd, summary.cost.status)}</div><div className="ac-meta">직접 귀속된 알려진 USD</div></Card>
            <Card className="ac-kpi"><div className="ac-kpi-l">보수 추정 상한</div><div className="ac-kpi-v">{formatUsd(summary.cost.conservativeUsd)}</div><div className="ac-meta">확정 원가와 별도 표시</div></Card>
            <Card className="ac-kpi"><div className="ac-kpi-l">원가 귀속</div><div className="ac-kpi-v">{COST_LABEL[summary.cost.status]}</div><div className="ac-meta">{summary.cost.missingSourceCodes?.join(', ') || '누락 소스 없음'}</div></Card>
            <Card className="ac-kpi"><div className="ac-kpi-l">과금 계정</div><div className="ac-kpi-v ac-kpi-v--text">{slots[0]?.split(': ')[1] ?? '미상'}</div><div className="ac-meta">{slots.join(' · ') || 'Apify 슬롯 귀속 없음'}</div></Card>
        </div>

        <div className={`ac-retention ac-retention--${RETENTION_TONE[summary.retention.state]}`}>
            <Chip tone={RETENTION_TONE[summary.retention.state]}>{RETENTION_LABEL[summary.retention.state]}</Chip>
            <span>{summary.retention.state === 'retained' ? '실행 테이블이 정리되어도 이 영구 감사 사본은 남습니다.' : summary.retention.state === 'fenced' ? '퍼지 펜스가 걸려 보관 상태를 확인해야 합니다.' : summary.retention.state === 'pending' ? '조립 큐가 처리 중이며 영구 보관 완료를 기다립니다.' : '큐 상태를 읽을 수 없어 영구 보관을 확정할 수 없습니다.'}</span>
            {summary.retention.purgeFenceReason ? <span className="ac-meta">펜스 이유: {summary.retention.purgeFenceReason}</span> : null}
            <span className="ac-meta ac-push ac-tabular">source_set {shortId(summary.sourceSetHash)}</span>
        </div>

        <Card
            title="증거 파이프라인"
            description="수집 / 선언 비교 · 단계를 누르면 아래에서 행 단위 목록을 확인합니다"
            actions={divergence ? <Chip tone="block">최초 이탈 · STEP {firstSpec?.number}</Chip> : <Chip tone="ok">이탈 없음</Chip>}
        >
            <div className="ac-pipe-box"><div className="ac-pipe">
                {specs.map(spec => {
                    const tone = stageTone(spec);
                    const ratio = spec.declared && spec.collected !== null ? Math.min(1, spec.collected / spec.declared) : null;
                    const delta = spec.declared !== null && spec.collected !== null && spec.declared !== spec.collected
                        ? `${Math.abs(spec.declared - spec.collected).toLocaleString('ko-KR')}건 ${spec.collected < spec.declared ? '부족' : '초과'}` : '';
                    return <button key={spec.key} type="button" className={`ac-stage${spec.key === activeKey ? ' is-sel' : ''}`} aria-pressed={spec.key === activeKey} onClick={() => setSelected(spec.key)}>
                        {divergence?.key === spec.key ? <span className="ac-first">최초 이탈</span> : null}
                        <span className="ac-stage-n">STEP {spec.number}</span>
                        <span className="ac-stage-t">{spec.title}<small>{spec.subtitle}</small></span>
                        <span className="ac-stage-c">{formatCount(spec.collected)} <small>/ {formatCount(spec.declared)}</small></span>
                        <Meter ratio={ratio} tone={tone} />
                        <span className="ac-stage-f"><Chip tone={tone}>{STAGE_LABEL[tone]}</Chip><span className="ac-delta">{delta}</span></span>
                    </button>;
                })}
            </div></div>
            {divergence && firstSpec ? <div className="ac-divergence">
                <b>최초 이탈 — {firstSpec.title}</b>
                <span>{divergence.kind === 'unknown' ? '이 단계의 선언 또는 수집 수가 미상이라 이탈 여부를 확정할 수 없습니다.' : divergence.missing > 0 ? `선언 ${formatCount(firstSpec.declared)}건 중 ${formatCount(firstSpec.collected)}건만 처리되어 ${divergence.missing.toLocaleString('ko-KR')}건이 부족합니다.` : '수집 수가 선언 수를 초과합니다.'}</span>
            </div> : null}
        </Card>

        {active ? <StagePanel key={`${summary.requestId}:${active.key}`} requestId={summary.requestId} spec={active} /> : null}
    </div>;
}
