'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PrimaryButton } from '@/components/case-ui';
import {
    ownerHistoryTargetLabel,
    type OwnerAnalysisHistoryItemV1,
} from '@/lib/services/analysis/owner-history';
import { analysisPlanBadgePresentation } from '@/lib/services/analysis/owner-view-presentation';
import { formatKstDateTime } from '@/lib/services/date-time-presentation';

interface Props {
    initialAnalyses: OwnerAnalysisHistoryItemV1[];
}

export default function AnalysisList({ initialAnalyses }: Props) {
    const [analyses] = useState<OwnerAnalysisHistoryItemV1[]>(initialAnalyses);
    const router = useRouter();
    const visibleAnalyses = analyses.filter((item) =>
        ['pending', 'processing', 'completed'].includes(item.status)
    );

    const handleCardClick = (item: OwnerAnalysisHistoryItemV1) => {
        if (item.status === 'completed') {
            router.push(`/result/${item.id}${item.pipelineVersion === 'v2' ? '?pipeline=v2' : ''}`);
        } else {
            router.push(`/progress/${item.id}`);
        }
    };

    if (visibleAnalyses.length === 0) {
        // Tier 0: an empty state is not a surface to operate, so it needs no box.
        return (
            <div className="border-t border-line px-2 py-14 text-center">
                <p className="mb-6 text-[13px] text-fg-mute">아직 판독 기록이 없습니다.</p>
                <div className="mx-auto max-w-[220px]">
                    <PrimaryButton onClick={() => router.push('/analyze')}>판독 시작하기</PrimaryButton>
                </div>
            </div>
        );
    }

    /* Rows, not cards. Status rides the left rail so the archive can be scanned
       by colour alone, and the row keeps exactly one bordered element — none —
       because the whole row is the target. */
    return (
        <div className="border-t border-line">
            {visibleAnalyses.map((item) => {
                const planBadge = analysisPlanBadgePresentation(item.planType);
                const done = item.status === 'completed';
                return (
                    <button
                        key={item.id}
                        type="button"
                        data-amp-block
                        onClick={() => handleCardClick(item)}
                        className="group flex w-full gap-3.5 border-b border-line py-5 pr-1 text-left transition-colors hover:bg-panel/60"
                    >
                        <span
                            aria-hidden="true"
                            className={`w-0.5 shrink-0 self-stretch ${done ? 'bg-jade' : 'bg-amber'}`}
                        />
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                                <span className="truncate text-[15px] font-bold text-fg">
                                    {ownerHistoryTargetLabel(item)}
                                </span>
                                <span
                                    className={`num shrink-0 text-[10px] font-bold tracking-[0.12em] ${planBadge.className}`}
                                >
                                    {planBadge.label}
                                </span>
                                <span
                                    className={`ml-auto inline-flex shrink-0 items-center gap-1.5 text-[10.5px] font-extrabold tracking-[0.14em] ${
                                        done ? 'text-jade' : 'text-amber'
                                    }`}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`h-[5px] w-[5px] rotate-45 ${
                                            done ? 'bg-jade' : 'anim-blink bg-amber'
                                        }`}
                                    />
                                    {done ? '완료' : item.status === 'processing' ? '판독중' : '대기중'}
                                </span>
                            </span>
                            <span className="num mt-1.5 block text-[11.5px] text-fg-dim">
                                {item.createdAt ? formatKstDateTime(item.createdAt) : '날짜 미상'}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
