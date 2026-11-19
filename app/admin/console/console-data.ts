'use client';

import { z } from 'zod';
import {
    apifyAccountCreditInventorySchema,
    type ApifyAccountCreditInventoryRow,
} from '@/lib/contracts/apify-account-credit-inventory';
import type { OrderAuditListRow } from '@/lib/services/analysis/order-audit-list';
import { accountStatus } from '@/lib/services/analysis/operator-console-model';

export const PAGE_SIZE = 25;

export type Tone = 'ok' | 'warn' | 'block' | 'none';

export class ConsoleRequestError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

function messageFor(status: number): string {
    if (status === 401) return '운영자 세션이 만료됐습니다. 다시 로그인해 주세요.';
    if (status === 403) return '운영자 권한이 없습니다.';
    if (status === 404) return '데이터를 찾지 못했습니다.';
    if (status === 400) return '요청 조건이 올바르지 않습니다.';
    return '운영 데이터를 불러오지 못했습니다.';
}

export async function requestJson<T>(
    url: string,
    schema: { parse(value: unknown): T },
    init: RequestInit = {},
): Promise<T> {
    const response = await fetch(url, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Cache-Control': 'private, no-store', ...init.headers },
    });
    if (!response.ok) throw new ConsoleRequestError(response.status, messageFor(response.status));
    try {
        return schema.parse(await response.json());
    } catch {
        throw new ConsoleRequestError(502, '운영 데이터 형식이 올바르지 않습니다.');
    }
}

export function errorMessage(caught: unknown, fallback = '운영 데이터를 불러오지 못했습니다.'): string {
    if (caught instanceof DOMException && caught.name === 'AbortError') return '';
    return caught instanceof Error && caught.message ? caught.message : fallback;
}

/* ---------- response schemas for the console-only APIs ---------- */

const usd = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

const overviewBucketSchema = z.object({
    start: z.string(),
    payers: count,
    basicPayers: count,
    standardPayers: count,
    knownCostUsd: usd,
    conservativeCostUsd: usd,
    preflightCostUsd: usd,
    analysisCostUsd: usd,
    aiCostUsd: usd,
    unsettledCalls: count,
    visitors: count.nullable(),
});

export const overviewSchema = z.object({
    generatedAt: z.string(),
    conversionSince: z.string(),
    activeUsersNow: count.nullable(),
    signups: z.object({ total: count, today: count, last7Days: count }),
    conversion: z.object({ payers: count, visitors: count.nullable(), ratePercent: z.number().nullable() }),
    today: overviewBucketSchema,
    daily: z.array(overviewBucketSchema),
    weekly: z.array(overviewBucketSchema),
    visitorSource: z.enum(['amplitude', 'unavailable']),
});

export type ConsoleOverview = z.infer<typeof overviewSchema>;
export type OverviewBucket = z.infer<typeof overviewBucketSchema>;

export const inventoryEnvelopeSchema = z.object({ inventory: apifyAccountCreditInventorySchema }).strict();

const attributionLabel = z.string().max(40).nullable();

export const leadInputsSchema = z.object({
    rows: z.array(z.object({
        inputAt: z.string(),
        mappingStatus: z.enum(['legacy_unlinked', 'anonymous_device', 'authenticated_user', 'unlinked_after_deletion']),
        userName: z.string().nullable(),
        attributionLabel,
        targetInstagramId: z.string(),
        excludedInstagramId: z.string().nullable(),
    })).max(50),
    nextCursor: z.string().nullable(),
});

export type LeadInputRow = z.infer<typeof leadInputsSchema>['rows'][number];

export const orderCustomersSchema = z.object({
    rows: z.array(z.object({
        requestId: z.string().uuid(),
        userName: z.string().nullable(),
        gender: z.string().nullable(),
        birthyear: z.string().nullable(),
        deviceLabel: z.string().nullable(),
        attributionLabel,
        paidAmountKrw: z.number().int().nullable(),
    })),
});

export type OrderCustomer = z.infer<typeof orderCustomersSchema>['rows'][number];

export async function loadOrderCustomers(
    requestIds: readonly string[],
    signal?: AbortSignal,
): Promise<Map<string, OrderCustomer>> {
    if (requestIds.length === 0) return new Map();
    const params = new URLSearchParams();
    for (const id of requestIds.slice(0, 50)) params.append('requestId', id);
    const body = await requestJson(`/api/admin/order-customers?${params.toString()}`, orderCustomersSchema, { signal });
    return new Map(body.rows.map(row => [row.requestId, row]));
}

/* ---------- formatting ---------- */

export function formatDateTime(value: string | null | undefined): string {
    if (!value) return '미상';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '미상';
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
}

export function formatCount(value: number | null | undefined): string {
    return value === null || value === undefined ? '미상' : value.toLocaleString('ko-KR');
}

export function formatUsd(value: number | null | undefined): string {
    return value === null || value === undefined ? '미상' : `$${value.toFixed(2)}`;
}

export function formatKrw(value: number | null | undefined): string {
    return value === null || value === undefined ? '미상' : `₩${value.toLocaleString('ko-KR')}`;
}

export function shortId(value: string | null | undefined): string {
    return value ? `${value.slice(0, 13)}…` : '미상';
}

/* ---------- order status (one unified column) ---------- */

const EVIDENCE_LABEL: Record<OrderAuditListRow['completenessStatus'], string> = {
    complete: '완전', partial: '부분', inconsistent: '불일치', failed: '실패',
};
const COST_LABEL: Record<OrderAuditListRow['cost']['status'], string> = {
    complete: '완전', partial: '부분', unknown: '미상', not_available: '원장 없음',
};
const RETENTION_LABEL: Record<OrderAuditListRow['retention']['state'], string> = {
    retained: '영구 보관됨', pending: '보관 대기', fenced: '보관 차단', unknown: '보관 미상',
};

export type OrderStatusSummary = Readonly<{ tone: Tone; label: string; reason: string }>;

type StatusInput = {
    completenessStatus: OrderAuditListRow['completenessStatus'];
    costStatus: OrderAuditListRow['cost']['status'];
    retentionState: OrderAuditListRow['retention']['state'];
};

/** Evidence, cost and retention folded into one 정상/주의/차단 status. */
export function orderStatus(input: StatusInput): OrderStatusSummary {
    const blocked = input.completenessStatus === 'inconsistent'
        || input.completenessStatus === 'failed'
        || input.retentionState === 'fenced';
    const parts: string[] = [];
    if (input.completenessStatus !== 'complete') parts.push(`증거 ${EVIDENCE_LABEL[input.completenessStatus]}`);
    if (input.costStatus !== 'complete') parts.push(`원가 ${COST_LABEL[input.costStatus]}`);
    if (input.retentionState !== 'retained') parts.push(RETENTION_LABEL[input.retentionState]);
    const tone: Tone = blocked ? 'block' : parts.length > 0 ? 'warn' : 'ok';
    return {
        tone,
        label: tone === 'ok' ? '정상' : tone === 'warn' ? '주의' : '차단',
        reason: parts.length > 0 ? parts.join(' · ') : '증거·원가·보관 완전',
    };
}

export function listRowStatus(row: OrderAuditListRow): OrderStatusSummary {
    return orderStatus({
        completenessStatus: row.completenessStatus,
        costStatus: row.cost.status,
        retentionState: row.retention.state,
    });
}

export function knownCostLabel(knownUsd: number | null, status: OrderAuditListRow['cost']['status']): string {
    if (status === 'not_available') return '원장 없음';
    return knownUsd === null ? '미확정' : formatUsd(knownUsd);
}

/* ---------- Apify accounts ---------- */

export type AccountTone = Readonly<{ tone: Tone; label: string; reason: string }>;

export function accountTone(row: ApifyAccountCreditInventoryRow | undefined): AccountTone {
    if (!row) return { tone: 'block', label: '차단', reason: '스냅샷이 없습니다.' };
    const status = accountStatus(row);
    if (status === 'excluded') return { tone: 'none', label: '배차 제외', reason: '운영자가 배차에서 제외했습니다.' };
    let reason = '현재 스냅샷을 신뢰할 수 있습니다.';
    if (row.healthState === 'missing' || row.freshnessState === 'missing') reason = '잔액 스냅샷을 확인할 수 없습니다.';
    else if (row.healthState === 'unhealthy') reason = '마지막 조회가 실패했습니다.';
    else if (row.freshnessState === 'stale') reason = '오래된 스냅샷이라 현재 잔액을 확정하지 않습니다.';
    else if (row.effectiveRemainingUsd === null || row.effectiveRemainingUsd <= 0) reason = '현재 잔액이 없습니다.';
    if (status === 'healthy') return { tone: 'ok', label: '정상', reason };
    if (status === 'warning') return { tone: 'warn', label: '주의', reason };
    return { tone: 'block', label: '차단', reason };
}

export function remainingRatio(row: ApifyAccountCreditInventoryRow | undefined): number | null {
    if (!row || row.freshnessState !== 'fresh' || row.effectiveRemainingUsd === null
        || row.monthlyLimitUsd === null || row.monthlyLimitUsd <= 0) return null;
    return Math.max(0, Math.min(1, row.effectiveRemainingUsd / row.monthlyLimitUsd));
}

export const MAPPING_LABEL: Record<LeadInputRow['mappingStatus'], string> = {
    authenticated_user: '로그인 사용자',
    anonymous_device: '비로그인 · 익명 기기',
    legacy_unlinked: '기존 방식 입력',
    unlinked_after_deletion: '탈퇴 후 연결 해제',
};
