'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface AnalysisProgress {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    errorMessage: string | null;
}

export function useAnalysisProgress(requestId: string) {
    const [data, setData] = useState<AnalysisProgress | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const supabase = createClient();

    // 초기 데이터 로드
    const fetchData = useCallback(async () => {
        try {
            const { data: request, error } = await supabase
                .from('analysis_requests')
                .select('id, status, progress, progress_step, error_message')
                .eq('id', requestId)
                .single();

            if (error) throw error;

            setData({
                id: request.id,
                status: request.status,
                progress: request.progress,
                progressStep: request.progress_step,
                errorMessage: request.error_message,
            });
        } catch (err) {
            console.error('Failed to fetch analysis progress:', err);
            setError('분석 요청을 찾을 수 없습니다.');
        } finally {
            setLoading(false);
        }
    }, [requestId, supabase]);

    useEffect(() => {
        fetchData();

        // Realtime 구독
        let channel: RealtimeChannel;

        const setupRealtime = async () => {
            channel = supabase
                .channel(`analysis-${requestId}`)
                .on(
                    'postgres_changes',
                    {
                        event: 'UPDATE',
                        schema: 'public',
                        table: 'analysis_requests',
                        filter: `id=eq.${requestId}`,
                    },
                    (payload) => {
                        const updated = payload.new as {
                            id: string;
                            status: 'pending' | 'processing' | 'completed' | 'failed';
                            progress: number;
                            progress_step: string | null;
                            error_message: string | null;
                        };

                        setData({
                            id: updated.id,
                            status: updated.status,
                            progress: updated.progress,
                            progressStep: updated.progress_step,
                            errorMessage: updated.error_message,
                        });
                    }
                )
                .subscribe();
        };

        setupRealtime();

        return () => {
            if (channel) {
                supabase.removeChannel(channel);
            }
        };
    }, [requestId, fetchData, supabase]);

    return { data, loading, error, refetch: fetchData };
}
