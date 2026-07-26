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

    const handleCardClick = (id: string, status: OwnerAnalysisHistoryItemV1['status']) => {
        if (status === 'completed') {
            router.push(`/result/${id}`);
        } else {
            router.push(`/progress/${id}`);
        }
    };

    if (visibleAnalyses.length === 0) {
        return (
            <div className="border border-line bg-ink-2 px-6 py-16 text-center">
                <p className="mb-6 text-[13px] text-fg-mute">아직 판독 기록이 없습니다.</p>
                <div className="mx-auto max-w-[220px]">
                    <PrimaryButton onClick={() => router.push('/analyze')}>판독 시작하기</PrimaryButton>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-2.5">
            {visibleAnalyses.map((item) => {
                const planBadge = analysisPlanBadgePresentation(item.planType);
                return (
                    <div
                        key={item.id}
                        data-amp-block
                        onClick={() => handleCardClick(item.id, item.status)}
                        className="group relative cursor-pointer border border-line bg-ink-2 p-4 transition-colors hover:border-blood/50 active:scale-[0.99]"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <h3 className="truncate text-[15px] font-bold text-fg">
                                        {ownerHistoryTargetLabel(item)}
                                    </h3>
                                    <span
                                        className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-bold tracking-[0.1em] ${planBadge.className}`}
                                    >
                                        {planBadge.label}
                                    </span>
                                </div>
                                <div className="num mt-1.5 text-[12px] text-fg-mute">
                                    {item.createdAt
                                        ? formatKstDateTime(item.createdAt)
                                        : '날짜 미상'}
                                </div>
                            </div>

                            {item.status === 'completed' ? (
                                <span className="flex shrink-0 items-center gap-1.5 border border-jade/45 bg-jade/10 px-2 py-1 text-[11px] font-bold text-jade">
                                    <span className="h-1.5 w-1.5 bg-jade" />
                                    판독완료
                                </span>
                            ) : (
                                <span className="flex shrink-0 items-center gap-1.5 border border-amber/45 bg-amber/10 px-2 py-1 text-[11px] font-bold text-amber">
                                    <span className="anim-blink h-1.5 w-1.5 bg-amber" />
                                    {item.status === 'processing' ? '판독중' : '대기중'}
                                </span>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
