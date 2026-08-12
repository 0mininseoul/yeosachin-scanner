'use client';

import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/case-ui';

export type PreflightPendingStage = 'initial' | 'later' | 'delayed';

const LATER_THRESHOLD_MS = 15_000;
const DELAYED_THRESHOLD_MS = 45_000;

const COPY: Record<PreflightPendingStage, { primary: string; supporting: string }> = {
    initial: {
        primary: '프로필과 계정 규모를 확인하고 있습니다.',
        supporting: '확인이 끝나면 이용 가능한 판독 플랜을 바로 안내해드릴게요.',
    },
    later: {
        primary: '조금만 더 확인하고 있어요.',
        supporting: '화면을 벗어나도 점검은 계속됩니다.',
    },
    delayed: {
        primary: '평소보다 확인이 오래 걸리고 있습니다.',
        supporting: '점검은 계속 진행 중입니다. 화면을 벗어나도 괜찮아요.',
    },
};

export function preflightPendingStage(elapsedMs: number): PreflightPendingStage {
    if (!Number.isFinite(elapsedMs) || elapsedMs < LATER_THRESHOLD_MS) return 'initial';
    if (elapsedMs < DELAYED_THRESHOLD_MS) return 'later';
    return 'delayed';
}

interface PreflightPendingStatusProps {
    targetInstagramId: string | null;
    startedAt: number | null;
    now?: () => number;
}

export function PreflightPendingStatus({
    targetInstagramId,
    startedAt,
    now = Date.now,
}: PreflightPendingStatusProps) {
    const [nowMs, setNowMs] = useState(() => now());
    const elapsedMs = startedAt === null ? 0 : Math.max(0, nowMs - startedAt);
    const stage = preflightPendingStage(elapsedMs);
    const copy = COPY[stage];

    useEffect(() => {
        const update = () => setNowMs(now());
        if (startedAt === null) return;

        const currentElapsedMs = Math.max(0, now() - startedAt);
        const nextThreshold = currentElapsedMs < LATER_THRESHOLD_MS
            ? LATER_THRESHOLD_MS
            : currentElapsedMs < DELAYED_THRESHOLD_MS
                ? DELAYED_THRESHOLD_MS
                : null;

        if (nextThreshold === null) return;
        const timeoutId = window.setTimeout(update, Math.max(1, nextThreshold - currentElapsedMs));
        return () => window.clearTimeout(timeoutId);
    }, [now, stage, startedAt]);

    return (
        <div className="mt-7 py-4 text-center" role="status" aria-live="polite" aria-atomic="true">
            <div className="mx-auto flex h-14 w-14 items-center justify-center border border-line bg-ink">
                <BrandMark size={26} className="anim-blink text-blood" />
            </div>
            <h2 data-amp-block className="mt-5 text-[18px] font-extrabold text-fg">
                @{targetInstagramId ?? '대상 계정'} 조회 중
            </h2>
            <p className="mt-2 text-[13px] font-medium text-fg-dim">
                {copy.primary}
            </p>
            <div className="mt-6 h-1.5 w-full overflow-hidden bg-line" aria-hidden="true">
                <div className="h-full w-1/3 bg-blood anim-indeterminate" />
            </div>
            <p className="mt-5 text-[12px] leading-relaxed text-fg-mute">
                {copy.supporting}
            </p>
        </div>
    );
}
