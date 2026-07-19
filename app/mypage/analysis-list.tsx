'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PrimaryButton } from '@/components/case-ui';
import { isAnalysisDeletable } from '@/lib/services/analysis/deletion';
import {
    ownerHistoryTargetLabel,
    type OwnerAnalysisHistoryItemV1,
} from '@/lib/services/analysis/owner-history';
import { analysisPlanBadgePresentation } from '@/lib/services/analysis/owner-view-presentation';

interface Props {
    initialAnalyses: OwnerAnalysisHistoryItemV1[];
}

export default function AnalysisList({ initialAnalyses }: Props) {
    const [analyses, setAnalyses] = useState<OwnerAnalysisHistoryItemV1[]>(initialAnalyses);
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const router = useRouter();

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();

        if (!confirm('정말 이 판독 기록을 삭제하시겠습니까? 복구할 수 없습니다.')) {
            return;
        }

        setLoadingId(id);

        try {
            const response = await fetch(`/api/analysis/result/${id}`, { method: 'DELETE' });
            if (!response.ok) {
                alert('삭제에 실패했습니다.');
                console.error('Analysis deletion request failed', { status: response.status });
            } else {
                setAnalyses((prev) => prev.filter((item) => item.id !== id));
            }
        } catch (err) {
            console.error(err);
            alert('오류가 발생했습니다.');
        } finally {
            setLoadingId(null);
        }
    };

    const handleCardClick = (id: string, status: string) => {
        if (status === 'completed') {
            router.push(`/result/${id}`);
        } else if (status === 'processing' || status === 'pending') {
            router.push(`/progress/${id}`);
        } else {
            alert('완료되지 않은 판독입니다.');
        }
    };

    if (analyses.length === 0) {
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
            {analyses.map((item) => {
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
                                    {item.createdAt ? (
                                        <>
                                            {new Date(item.createdAt).toLocaleDateString()}{' '}
                                            {new Date(item.createdAt).toLocaleTimeString()}
                                        </>
                                    ) : '날짜 미상'}
                                </div>
                            </div>

                            <div className="flex shrink-0 flex-col items-end justify-between gap-2 self-stretch">
                                {item.status === 'completed' ? (
                                    <span className="flex items-center gap-1.5 border border-jade/45 bg-jade/10 px-2 py-1 text-[11px] font-bold text-jade">
                                        <span className="h-1.5 w-1.5 bg-jade" />
                                        판독완료
                                    </span>
                                ) : item.status === 'failed' ? (
                                    <span className="flex items-center gap-1.5 border border-blood/45 bg-blood/10 px-2 py-1 text-[11px] font-bold text-blood">
                                        <span className="h-1.5 w-1.5 bg-blood" />
                                        판독실패
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-1.5 border border-amber/45 bg-amber/10 px-2 py-1 text-[11px] font-bold text-amber">
                                        <span className="anim-blink h-1.5 w-1.5 bg-amber" />
                                        {item.status === 'processing' ? '판독중' : '대기중'}
                                    </span>
                                )}

                                {isAnalysisDeletable(item.status) && (
                                    <button
                                        onClick={(e) => handleDelete(e, item.id)}
                                        disabled={loadingId === item.id}
                                        className="-mb-1 -mr-1 p-1 text-fg-mute opacity-100 transition-colors hover:text-blood disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
                                        title="기록 삭제"
                                    >
                                        {loadingId === item.id ? (
                                            <span className="inline-block h-[18px] w-[18px] animate-spin rounded-full border-2 border-fg-mute border-t-transparent" />
                                        ) : (
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
