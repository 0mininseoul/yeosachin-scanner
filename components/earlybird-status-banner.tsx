'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { EarlybirdOrderStatusDto } from '@/lib/services/earlybird/order-status';

const PENDING_STATUSES: ReadonlySet<EarlybirdOrderStatusDto['systemStatus']> = new Set([
    'paid',
    'analysis_in_progress',
]);

function isPendingOrderPayload(value: unknown): value is EarlybirdOrderStatusDto {
    return !!value && typeof value === 'object'
        && 'targetInstagramId' in value && typeof value.targetInstagramId === 'string'
        && 'systemStatus' in value && typeof value.systemStatus === 'string'
        && 'dueAt' in value && (typeof value.dueAt === 'string' || value.dueAt === null);
}

function formatRemaining(dueAt: string): string {
    const remainingMs = new Date(dueAt).getTime() - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '곧 전달 예정';
    const totalSeconds = Math.max(1, Math.floor(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초 남음`;
    if (minutes > 0) return `${minutes}분 ${seconds}초 남음`;
    return `${seconds}초 남음`;
}

export function EarlybirdStatusBanner({ enabled }: { enabled: boolean }) {
    const [order, setOrder] = useState<EarlybirdOrderStatusDto | null>(null);
    const [, forceTick] = useState(0);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        (async () => {
            try {
                const response = await fetch('/api/earlybird/orders/latest');
                if (!response.ok) return;
                const payload: unknown = await response.json().catch(() => null);
                if (cancelled || !payload || typeof payload !== 'object' || !('order' in payload)
                    || !isPendingOrderPayload(payload.order)) return;
                setOrder(payload.order);
            } catch {
                /* 배너는 부가 정보이므로 조회 실패 시 조용히 무시한다. */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [enabled]);

    useEffect(() => {
        if (!order?.dueAt) return;
        const timer = setInterval(() => forceTick(tick => tick + 1), 1_000);
        return () => clearInterval(timer);
    }, [order]);

    if (!enabled || !order || !order.dueAt || !PENDING_STATUSES.has(order.systemStatus)) return null;

    return (
        <Link
            href="/earlybird"
            className="block border-b border-amber/30 bg-amber/[0.08] px-5 py-2.5 text-center text-[12px] font-semibold text-amber transition-colors hover:bg-amber/[0.14]"
        >
            @{order.targetInstagramId} 판독 결과 대기 중 · {formatRemaining(order.dueAt)}
        </Link>
    );
}
