'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type {
    GenderAuditRow,
    InteractionAuditRow,
    MutualAuditRow,
    OrderAuditLoadPayload,
    OrderAuditSummary,
    RiskAuditRow,
} from '@/lib/services/analysis/order-audit-bundle';
import { orderAuditLoadPayloadSchema } from '@/lib/services/analysis/order-audit-bundle';
import {
    orderAuditListPayloadSchema,
    type OrderAuditListCursor,
    type OrderAuditListRow,
} from '@/lib/services/analysis/order-audit-list';
import {
    accountStatus,
    deriveFirstDivergence,
    displayCostKnownUsd,
    displayCreditUsd,
    displayUsd,
    type ConsoleCountPair,
} from '@/lib/services/analysis/operator-console-model';
import {
    apifyAccountCreditInventorySchema,
    type ApifyAccountCreditInventoryRow,
} from '@/lib/contracts/apify-account-credit-inventory';
import {
    APIFY_CREDENTIAL_SLOTS,
    APIFY_FREE_CREDENTIAL_SLOTS,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_CACHE_POLICY = 'private, no-store';

type DetailSection = Exclude<OrderAuditLoadPayload['section'], 'summary'>;
type GenderPhase = 'initial' | 'final';
type StageTone = 'complete' | 'warning' | 'blocked' | 'unknown';

type StageSpec = {
    key: string;
    title: string;
    subtitle: string;
    section: DetailSection;
    filter: string;
    filters: readonly { value: string; label: string }[];
    declared: number | null;
    collected: number | null;
    mode: 'mutuals' | GenderPhase | 'likes' | 'comments' | 'risk';
};

type RequestTracker = {
    sequence: number;
    controller: AbortController;
};

export const inventoryEnvelopeSchema = z.object({
    inventory: apifyAccountCreditInventorySchema,
}).strict();

const STATUS_LABEL: Record<StageTone, string> = {
    complete: '완전',
    warning: '불완전',
    blocked: '미수집',
    unknown: '미상',
};

const ACCOUNT_STATUS_LABEL: Record<ReturnType<typeof accountStatus>, string> = {
    healthy: '정상',
    warning: '주의',
    blocked: '차단',
    excluded: '배차 제외',
};

const RETENTION_LABEL: Record<OrderAuditSummary['retention']['state'], string> = {
    retained: '영구 보관됨',
    pending: '보관 대기',
    fenced: '보관 차단',
    unknown: '보관 미상',
};

const COST_LABEL: Record<OrderAuditListRow['cost']['status'], string> = {
    complete: '완전',
    partial: '부분',
    unknown: '미상',
    not_available: '원장 없음',
};

function responseError(status: number): Error {
    if (status === 401) return new Error('운영자 세션이 필요합니다.');
    if (status === 403) return new Error('운영자 권한이 없습니다.');
    if (status === 404) return new Error('감사 번들을 찾지 못했습니다.');
    return new Error('운영 데이터를 불러오지 못했습니다.');
}

async function requestJson<T>(
    url: string,
    schema: { parse(value: unknown): T },
    init: RequestInit = {},
): Promise<T> {
    const response = await fetch(url, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            'Cache-Control': PRIVATE_CACHE_POLICY,
            ...init.headers,
        },
    });
    if (!response.ok) throw responseError(response.status);
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new Error('운영 데이터 형식이 올바르지 않습니다.');
    }
    try {
        return schema.parse(body);
    } catch {
        throw new Error('운영 데이터 형식이 올바르지 않습니다.');
    }
}

function timestampLabel(value: string | null | undefined): string {
    if (!value) return '미상';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '미상';
    return new Intl.DateTimeFormat('ko-KR', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
}

function shortHash(value: string | null | undefined): string {
    return value ? `${value.slice(0, 12)}…` : '미상';
}

function countLabel(value: number | null | undefined): string {
    return value === null || value === undefined ? '미상' : value.toLocaleString('ko-KR');
}

function countPairLabel(declared: number | null, collected: number | null): string {
    return `${countLabel(collected)} / ${countLabel(declared)}`;
}

function stageTone(declared: number | null, collected: number | null): StageTone {
    if (declared === null || collected === null) return 'unknown';
    if (declared === 0 && collected === 0) return 'unknown';
    if (declared === collected) return 'complete';
    if (collected === 0) return 'blocked';
    return 'warning';
}

function StatusChip({ tone, children }: { tone: StageTone; children: string }) {
    return <span className={`oc-chip oc-chip--${tone}`}>
        <span className="oc-chip__mark" aria-hidden="true" />
        {children}
    </span>;
}

function RetentionChip({ state }: { state: OrderAuditSummary['retention']['state'] }) {
    const tone: StageTone = state === 'retained' ? 'complete'
        : state === 'fenced' ? 'blocked' : state === 'pending' ? 'warning' : 'unknown';
    return <StatusChip tone={tone}>{RETENTION_LABEL[state]}</StatusChip>;
}

function AccountStatusChip({ row }: { row: ApifyAccountCreditInventoryRow | undefined }) {
    const tone = row ? accountStatus(row) : 'blocked';
    const stageToneValue: StageTone = tone === 'healthy' ? 'complete'
        : tone === 'warning' ? 'warning' : tone === 'blocked' ? 'blocked' : 'unknown';
    return <StatusChip tone={stageToneValue}>{ACCOUNT_STATUS_LABEL[tone]}</StatusChip>;
}

function accountReason(row: ApifyAccountCreditInventoryRow | undefined): string {
    if (!row) return '스냅샷이 없습니다.';
    if (row.manuallyExcluded) return '운영자가 배차에서 제외했습니다.';
    if (row.healthState === 'missing' || row.freshnessState === 'missing') return '잔액 스냅샷을 확인할 수 없습니다.';
    if (row.healthState === 'unhealthy') return '마지막 조회가 실패했습니다.';
    if (row.freshnessState === 'stale') return '오래된 스냅샷이라 현재 잔액을 확정하지 않습니다.';
    if (row.effectiveRemainingUsd === null || row.effectiveRemainingUsd <= 0) return '현재 잔액이 없습니다.';
    return '현재 스냅샷을 신뢰할 수 있습니다.';
}

function freshnessLabel(row: ApifyAccountCreditInventoryRow | undefined): string {
    if (!row || row.freshnessState === 'missing') return '미상';
    return row.freshnessState === 'fresh' ? '최신' : '오래됨';
}

function healthLabel(row: ApifyAccountCreditInventoryRow | undefined): string {
    if (!row || row.healthState === 'missing') return '미상';
    return row.healthState === 'healthy' ? '정상' : '실패';
}

function snapshotUsd(row: ApifyAccountCreditInventoryRow | undefined, value: number | null): string {
    if (!row || row.freshnessState !== 'fresh') return '미상';
    return value === null ? '미상' : displayUsd(value);
}

function Meter({ row }: { row: ApifyAccountCreditInventoryRow | undefined }) {
    const known = Boolean(row && row.freshnessState === 'fresh' && row.effectiveRemainingUsd !== null && row.monthlyLimitUsd !== null && row.monthlyLimitUsd > 0);
    const width = known && row ? Math.max(0, Math.min(100, (row.effectiveRemainingUsd! / row.monthlyLimitUsd!) * 100)) : 0;
    return <span className={`oc-meter${known ? '' : ' oc-meter--unknown'}`} aria-hidden="true"><span style={{ width: `${width}%` }} /></span>;
}

function PageError({ message }: { message: string | null }) {
    return message ? <p className="oc-alert oc-alert--error" role="alert">{message}</p> : null;
}

function AccountTable({
    rows,
    busySlot,
    onToggle,
}: {
    rows: readonly (ApifyAccountCreditInventoryRow | undefined)[];
    busySlot: ApifyCredentialSlot | null;
    onToggle: (row: ApifyAccountCreditInventoryRow) => void;
}) {
    return <div className="oc-table-scroll">
        <table className="oc-table">
            <caption className="oc-sr-only">무료 Apify 계정 9개 상태</caption>
            <thead><tr>
                <th scope="col">계정</th><th scope="col">잔여 USD</th><th scope="col">잔액 게이지</th>
                <th scope="col">이번 주기 사용</th><th scope="col">초기화</th><th scope="col">최근 관측</th>
                <th scope="col">신선도</th><th scope="col">건강</th><th scope="col">상태</th><th scope="col">비고</th><th scope="col"><span className="oc-sr-only">배차 제어</span></th>
            </tr></thead>
            <tbody>{rows.map((row, index) => {
                const slot = APIFY_FREE_CREDENTIAL_SLOTS[index];
                const key = row?.credentialSlot ?? slot;
                return <tr key={key} className={row && accountStatus(row) !== 'healthy' ? 'oc-row--flagged' : undefined}>
                    <th scope="row" className="oc-mono">{key}</th>
                    <td className="oc-number">{displayCreditUsd({ freshnessState: row?.freshnessState ?? 'missing', effectiveRemainingUsd: row?.effectiveRemainingUsd ?? null })}</td>
                    <td><Meter row={row} /></td>
                    <td className="oc-number">{snapshotUsd(row, row?.monthlyUsageUsd ?? null)}</td>
                    <td>{row?.freshnessState === 'fresh' ? timestampLabel(row.cycleResetAt) : '미상'}</td>
                    <td>{row?.freshnessState === 'fresh' ? timestampLabel(row.observedAt) : '미상'}</td>
                    <td>{freshnessLabel(row)}</td>
                    <td>{healthLabel(row)}</td>
                    <td><AccountStatusChip row={row} /></td>
                    <td className="oc-muted">{accountReason(row)}</td>
                    <td>{row ? <button type="button" className="oc-button oc-button--small" aria-label={`${key} ${row.manuallyExcluded ? '배차 복귀' : '배차 제외'}`} disabled={busySlot === row.credentialSlot} onClick={() => onToggle(row)}>{busySlot === row.credentialSlot ? '저장 중…' : row.manuallyExcluded ? '배차 복귀' : '배차 제외'}</button> : null}</td>
                </tr>;
            })}</tbody>
        </table>
    </div>;
}

function PaidAccount({ row, busy, onRefresh }: { row: ApifyAccountCreditInventoryRow | undefined; busy: boolean; onRefresh: () => void }) {
    return <div className="oc-paid-card">
        <div>
            <div className="oc-inline-head"><h3>secondary</h3><span className="oc-role">유료 · 배차 우선순위 1</span><AccountStatusChip row={row} /></div>
            <div className="oc-paid-balance"><span>{displayCreditUsd({ freshnessState: row?.freshnessState ?? 'missing', effectiveRemainingUsd: row?.effectiveRemainingUsd ?? null })}</span><small>남음 / 한도 {snapshotUsd(row, row?.monthlyLimitUsd ?? null)}</small></div>
            <Meter row={row} />
            <div className="oc-paid-facts"><span>이번 주기 사용 <b>{snapshotUsd(row, row?.monthlyUsageUsd ?? null)}</b></span><span>초기화 <b>{row?.freshnessState === 'fresh' ? timestampLabel(row.cycleResetAt) : '미상'}</b></span><span>관측 <b>{row?.freshnessState === 'fresh' ? timestampLabel(row.observedAt) : '미상'}</b></span><span>신선도 <b>{freshnessLabel(row)}</b></span><span>건강 <b>{healthLabel(row)}</b></span></div>
        </div>
        <div className="oc-paid-action"><button type="button" className="oc-button" disabled={busy} onClick={onRefresh}>{busy ? '조회 중…' : '지금 잔액 새로고침'}</button><p className="oc-muted">secondary만 유료 Apify 새로고침을 실행합니다.</p></div>
    </div>;
}

function OrderStatus({ status }: { status: OrderAuditListRow['completenessStatus'] }) {
    const tone: StageTone = status === 'complete' ? 'complete' : status === 'inconsistent' || status === 'failed' ? 'blocked' : 'warning';
    const label = status === 'complete' ? '완전' : status === 'partial' ? '부분' : status === 'inconsistent' ? '불일치' : '실패';
    return <StatusChip tone={tone}>{label}</StatusChip>;
}

function CostStatus({ status }: { status: OrderAuditListRow['cost']['status'] }) {
    const tone: StageTone = status === 'complete' ? 'complete' : status === 'partial' ? 'warning' : status === 'unknown' ? 'blocked' : 'unknown';
    return <StatusChip tone={tone}>{COST_LABEL[status]}</StatusChip>;
}

function AttentionList({ accounts, orders, onOpenOrder }: { accounts: readonly (ApifyAccountCreditInventoryRow | undefined)[]; orders: readonly OrderAuditListRow[]; onOpenOrder: (requestId: string) => void }) {
    const items = useMemo(() => {
        const accountItems = accounts.filter(row => row && accountStatus(row) !== 'healthy').map(row => ({ key: `account:${row!.credentialSlot}`, tone: accountStatus(row!) === 'blocked' ? 'blocked' as const : 'warning' as const, label: `${row!.credentialSlot} 계정`, detail: accountReason(row), requestId: null }));
        const orderItems = orders.filter(row => row.completenessStatus !== 'complete' || row.cost.status !== 'complete').map(row => ({ key: `order:${row.requestId}`, tone: row.completenessStatus === 'inconsistent' || row.completenessStatus === 'failed' ? 'blocked' as const : 'warning' as const, label: `주문 @${row.targetInstagramId ?? '대상 미상'}`, detail: row.gapCodes.length > 0 ? row.gapCodes.join(', ') : `원가 ${COST_LABEL[row.cost.status]}`, requestId: row.requestId }));
        return [...accountItems, ...orderItems];
    }, [accounts, orders]);
    return <section className={`oc-attention${items.length === 0 ? ' oc-attention--clear' : ''}`} aria-labelledby="attention-title">
        <div className="oc-section-heading"><div><h2 id="attention-title">확인 필요</h2><p>현재 화면에 로드된 데이터에서만 표시합니다. 전체 건수로 해석하지 않습니다.</p></div><span className="oc-section-meta">{items.length}건</span></div>
        {items.length === 0 ? <p className="oc-empty">현재 페이지에서 확인이 필요한 항목이 없습니다.</p> : <ul className="oc-attention-list">{items.map(item => <li key={item.key}><StatusChip tone={item.tone}>{item.tone === 'blocked' ? '차단' : '주의'}</StatusChip><span className="oc-attention-label">{item.label}</span><span className="oc-muted">{item.detail}</span>{item.requestId ? <button type="button" className="oc-link" onClick={() => onOpenOrder(item.requestId!)}>주문 열기</button> : null}</li>)}</ul>}
    </section>;
}

function OrdersTable({ rows, loading, nextCursor, error, onOpen, onNext }: { rows: readonly OrderAuditListRow[]; loading: boolean; nextCursor: OrderAuditListCursor | null; error: string | null; onOpen: (requestId: string) => void; onNext: () => void }) {
    return <section className="oc-section" aria-labelledby="orders-title">
        <div className="oc-section-heading"><div><h2 id="orders-title">주문</h2><p>영구 감사 번들의 최신 버전 · 키셋 페이지</p></div><span className="oc-section-meta">{rows.length}건 표시</span></div>
        <PageError message={error} />
        <div className="oc-table-scroll"><table className="oc-table oc-order-table"><caption className="oc-sr-only">주문 감사 번들 목록</caption><thead><tr>
            <th scope="col">요청</th><th scope="col">대상</th><th scope="col">요금제</th><th scope="col">실측 원가</th><th scope="col">보수 추정</th><th scope="col">원가 귀속</th><th scope="col">증거 완전성</th><th scope="col">결함</th><th scope="col">영구 보관</th><th scope="col">조립 시각</th>
        </tr></thead><tbody>{rows.length === 0 && !loading ? <tr><td colSpan={10} className="oc-empty">표시할 영구 감사 번들이 없습니다.</td></tr> : null}{rows.map(row => <tr key={row.requestId} className={row.completenessStatus !== 'complete' ? 'oc-row--flagged' : undefined}>
            <th scope="row"><button type="button" className="oc-link oc-mono" onClick={() => onOpen(row.requestId)}>{shortHash(row.requestId)}</button></th><td className="oc-target">@{row.targetInstagramId ?? '미상'}</td><td>{row.planId}</td><td className="oc-number">{displayCostKnownUsd(row.cost.knownUsd, row.cost.status)}</td><td className="oc-number oc-muted">{displayUsd(row.cost.conservativeUsd)}</td><td><CostStatus status={row.cost.status} /></td><td><OrderStatus status={row.completenessStatus} /></td><td><span className="oc-gap-list">{row.gapCodes.length > 0 ? row.gapCodes.map(code => <span key={code} className="oc-gap oc-mono">{code}</span>) : <span className="oc-muted">없음</span>}</span></td><td><RetentionChip state={row.retention.state} /></td><td>{timestampLabel(row.assembledAt)}</td>
        </tr>)}</tbody></table></div>
        <div className="oc-pager" aria-live="polite"><span>{rows.length}건을 로드했습니다{nextCursor ? ' · 다음 페이지 있음' : ''}</span><button type="button" className="oc-button oc-button--small" disabled={loading || nextCursor === null} onClick={onNext}>{loading ? '불러오는 중…' : '다음 25건'}</button></div>
    </section>;
}

export function stageSpecs(summary: OrderAuditSummary): StageSpec[] {
    return [
        { key: 'mutuals', title: '맞팔 계정', subtitle: '팔로워 ∩ 팔로잉', section: 'mutuals', mode: 'mutuals', filter: 'all', filters: [{ value: 'all', label: '전체' }, { value: 'public', label: '공개' }, { value: 'private', label: '비공개' }], declared: summary.mutuals.declared, collected: summary.mutuals.collected },
        { key: 'gender-initial', title: '1차 성별 판정', subtitle: '저비용 트리아지', section: 'gender', mode: 'initial', filter: 'all', filters: [{ value: 'all', label: '전체' }, { value: 'public', label: '공개' }, { value: 'private', label: '비공개' }], declared: summary.mutuals.screened, collected: summary.gender.initialResolved },
        { key: 'gender-final', title: '최종 성별 판정', subtitle: '모호 건 재판정', section: 'gender', mode: 'final', filter: 'all', filters: [{ value: 'all', label: '전체' }, { value: 'public', label: '공개' }, { value: 'private', label: '비공개' }], declared: summary.mutuals.screened, collected: summary.gender.finalResolved },
        { key: 'target-likes', title: '대상 게시물 좋아요', subtitle: '맞팔이 대상 글에 누른 좋아요', section: 'interactions', mode: 'likes', filter: 'likes', filters: [{ value: 'likes', label: '좋아요만' }], declared: summary.interactions.targetLikes.declared, collected: summary.interactions.targetLikes.collected },
        { key: 'target-comments', title: '대상 게시물 댓글', subtitle: '맞팔이 대상 글에 단 댓글', section: 'interactions', mode: 'comments', filter: 'comments', filters: [{ value: 'comments', label: '댓글만' }], declared: summary.interactions.targetComments.declared, collected: summary.interactions.targetComments.collected },
        { key: 'risk', title: '공개 여성 위험 산출', subtitle: '공개 여성 후보별 계산 원장', section: 'risk', mode: 'risk', filter: 'public_female', filters: [{ value: 'public_female', label: '공개 여성' }], declared: summary.risk.declared, collected: summary.risk.collected },
    ];
}

function renderMutualRows(rows: readonly MutualAuditRow[]) {
    return <table className="oc-table oc-detail-table"><caption className="oc-sr-only">맞팔 계정 목록</caption><thead><tr><th scope="col">#</th><th scope="col">계정</th><th scope="col">공개 여부</th><th scope="col">프로필</th><th scope="col">최종 상태</th><th scope="col">행 상태</th></tr></thead><tbody>{rows.map(row => <tr key={row.candidateId} className={row.completeness === 'partial' ? 'oc-row--flagged' : undefined}><td className="oc-number">{countLabel(row.mutualOrdinal)}</td><th scope="row">@{row.username}{row.isVerified ? <span className="oc-muted"> · 인증</span> : null}</th><td>{row.isPrivate ? '비공개' : '공개'}</td><td>{row.profileAvailable ? '수집됨' : <span className="oc-gap">{row.profileFailureCode ?? '미수집'}</span>}</td><td>{row.finalInclusionState}</td><td><StatusChip tone={row.completeness === 'complete' ? 'complete' : 'warning'}>{row.completeness === 'complete' ? '완전' : '부분'}</StatusChip></td></tr>)}</tbody></table>;
}

const GENDER_LABEL: Record<NonNullable<GenderAuditRow['initial']['output']>, string> = { female: '여성', male: '남성', unknown: '불명', unavailable: '조회 불가' };

function renderGenderRows(rows: readonly GenderAuditRow[], phase: GenderPhase) {
    return <table className="oc-table oc-detail-table"><caption className="oc-sr-only">{phase === 'initial' ? '1차' : '최종'} 성별 판정 목록</caption><thead><tr><th scope="col">계정</th><th scope="col">공개 여부</th><th scope="col">판정</th><th scope="col">확신도</th><th scope="col">모델</th><th scope="col">근거</th><th scope="col">결과 해시</th></tr></thead><tbody>{rows.map(row => { const result = row[phase]; const tone: StageTone = result.output === null ? 'blocked' : result.output === 'female' ? 'complete' : 'unknown'; return <tr key={`${row.candidateId}:${phase}`} className={result.output === null ? 'oc-row--flagged' : undefined}><th scope="row">@{row.username}</th><td>{row.isPrivate ? '비공개' : '공개'}</td><td><StatusChip tone={tone}>{result.output === null ? '판정 없음' : GENDER_LABEL[result.output]}</StatusChip></td><td>{result.confidence ?? '미상'}</td><td className="oc-mono">{result.model ?? '미상'}</td><td className="oc-muted">{result.reason ?? '근거 미상'}</td><td className="oc-mono">{shortHash(result.resultHash)}</td></tr>; })}</tbody></table>;
}

function renderInteractionRows(rows: readonly InteractionAuditRow[], mode: 'likes' | 'comments') {
    return <table className="oc-table oc-detail-table"><caption className="oc-sr-only">{mode === 'likes' ? '대상 게시물 좋아요' : '대상 게시물 댓글'} 목록</caption><thead><tr><th scope="col">#</th><th scope="col">계정</th><th scope="col">{mode === 'likes' ? '게시물' : '댓글'}</th><th scope="col">발생 시각</th><th scope="col">증거 ID</th><th scope="col">상태</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.ordinal}:${row.evidenceId}`} className={row.completeness !== 'complete' ? 'oc-row--flagged' : undefined}><td className="oc-number">{row.ordinal}</td><th scope="row">@{row.username ?? '미상'}</th><td className={mode === 'comments' ? 'oc-comment' : 'oc-mono'}>{mode === 'comments' ? row.commentText ?? '댓글 내용 미상' : row.sourcePostId ?? '게시물 ID 미상'}</td><td>{timestampLabel(row.occurredAt)}</td><td className="oc-mono">{row.evidenceId}</td><td>{row.gapCodes.length > 0 ? <span className="oc-gap oc-mono">{row.gapCodes[0]}</span> : <StatusChip tone={row.completeness === 'complete' ? 'complete' : 'warning'}>{row.completeness === 'complete' ? '완전' : '부분'}</StatusChip>}</td></tr>)}</tbody></table>;
}

const COMPONENT_LABEL: Record<string, string> = { candidateToTargetLikes: '상대 → 대상 좋아요', candidateToTargetComments: '상대 → 대상 댓글', candidateToTargetTagOrCaptionMention: '상대 → 대상 태그·멘션', targetToCandidateTagOrCaptionMention: '대상 → 상대 태그·멘션', targetToCandidateLike: '대상 → 상대 좋아요', recentMutual: '최근 맞팔 가산', appearanceExposure: '공개 프로필 특성', weakPartnerAdjustment: '관계 안전 조정' };

function ledgerValue(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(1);
    if (typeof value === 'string' && value.length <= 120) return value;
    return '미상';
}

function RiskLedger({ row, retention }: { row: RiskAuditRow; retention: OrderAuditSummary['retention'] }) {
    const [open, setOpen] = useState(false);
    const panelId = `risk-ledger-${row.candidateId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    return <>
        <tr className={row.completeness === 'partial' ? 'oc-row--flagged' : undefined}><td className="oc-number">{countLabel(row.finalRank)}</td><th scope="row">@{row.username}</th><td className="oc-number oc-score">{row.finalScore === null ? '미상' : row.finalScore.toFixed(1)}</td><td>{row.riskBand ?? '미상'}</td><td className="oc-number oc-muted">{row.rawScore === null ? '미상' : row.rawScore.toFixed(1)}</td><td className="oc-number oc-muted">{row.publicScore === null ? '미상' : row.publicScore.toFixed(1)}</td><td className="oc-number oc-muted">{countLabel(row.recentMutualRank)}</td><td><RetentionChip state={retention.state} /></td><td><button type="button" className="oc-link" aria-expanded={open} aria-controls={panelId} aria-label={`@${row.username} ${open ? '산식 닫기' : '산식 보기'}`} onClick={() => setOpen(value => !value)}>{open ? '산식 닫기' : '산식 보기'}</button></td></tr>
        {open ? <tr id={panelId} className="oc-ledger-row"><td colSpan={9}><div className="oc-ledger-grid"><div><h4>기여도 원장 · {row.riskFormulaVersion ?? '버전 미상'}</h4><dl className="oc-ledger">{Object.entries(row.riskComponents ?? {}).map(([key, value]) => <div key={key}><dt>{COMPONENT_LABEL[key] ?? key}</dt><dd>{ledgerValue(value)}</dd></div>)}<div className="oc-ledger-total"><dt>합계 · 원점수</dt><dd>{ledgerValue(row.rawScore)}</dd></div></dl></div><div><h4>점수 전이 · 영구 보관</h4><dl className="oc-ledger"><div><dt>사전 점수</dt><dd>{ledgerValue(row.preScore)}</dd></div><div><dt>원점수</dt><dd>{ledgerValue(row.rawScore)}</dd></div><div><dt>공개 점수</dt><dd>{ledgerValue(row.publicScore)}</dd></div><div><dt>최종 점수</dt><dd>{ledgerValue(row.finalScore)}</dd></div><div><dt>노출 순위</dt><dd>{ledgerValue(row.featuredRank)}</dd></div><div><dt>관계 안전 해시</dt><dd className="oc-mono">{shortHash(row.partnerSafety.resultHash)}</dd></div><div><dt>번들 보관 상태</dt><dd>{RETENTION_LABEL[retention.state]}</dd></div></dl></div></div><p className="oc-muted">후보별 보관 필드는 없으므로 주문 단위 영구 감사 상태를 표시합니다.</p></td></tr> : null}
    </>;
}

function renderRiskRows(rows: readonly RiskAuditRow[], retention: OrderAuditSummary['retention']) {
    return <table className="oc-table oc-detail-table"><caption className="oc-sr-only">공개 여성 후보별 위험 계산 원장</caption><thead><tr><th scope="col">순위</th><th scope="col">계정</th><th scope="col">최종 점수</th><th scope="col">등급</th><th scope="col">원점수</th><th scope="col">공개 점수</th><th scope="col">최근 맞팔</th><th scope="col">보관</th><th scope="col">산식</th></tr></thead><tbody>{rows.map(row => <RiskLedger key={row.candidateId} row={row} retention={retention} />)}</tbody></table>;
}

function rowsForMode(payload: OrderAuditLoadPayload, mode: StageSpec['mode']): ReactNode {
    if (mode === 'mutuals' && payload.section === 'mutuals') return renderMutualRows(payload.rows);
    if ((mode === 'initial' || mode === 'final') && payload.section === 'gender') return renderGenderRows(payload.rows, mode);
    if ((mode === 'likes' || mode === 'comments') && payload.section === 'interactions') return renderInteractionRows(payload.rows, mode);
    if (mode === 'risk' && payload.section === 'risk') return renderRiskRows(payload.rows, payload.summary.retention);
    return <p className="oc-empty">이 구간의 데이터를 찾지 못했습니다.</p>;
}

function EvidenceStage({ requestId, spec, firstDivergence }: { requestId: string; spec: StageSpec; firstDivergence: ReturnType<typeof deriveFirstDivergence> }) {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState(spec.filter);
    const [cursor, setCursor] = useState(0);
    const [payload, setPayload] = useState<OrderAuditLoadPayload | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const tone = stageTone(spec.declared, spec.collected);
    const panelId = `evidence-${requestId}-${spec.key}`;
    const firstHere = firstDivergence?.key === spec.key;

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        controllerRef.current?.abort();
        controllerRef.current = controller;
        const params = new URLSearchParams({ section: spec.section, cursor: String(cursor), pageSize: String(PAGE_SIZE), filter });
        void requestJson(`/api/admin/order-audit/${encodeURIComponent(requestId)}?${params.toString()}`, orderAuditLoadPayloadSchema, { signal: controller.signal }).then(nextPayload => {
            if (controller.signal.aborted || controllerRef.current !== controller) return;
            if (nextPayload.section !== spec.section) throw new Error('운영 데이터 구간이 일치하지 않습니다.');
            setPayload(nextPayload); setError(null);
        }).catch(caught => {
            if (controller.signal.aborted || controllerRef.current !== controller) return;
            setPayload(null); setError(caught instanceof Error ? caught.message : '운영 데이터를 불러오지 못했습니다.');
        }).finally(() => {
            if (controllerRef.current === controller) { controllerRef.current = null; setLoading(false); }
        });
        return () => controller.abort();
    }, [cursor, filter, open, requestId, spec.section]);

    const toggleOpen = () => {
        const nextOpen = !open;
        setOpen(nextOpen);
        setPayload(null);
        setError(null);
        setCursor(0);
        setLoading(nextOpen);
    };
    const changeFilter = (value: string) => {
        if (value === filter) return;
        setFilter(value);
        setCursor(0);
        setPayload(null);
        setError(null);
        setLoading(true);
    };
    const changeCursor = (value: number) => {
        if (value === cursor) return;
        setCursor(value);
        setPayload(null);
        setError(null);
        setLoading(true);
    };

    return <article className={`oc-stage${tone === 'warning' || tone === 'blocked' ? ' oc-stage--flagged' : ''}`}>
        {firstHere ? <div className="oc-first-divergence" role="note"><strong>최초 이탈</strong>{firstDivergence.kind === 'unknown' ? ' 이 단계의 선언 또는 수집 수가 미상이라 최초 이탈을 확정할 수 없습니다.' : ` 여기서 처음으로 수집 수가 선언 수와 어긋납니다. ${firstDivergence.missing > 0 ? `${firstDivergence.missing}건이 부족합니다.` : '수집 수가 선언 수를 초과합니다.'}`}</div> : null}
        <button type="button" className="oc-stage-header" aria-expanded={open} aria-controls={panelId} onClick={toggleOpen}><span className="oc-stage-number">{spec.key === 'mutuals' ? 1 : spec.key === 'gender-initial' ? 2 : spec.key === 'gender-final' ? 3 : spec.key === 'target-likes' ? 4 : spec.key === 'target-comments' ? 5 : 6}</span><span className="oc-stage-name"><b>{spec.title}</b><small>{spec.subtitle}</small></span><span className="oc-stage-count">{countPairLabel(spec.declared, spec.collected)}</span><span className="oc-stage-delta">{spec.declared !== null && spec.collected !== null && spec.declared !== spec.collected ? `${Math.abs(spec.declared - spec.collected)}건 차이` : ''}</span><StatusChip tone={tone}>{STATUS_LABEL[tone]}</StatusChip><span className="oc-stage-open">{open ? '목록 닫기' : '목록 보기'}</span></button>
        {open ? <div id={panelId} className="oc-stage-panel"><div className="oc-stage-tools"><span className="oc-muted">필터</span>{spec.filters.map(option => <button key={option.value} type="button" className="oc-button oc-button--small" aria-pressed={filter === option.value} onClick={() => changeFilter(option.value)}>{option.label}</button>)}<span className="oc-stage-contract">section={spec.section} · filter={filter} · pageSize={PAGE_SIZE}</span></div><PageError message={error} />{loading && !payload ? <p className="oc-loading" role="status">목록을 불러오는 중…</p> : payload ? <div className="oc-table-scroll">{payload.rows.length > 0 ? rowsForMode(payload, spec.mode) : <p className="oc-empty">저장된 행이 없습니다.</p>}</div> : null}{payload ? <div className="oc-pager"><span>{payload.total.toLocaleString('ko-KR')}건 중 {Math.min(cursor + payload.rows.length, payload.total).toLocaleString('ko-KR')}건 표시</span><div className="oc-button-row"><button type="button" className="oc-button oc-button--small" disabled={loading || cursor === 0} onClick={() => changeCursor(Math.max(0, cursor - PAGE_SIZE))}>이전 25건</button><button type="button" className="oc-button oc-button--small" disabled={loading || payload.nextCursor === null} onClick={() => changeCursor(payload.nextCursor ?? cursor)}>다음 25건</button></div></div> : null}</div> : null}
    </article>;
}

function OrderDetail({ requestId, onBack }: { requestId: string; onBack: () => void }) {
    const [summary, setSummary] = useState<OrderAuditSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams({ section: 'summary', pageSize: String(PAGE_SIZE) });
        void requestJson(`/api/admin/order-audit/${encodeURIComponent(requestId)}?${params.toString()}`, orderAuditLoadPayloadSchema, { signal: controller.signal }).then(payload => { if (!controller.signal.aborted) setSummary(payload.summary); }).catch(caught => { if (!controller.signal.aborted) { setSummary(null); setError(caught instanceof Error ? caught.message : '운영 데이터를 불러오지 못했습니다.'); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [requestId]);
    if (loading) return <section className="oc-detail"><button type="button" className="oc-link" onClick={onBack}>← 주문 목록</button><p className="oc-loading" role="status">주문 번들을 불러오는 중…</p></section>;
    if (error || !summary) return <section className="oc-detail"><button type="button" className="oc-link" onClick={onBack}>← 주문 목록</button><PageError message={error ?? '주문 번들을 찾지 못했습니다.'} /></section>;
    const specs = stageSpecs(summary);
    const countPairs: ConsoleCountPair[] = specs.map(spec => ({ key: spec.key, declared: spec.declared, collected: spec.collected }));
    const firstDivergence = deriveFirstDivergence(countPairs);
    const attributedSlots = summary.providerRuns.filter(run => run.credentialSlot).map(run => `${run.stage}: ${run.credentialSlot}`);
    return <section className="oc-detail" aria-labelledby="detail-title"><div className="oc-breadcrumb"><button type="button" className="oc-link" onClick={onBack}>← 주문 목록</button><span className="oc-mono">{requestId} · v{summary.version}</span></div><div className="oc-detail-head"><div><p className="oc-kicker">주문 감사 번들</p><h2 id="detail-title">@{summary.targetInstagramId ?? '대상 미상'}</h2><p className="oc-muted">조립 {timestampLabel(summary.assembledAt)} · 번들 해시 <span className="oc-mono">{shortHash(summary.bundleHash)}</span></p></div><div className="oc-detail-status"><OrderStatus status={summary.completeness} /><span className="oc-muted">{summary.planId} · {summary.accessMode}</span></div></div><div className="oc-facts" aria-label="주문 요약"><div><span>실측 원가</span><strong>{displayCostKnownUsd(summary.cost.knownUsd, summary.cost.status)}</strong><small>{summary.cost.knownUsd === null ? summary.cost.status === 'not_available' ? '원가 원장 없음' : '사용량 미상으로 미확정' : '직접 귀속된 알려진 USD'}</small></div><div><span>보수 추정 상한</span><strong>{displayUsd(summary.cost.conservativeUsd)}</strong><small>확정 원가와 별도로 표시</small></div><div><span>원가 귀속</span><strong>{COST_LABEL[summary.cost.status]}</strong><small>{summary.cost.missingSourceCodes?.join(', ') || '누락 소스 없음'}</small></div><div><span>과금 계정</span><strong>{attributedSlots.length > 0 ? attributedSlots[0]!.split(': ')[1] : '미상'}</strong><small>{attributedSlots.length > 0 ? attributedSlots.join(' · ') : 'Apify 슬롯 귀속 없음'}</small></div></div><div className="oc-retention-banner"><RetentionChip state={summary.retention.state} /><span>{summary.retention.state === 'retained' ? '실행 테이블이 정리되어도 이 영구 감사 사본은 남습니다.' : summary.retention.state === 'fenced' ? '퍼지 펜스가 걸려 보관 상태를 확인해야 합니다.' : summary.retention.state === 'pending' ? '조립 큐가 처리 중이며 영구 보관 완료를 기다립니다.' : '큐 상태를 읽을 수 없어 영구 보관을 확정할 수 없습니다.'}</span>{summary.retention.purgeFenceReason ? <span className="oc-muted">펜스 이유: {summary.retention.purgeFenceReason}</span> : null}<span className="oc-mono oc-retention-meta">source_set {shortHash(summary.sourceSetHash)}{summary.retention.purgeFencedAt ? ` · 펜스 ${timestampLabel(summary.retention.purgeFencedAt)}` : ''}</span></div><section className="oc-section oc-evidence" aria-labelledby="evidence-title"><div className="oc-section-heading"><div><h3 id="evidence-title">증거 단계</h3><p>파이프라인 순서 · 모든 단계에서 선언 / 수집을 함께 비교합니다.</p></div><span className="oc-section-meta">최초 이탈 {firstDivergence ? firstDivergence.kind === 'unknown' ? '확인 불가' : firstDivergence.key : '없음'}</span></div><div className="oc-stage-rail">{specs.map(spec => <EvidenceStage key={spec.key} requestId={requestId} spec={spec} firstDivergence={firstDivergence} />)}</div></section></section>;
}

export function AnalysisAuditWorkbench({ initialRequestId }: { initialRequestId: string }) {
    const [inventory, setInventory] = useState<readonly ApifyAccountCreditInventoryRow[] | null>(null);
    const [orders, setOrders] = useState<readonly OrderAuditListRow[]>([]);
    const [nextCursor, setNextCursor] = useState<OrderAuditListCursor | null>(null);
    const [inventoryLoading, setInventoryLoading] = useState(true);
    const [ordersLoading, setOrdersLoading] = useState(true);
    const [inventoryError, setInventoryError] = useState<string | null>(null);
    const [ordersError, setOrdersError] = useState<string | null>(null);
    const [selectedRequestId, setSelectedRequestId] = useState<string | null>(UUID.test(initialRequestId) ? initialRequestId : null);
    const [paidBusy, setPaidBusy] = useState(false);
    const [busySlot, setBusySlot] = useState<ApifyCredentialSlot | null>(null);
    const activeRequest = useRef<RequestTracker | null>(null);

    const loadInventory = useCallback(async () => {
        setInventoryLoading(true); setInventoryError(null);
        try { const body = await requestJson('/api/admin/apify-accounts', inventoryEnvelopeSchema); setInventory(body.inventory); } catch (caught) { setInventory(null); setInventoryError(caught instanceof Error ? caught.message : '계정 상태를 불러오지 못했습니다.'); } finally { setInventoryLoading(false); }
    }, []);

    const loadOrdersPage = useCallback(async (cursor: OrderAuditListCursor | null, append: boolean) => {
        const sequence = (activeRequest.current?.sequence ?? 0) + 1;
        activeRequest.current?.controller.abort();
        const controller = new AbortController();
        activeRequest.current = { sequence, controller };
        setOrdersLoading(true); setOrdersError(null);
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (cursor) { params.set('cursorAssembledAt', cursor.assembledAt); params.set('cursorRequestId', cursor.requestId); }
        try {
            const payload = await requestJson(`/api/admin/order-audit?${params.toString()}`, orderAuditListPayloadSchema, { signal: controller.signal });
            if (controller.signal.aborted || activeRequest.current?.sequence !== sequence) return;
            setOrders(previous => append ? [...previous, ...payload.rows] : payload.rows); setNextCursor(payload.nextCursor);
        } catch (caught) {
            if (controller.signal.aborted || activeRequest.current?.sequence !== sequence) return;
            if (!append) setOrders([]); setOrdersError(caught instanceof Error ? caught.message : '주문 목록을 불러오지 못했습니다.');
        } finally {
            if (activeRequest.current?.sequence === sequence) { activeRequest.current = null; setOrdersLoading(false); }
        }
    }, []);

    useEffect(() => { void loadInventory(); void loadOrdersPage(null, false); }, [loadInventory, loadOrdersPage]);

    const orderedInventory = useMemo(() => APIFY_CREDENTIAL_SLOTS.map(slot => inventory?.find(row => row.credentialSlot === slot)), [inventory]);
    const paid = orderedInventory[1];
    const free = APIFY_FREE_CREDENTIAL_SLOTS.map(slot => inventory?.find(row => row.credentialSlot === slot));

    const toggleExclusion = useCallback(async (row: ApifyAccountCreditInventoryRow) => {
        setBusySlot(row.credentialSlot); setInventoryError(null);
        try { const body = await requestJson('/api/admin/apify-accounts', inventoryEnvelopeSchema, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialSlot: row.credentialSlot, excluded: !row.manuallyExcluded }) }); setInventory(body.inventory); } catch (caught) { setInventoryError(caught instanceof Error ? caught.message : '배차 상태를 저장하지 못했습니다.'); } finally { setBusySlot(null); }
    }, []);

    const refreshPaid = useCallback(async () => {
        setPaidBusy(true); setInventoryError(null);
        try { const body = await requestJson('/api/admin/apify-accounts', inventoryEnvelopeSchema, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'refresh-paid-secondary' }) }); setInventory(body.inventory); } catch (caught) { setInventoryError(caught instanceof Error ? caught.message : '유료 계정 잔액을 새로고침하지 못했습니다.'); } finally { setPaidBusy(false); }
    }, []);

    if (selectedRequestId) return <OrderDetail requestId={selectedRequestId} onBack={() => setSelectedRequestId(null)} />;

    return <div className="oc-console-content"><header className="oc-masthead"><div><p className="oc-kicker">운영자 전용 · production data</p><h1>판독 운영 콘솔</h1><p>Apify 계정 상태와 영구 감사 번들을 한 표면에서 확인합니다.</p></div><div className="oc-session-note"><span className="oc-session-dot" aria-hidden="true" />operator session<br /><b>private / no-store</b></div></header><p className="oc-contract-note">현재 운영 API 응답만 표시합니다. 잔액·원가·보관 상태를 확인할 수 없으면 숫자를 만들지 않고 <b>미상</b>으로 남깁니다.</p><PageError message={inventoryError} /><section className="oc-section oc-section--top" aria-labelledby="attention-title"><AttentionList accounts={orderedInventory} orders={orders} onOpenOrder={setSelectedRequestId} /></section><section className="oc-section" aria-labelledby="paid-title"><div className="oc-section-heading"><div><h2 id="paid-title">유료 계정</h2><p>secondary 1개 · 실제 과금이 발생하는 유일한 Apify 슬롯</p></div><span className="oc-section-meta">1 / 10</span></div>{inventoryLoading && !inventory ? <p className="oc-loading" role="status">계정 상태를 불러오는 중…</p> : <PaidAccount row={paid} busy={paidBusy} onRefresh={() => void refreshPaid()} />}</section><section className="oc-section" aria-labelledby="free-title"><div className="oc-section-heading"><div><h2 id="free-title">무료 계정 9개</h2><p>secondary를 제외한 모든 canonical 슬롯 · 수동 배차 제외 / 복귀</p></div><span className="oc-section-meta">9 / 10</span></div>{inventoryLoading && !inventory ? <p className="oc-loading" role="status">계정 상태를 불러오는 중…</p> : <AccountTable rows={free} busySlot={busySlot} onToggle={row => void toggleExclusion(row)} />}</section><OrdersTable rows={orders} loading={ordersLoading} nextCursor={nextCursor} error={ordersError} onOpen={setSelectedRequestId} onNext={() => { if (nextCursor) void loadOrdersPage(nextCursor, true); }} /><footer className="oc-footer">영구 보관 상태는 주문 감사 큐가 제공한 상태만 표시합니다. 이 화면은 provider/source 원문을 보관하거나 표시하지 않습니다.</footer></div>;
}
