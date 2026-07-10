'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface AnalysisProgress {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    errorMessage: string | null;
    backgroundProcessing: boolean;
}

export function useAnalysisProgress(requestId: string) {
    const [data, setData] = useState<AnalysisProgress | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hasDataRef = useRef(false);

    // 초기 데이터 로드
    const fetchData = useCallback(async () => {
        try {
            const response = await fetch(`/api/analysis/status/${encodeURIComponent(requestId)}`, {
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`Analysis status request failed (${response.status}).`);
            }
            const request = await response.json() as {
                requestId: string;
                status: AnalysisProgress['status'];
                progress: number;
                progressStep: string | null;
                errorMessage: string | null;
                backgroundProcessing: boolean;
            };

            setData({
                id: request.requestId,
                status: request.status,
                progress: request.progress,
                progressStep: request.progressStep,
                errorMessage: request.errorMessage,
                backgroundProcessing: request.backgroundProcessing === true,
            });
            hasDataRef.current = true;
            setError(null);
        } catch (err) {
            console.error('Failed to fetch analysis progress:', err);
            if (!hasDataRef.current) {
                setError('분석 요청을 찾을 수 없습니다.');
            }
        } finally {
            setLoading(false);
        }
    }, [requestId]);

    useEffect(() => {
        void fetchData();
    }, [fetchData]);

    // Poll only the explicitly granted progress columns. The paid pipeline remains owned by
    // Cloud Tasks (or the progress page fallback), so polling never starts a paid step itself.
    useEffect(() => {
        if (data?.status === 'completed' || data?.status === 'failed') return;
        const interval = setInterval(fetchData, 5_000);
        return () => clearInterval(interval);
    }, [data?.status, fetchData]);

    return { data, loading, error, refetch: fetchData };
}
