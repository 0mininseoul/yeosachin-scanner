'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { analysisV2ProgressCopy } from '@/lib/services/analysis/owner-view-presentation';

interface AnalysisProgress {
    id: string;
    pipelineVersion: 'v1' | 'v2';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    errorMessage: string | null;
    backgroundProcessing: boolean;
}

interface V2ProgressRead {
    snapshot: {
        requestId: string;
        status: 'queued' | 'processing' | 'completed' | 'failed' | 'upgrade_required';
        progressBp: number;
        backgroundProcessing: boolean;
        tracks: Record<string, { state: string; stageCode: string }>;
        activeProfile: { maskedUsername: string; imageUrl: string | null } | null;
    };
    events: Array<{ copyCode: string }>;
}

function mapV2Status(status: V2ProgressRead['snapshot']['status']): AnalysisProgress['status'] {
    if (status === 'queued') return 'pending';
    if (status === 'upgrade_required') return 'failed';
    return status;
}

export function useAnalysisProgress(requestId: string) {
    const [data, setData] = useState<AnalysisProgress | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hasDataRef = useRef(false);
    const v2ProgressUrlRef = useRef<string | null>(null);

    // 초기 데이터 로드
    const fetchData = useCallback(async () => {
        try {
            let response = await fetch(
                v2ProgressUrlRef.current
                    || `/api/analysis/status/${encodeURIComponent(requestId)}`,
                { cache: 'no-store' }
            );
            let payload = await response.json() as Record<string, unknown>;
            if (
                response.status === 409
                && payload.code === 'V2_ROUTE_REQUIRED'
                && payload.pipelineVersion === 'v2'
                && typeof payload.progressUrl === 'string'
                && payload.progressUrl.startsWith('/api/analysis/progress/')
            ) {
                v2ProgressUrlRef.current = payload.progressUrl;
                response = await fetch(payload.progressUrl, { cache: 'no-store' });
                payload = await response.json() as Record<string, unknown>;
            }
            if (!response.ok) {
                throw new Error(`Analysis status request failed (${response.status}).`);
            }

            if (v2ProgressUrlRef.current) {
                const progress = payload as unknown as V2ProgressRead;
                setData({
                    id: progress.snapshot.requestId,
                    pipelineVersion: 'v2',
                    status: mapV2Status(progress.snapshot.status),
                    progress: progress.snapshot.progressBp / 100,
                    progressStep: analysisV2ProgressCopy({
                        status: progress.snapshot.status,
                        tracks: progress.snapshot.tracks,
                        events: progress.events,
                        activeProfile: progress.snapshot.activeProfile,
                    }),
                    errorMessage: progress.snapshot.status === 'upgrade_required'
                        ? '현재 계정 규모에 맞는 플랜을 다시 확인해주세요.'
                        : progress.snapshot.status === 'failed'
                            ? '판독 처리 중 오류가 발생했습니다.'
                            : null,
                    backgroundProcessing: progress.snapshot.backgroundProcessing,
                });
                hasDataRef.current = true;
                setError(null);
                return;
            }

            const analysisRequest = payload as unknown as {
                requestId: string;
                pipelineVersion: 'v1';
                status: AnalysisProgress['status'];
                progress: number;
                progressStep: string | null;
                errorMessage: string | null;
                backgroundProcessing: boolean;
            };

            setData({
                id: analysisRequest.requestId,
                pipelineVersion: analysisRequest.pipelineVersion,
                status: analysisRequest.status,
                progress: analysisRequest.progress,
                progressStep: analysisRequest.progressStep,
                errorMessage: analysisRequest.errorMessage,
                backgroundProcessing: analysisRequest.backgroundProcessing === true,
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
