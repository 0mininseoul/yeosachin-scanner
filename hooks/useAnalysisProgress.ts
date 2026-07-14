'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
    progressReadV1Schema,
    type ProgressEventV1,
    type ProgressSnapshotV1,
} from '@/lib/contracts/analysis-v2';
import { analysisV2ProgressCopy } from '@/lib/services/analysis/owner-view-presentation';
import {
    mergeProgressEvents,
    shouldApplyProgressRevision,
} from '@/lib/services/analysis/v2-progress-client-state';
import { createClient } from '@/lib/supabase/client';

interface AnalysisProgress {
    id: string;
    pipelineVersion: 'v1' | 'v2';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    errorMessage: string | null;
    backgroundProcessing: boolean;
    tracks: ProgressSnapshotV1['tracks'] | null;
    activeProfile: ProgressSnapshotV1['activeProfile'];
    etaRange: ProgressSnapshotV1['etaRange'];
    events: ProgressEventV1[];
}

function mapV2Status(status: ProgressSnapshotV1['status']): AnalysisProgress['status'] {
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
    const v2EventsRef = useRef<ProgressEventV1[]>([]);
    const v2LastEventSeqRef = useRef(0);
    const v2RevisionRef = useRef(-1);
    const fetchQueuedRef = useRef(false);
    const activeRequestIdRef = useRef<string | null>(null);
    const fetchInFlightRef = useRef<{
        requestId: string;
        controller: AbortController;
        promise: Promise<void>;
    } | null>(null);
    const supabase = useMemo(() => createClient(), []);

    const fetchData = useCallback((): Promise<void> => {
        const current = fetchInFlightRef.current;
        if (current?.requestId === requestId) {
            fetchQueuedRef.current = true;
            return current.promise;
        }
        current?.controller.abort();

        const controller = new AbortController();
        const run = async () => {
            try {
                const progressUrl = v2ProgressUrlRef.current;
                let response = await fetch(
                    progressUrl
                        ? `${progressUrl}?afterSeq=${v2LastEventSeqRef.current}&limit=200`
                        : `/api/analysis/status/${encodeURIComponent(requestId)}`,
                    { cache: 'no-store', signal: controller.signal }
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
                    response = await fetch(
                        `${payload.progressUrl}?afterSeq=${v2LastEventSeqRef.current}&limit=200`,
                        { cache: 'no-store', signal: controller.signal }
                    );
                    payload = await response.json() as Record<string, unknown>;
                }
                if (!response.ok) {
                    throw new Error(`Analysis status request failed (${response.status}).`);
                }

                if (v2ProgressUrlRef.current) {
                    const parsed = progressReadV1Schema.safeParse(payload);
                    if (!parsed.success) {
                        throw new Error('Analysis progress response did not match the V2 contract.');
                    }
                    const progress = parsed.data;
                    if (progress.events.length > 0) {
                        v2LastEventSeqRef.current = Math.max(
                            v2LastEventSeqRef.current,
                            progress.events.at(-1)!.seq
                        );
                        v2EventsRef.current = mergeProgressEvents(
                            v2EventsRef.current,
                            progress.events
                        );
                    }
                    const retainedEvents = v2EventsRef.current;
                    if (!shouldApplyProgressRevision(
                        v2RevisionRef.current,
                        progress.snapshot.revision
                    )) {
                        return;
                    }
                    v2RevisionRef.current = progress.snapshot.revision;
                    setData({
                        id: progress.snapshot.requestId,
                        pipelineVersion: 'v2',
                        status: mapV2Status(progress.snapshot.status),
                        progress: Math.round(progress.snapshot.progressBp / 10) / 10,
                        progressStep: analysisV2ProgressCopy({
                            status: progress.snapshot.status,
                            tracks: progress.snapshot.tracks,
                            events: retainedEvents,
                            activeProfile: progress.snapshot.activeProfile,
                        }),
                        errorMessage: progress.snapshot.status === 'upgrade_required'
                            ? '현재 계정 규모에 맞는 플랜을 다시 확인해주세요.'
                            : progress.snapshot.status === 'failed'
                                ? '판독 처리 중 오류가 발생했습니다.'
                                : null,
                        backgroundProcessing: progress.snapshot.backgroundProcessing,
                        tracks: progress.snapshot.tracks,
                        activeProfile: progress.snapshot.activeProfile,
                        etaRange: progress.snapshot.etaRange,
                        events: retainedEvents,
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
                    tracks: null,
                    activeProfile: null,
                    etaRange: null,
                    events: [],
                });
                hasDataRef.current = true;
                setError(null);
            } catch (err) {
                if (controller.signal.aborted) return;
                console.error('Failed to fetch analysis progress:', err);
                if (!hasDataRef.current) {
                    setError('분석 요청을 찾을 수 없습니다.');
                }
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        };

        const promise = run().finally(() => {
            if (fetchInFlightRef.current?.promise !== promise) return;
            fetchInFlightRef.current = null;
            const shouldRefetch = fetchQueuedRef.current;
            fetchQueuedRef.current = false;
            if (shouldRefetch && activeRequestIdRef.current === requestId) {
                void fetchData();
            }
        });
        fetchInFlightRef.current = { requestId, controller, promise };
        return promise;
    }, [requestId]);

    useEffect(() => {
        activeRequestIdRef.current = requestId;
        fetchInFlightRef.current?.controller.abort();
        hasDataRef.current = false;
        v2ProgressUrlRef.current = null;
        v2EventsRef.current = [];
        v2LastEventSeqRef.current = 0;
        v2RevisionRef.current = -1;
        fetchQueuedRef.current = false;
        setData(null);
        setLoading(true);
        setError(null);
        void fetchData();
        return () => {
            if (activeRequestIdRef.current === requestId) {
                activeRequestIdRef.current = null;
            }
            const inFlight = fetchInFlightRef.current;
            if (inFlight?.requestId === requestId) inFlight.controller.abort();
        };
    }, [fetchData, requestId]);

    useEffect(() => {
        if (
            data?.pipelineVersion !== 'v2'
            || data.status === 'completed'
            || data.status === 'failed'
        ) return;

        const refreshIfVisible = () => {
            if (document.visibilityState === 'visible') void fetchData();
        };
        const channel = supabase
            .channel(`analysis-v2-progress:${requestId}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'analysis_progress_state',
                filter: `request_id=eq.${requestId}`,
            }, refreshIfVisible)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'analysis_progress_events',
                filter: `request_id=eq.${requestId}`,
            }, refreshIfVisible)
            .subscribe(status => {
                if (status === 'SUBSCRIBED') refreshIfVisible();
            });

        return () => {
            void supabase.removeChannel(channel);
        };
    }, [data?.pipelineVersion, data?.status, fetchData, requestId, supabase]);

    // Realtime accelerates visible updates; this bounded poll closes any reconnect/event gaps.
    useEffect(() => {
        if (data?.status === 'completed' || data?.status === 'failed') return;
        const refreshIfVisible = () => {
            if (document.visibilityState === 'visible') void fetchData();
        };
        const interval = window.setInterval(refreshIfVisible, 5_000);
        document.addEventListener('visibilitychange', refreshIfVisible);
        return () => {
            window.clearInterval(interval);
            document.removeEventListener('visibilitychange', refreshIfVisible);
        };
    }, [data?.status, fetchData]);

    return { data, loading, error, refetch: fetchData };
}
