'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { PrimaryButton } from '@/components/case-ui';

interface AnalysisRequest {
    id: string;
    target_instagram_id: string;
    status: string;
    created_at: string;
    plan_type?: string;
}

interface Props {
    initialAnalyses: AnalysisRequest[];
}

export default function AnalysisList({ initialAnalyses }: Props) {
    const [analyses, setAnalyses] = useState<AnalysisRequest[]>(initialAnalyses);
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const router = useRouter();
    const supabase = createClient();

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();

        if (!confirm('정말 이 판독 기록을 삭제하시겠습니까? 복구할 수 없습니다.')) {
            return;
        }

        setLoadingId(id);

        try {
            const { error } = await supabase.from('analysis_requests').delete().eq('id', id);

            if (error) {
                alert('삭제에 실패했습니다.');
                console.error(error);
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
            {analyses.map((item) => (
                <div
                    key={item.id}
                    onClick={() => handleCardClick(item.id, item.status)}
                    className="group relative cursor-pointer border border-line bg-ink-2 p-4 transition-colors hover:border-blood/50 active:scale-[0.99]"
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h3 className="truncate text-[15px] font-bold text-fg">@{item.target_instagram_id}</h3>
                                <span
                                    className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-bold tracking-[0.1em] ${
                                        item.plan_type === 'standard'
                                            ? 'border-blood/40 bg-blood/10 text-blood'
                                            : 'border-line-2 text-fg-mute'
                                    }`}
                                >
                                    {item.plan_type === 'standard' ? 'STANDARD' : 'BASIC'}
                                </span>
                            </div>
                            <div className="num mt-1.5 text-[12px] text-fg-mute">
                                {new Date(item.created_at).toLocaleDateString()}{' '}
                                {new Date(item.created_at).toLocaleTimeString()}
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

                    <button
                        onClick={(e) => handleDelete(e, item.id)}
                        disabled={loadingId === item.id}
                        className="absolute bottom-3 right-3 p-2 text-fg-mute opacity-100 transition-colors hover:text-blood sm:opacity-0 sm:group-hover:opacity-100"
                        title="기록 삭제"
                    >
                        {loadingId === item.id ? (
                            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-fg-mute border-t-transparent" />
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        )}
                    </button>
                </div>
            ))}
        </div>
    );
}
