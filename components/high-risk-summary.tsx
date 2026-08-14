'use client';

import type { ReactNode } from 'react';
import { useCountUp } from '@/hooks/useCountUp';

interface HighRiskSummaryProps {
    count: number;
    context?: ReactNode;
}

/** The owner-facing verdict shared by V1 concierge and V2 result reports. */
export function HighRiskSummary({ count, context }: HighRiskSummaryProps) {
    const safeCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    const revealedCount = useCountUp(safeCount, { delayMs: 300, durationMs: 800 });

    return (
        <div className="relative mt-5 pl-4">
            <span
                aria-hidden="true"
                className={`reveal-rail absolute inset-y-0 left-0 w-0.5 ${
                    safeCount > 0 ? 'bg-blood' : 'bg-jade'
                }`}
                style={{ animationDelay: '300ms' }}
            />
            <p
                className={`num text-[56px] font-extrabold leading-[0.85] tracking-[-0.045em] ${
                    safeCount > 0 ? 'text-blood-2' : 'text-jade'
                }`}
            >
                <span className="sr-only">고위험 계정 {safeCount}건</span>
                <span aria-hidden="true">{revealedCount}</span>
            </p>
            <p
                className="reveal mt-3 text-[17px] font-extrabold tracking-tight text-fg"
                style={{ animationDelay: '700ms' }}
            >
                고위험 계정
            </p>
            {context ? (
                <p
                    className="reveal mt-1 text-[12.5px] text-fg-dim"
                    style={{ animationDelay: '780ms' }}
                >
                    {context}
                </p>
            ) : null}
        </div>
    );
}
