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
import {
    createProgressDisplayState,
    activeProgressTrackId,
    nextProgressCheckpointBp,
    pauseProgressDisplay,
    updateProgressDisplay,
    type ProgressDisplayInput,
    type ProgressDisplayState,
} from '@/lib/services/analysis/v2-progress-display';
import { createClient } from '@/lib/supabase/client';
import { captureExceptionSafely } from '@/lib/observability/sentry-capture';

interface AnalysisProgress {
    id: string;
    pipelineVersion: 'v1' | 'v2';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    errorMessage: string | null;
    backgroundProcessing: boolean;
    demo: boolean;
    tracks: ProgressSnapshotV1['tracks'] | null;
    activeProfile: ProgressSnapshotV1['activeProfile'];
    candidateMedia: ProgressSnapshotV1['candidateMedia'];
    etaRange: ProgressSnapshotV1['etaRange'];
    events: ProgressEventV1[];
}

function mapV2Status(status: ProgressSnapshotV1['status']): AnalysisProgress['status'] {
    if (status === 'queued') return 'pending';
    if (status === 'upgrade_required') return 'failed';
    return status;
}

type TeardownErrorReporter = (message?: unknown, ...optionalParams: unknown[]) => void;

function isAbortError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'name' in error
        && error.name === 'AbortError';
}

function displayInputForSnapshot(
    snapshot: ProgressSnapshotV1,
    nowMs: number,
    visible: boolean,
): ProgressDisplayInput {
    const active = snapshot.activeProfile;
    const activeTrackId = activeProgressTrackId(snapshot.tracks);
    const activeTrack = activeTrackId ? snapshot.tracks[activeTrackId] : null;
    return {
        confirmedProgressBp: snapshot.progressBp,
        tracks: snapshot.tracks,
        nextCheckpointBp: nextProgressCheckpointBp(snapshot.tracks, activeTrackId),
        status: snapshot.status,
        nowMs,
        visible,
        activeTrackId,
        activeStageCode: activeTrack?.stageCode ?? null,
        currentOrdinal: active?.currentOrdinal ?? null,
        totalCount: active?.totalCount ?? null,
        callPhase: active?.callPhase ?? null,
        signalKey: JSON.stringify([
            snapshot.revision,
            active?.candidateKey ?? null,
            active?.maskedUsername ?? null,
            active?.currentOrdinal ?? null,
            active?.totalCount ?? null,
            active?.callPhase ?? null,
        ]),
    };
}

function progressPercentFromBasisPoints(progressBp: number): number {
    return Math.min(100, Math.floor(progressBp / 100));
}

// Supabase can reject channel removal while React is tearing down the page.
// That cancellation is expected; every other cleanup failure remains observable.
export function reportAnalysisProgressChannelTeardownError(
    error: unknown,
    report: TeardownErrorReporter = console.error,
): void {
    if (isAbortError(error)) return;
    report('Failed to remove analysis progress channel:', error);
    captureExceptionSafely(error);
}

export function disposeAnalysisProgressChannel(
    removeChannel: () => unknown,
): void {
    try {
        void Promise.resolve(removeChannel())
            .catch(reportAnalysisProgressChannelTeardownError);
    } catch (error) {
        reportAnalysisProgressChannelTeardownError(error);
    }
}

export function useAnalysisProgress(requestId: string) {
    const [data, setData] = useState<AnalysisProgress | null>(null);
    const [outcome, setOutcome] = useState<{
        requestId: string;
        settled: boolean;
        error: string | null;
    }>({ requestId: '', settled: false, error: null });
    const hasDataRef = useRef(false);
    const v2ProgressUrlRef = useRef<string | null>(null);
    const v2EventsRef = useRef<ProgressEventV1[]>([]);
    const v2LastEventSeqRef = useRef(0);
    const v2RevisionRef = useRef(-1);
    const fetchQueuedRef = useRef(false);
    const v2DisplayStateRef = useRef<ProgressDisplayState>(
        createProgressDisplayState()
    );
    const v2DisplayInputRef = useRef<Omit<ProgressDisplayInput, 'nowMs' | 'visible'> | null>(null);
    const analyticsEligibleRef = useRef(true);
    const activeRequestIdRef = useRef<string | null>(null);
    const fetchInFlightRef = useRef<{
        requestId: string;
        controller: AbortController;
        promise: Promise<void>;
    } | null>(null);
    const fetchDataRef = useRef<() => Promise<void>>(() => Promise.resolve());
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
                analyticsEligibleRef.current = response.headers.get('x-analytics-eligible') !== '0';
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
                    analyticsEligibleRef.current = response.headers.get('x-analytics-eligible') !== '0';
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
                    const displayInput = displayInputForSnapshot(
                        progress.snapshot,
                        Date.now(),
                        document.visibilityState === 'visible',
                    );
                    v2DisplayInputRef.current = displayInput;
                    v2DisplayStateRef.current = updateProgressDisplay(
                        v2DisplayStateRef.current,
                        displayInput,
                    );
                    setData({
                        id: progress.snapshot.requestId,
                        pipelineVersion: 'v2',
                        status: mapV2Status(progress.snapshot.status),
                        progress: progressPercentFromBasisPoints(
                            v2DisplayStateRef.current.displayProgressBp
                        ),
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
                        demo: response.headers.get('x-analytics-eligible') === '0',
                        tracks: progress.snapshot.tracks,
                        activeProfile: progress.snapshot.activeProfile,
                        candidateMedia: progress.snapshot.candidateMedia,
                        etaRange: progress.snapshot.etaRange,
                        events: retainedEvents,
                    });
                    hasDataRef.current = true;
                    setOutcome({ requestId, settled: true, error: null });
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
                    demo: false,
                    tracks: null,
                    activeProfile: null,
                    candidateMedia: [],
                    etaRange: null,
                    events: [],
                });
                hasDataRef.current = true;
                setOutcome({ requestId, settled: true, error: null });
            } catch (err) {
                if (controller.signal.aborted) return;
                console.error('Failed to fetch analysis progress:', err);
                if (!hasDataRef.current) {
                    setOutcome({
                        requestId,
                        settled: true,
                        error: '분석 요청을 찾을 수 없습니다.',
                    });
                }
            }
        };

        const promise = run().finally(() => {
            if (fetchInFlightRef.current?.promise !== promise) return;
            fetchInFlightRef.current = null;
            const shouldRefetch = fetchQueuedRef.current;
            fetchQueuedRef.current = false;
            if (shouldRefetch && activeRequestIdRef.current === requestId) {
                void fetchDataRef.current();
            }
        });
        fetchInFlightRef.current = { requestId, controller, promise };
        return promise;
    }, [requestId]);

    useEffect(() => {
        fetchDataRef.current = fetchData;
    }, [fetchData]);

    useEffect(() => {
        activeRequestIdRef.current = requestId;
        fetchInFlightRef.current?.controller.abort();
        hasDataRef.current = false;
        v2ProgressUrlRef.current = null;
        v2EventsRef.current = [];
        v2LastEventSeqRef.current = 0;
        v2RevisionRef.current = -1;
        fetchQueuedRef.current = false;
        v2DisplayStateRef.current = createProgressDisplayState();
        v2DisplayInputRef.current = null;
        void fetchData();
        return () => {
            if (activeRequestIdRef.current === requestId) {
                activeRequestIdRef.current = null;
            }
            const inFlight = fetchInFlightRef.current;
            if (inFlight?.requestId === requestId) inFlight.controller.abort();
        };
    }, [fetchData, requestId]);

    const currentData = data?.id === requestId ? data : null;
    const currentOutcome = outcome.requestId === requestId ? outcome : null;

    useEffect(() => {
        if (
            currentData?.pipelineVersion !== 'v2'
            || currentData.status === 'completed'
            || currentData.status === 'failed'
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
            disposeAnalysisProgressChannel(() => supabase.removeChannel(channel));
        };
    }, [currentData?.pipelineVersion, currentData?.status, fetchData, requestId, supabase]);

    // Ease the presentation between durable checkpoints. This timer is local
    // display work only: it never changes the server snapshot or its revision.
    useEffect(() => {
        if (
            currentData?.pipelineVersion !== 'v2'
            || currentData.status === 'completed'
            || currentData.status === 'failed'
        ) return;
        const tick = () => {
            const base = v2DisplayInputRef.current;
            if (!base) return;
            const previous = v2DisplayStateRef.current;
            const next = updateProgressDisplay(
                previous,
                {
                    ...base,
                    nowMs: Date.now(),
                    visible: document.visibilityState === 'visible',
                },
            );
            v2DisplayStateRef.current = next;
            if (next.displayProgressBp === previous.displayProgressBp) return;
            setData(previous => previous?.id === requestId
                ? {
                    ...previous,
                    progress: progressPercentFromBasisPoints(next.displayProgressBp),
                }
                : previous);
        };
        const interval = window.setInterval(tick, 250);
        return () => window.clearInterval(interval);
    }, [currentData?.pipelineVersion, currentData?.status, requestId]);

    // Realtime accelerates visible updates; this bounded poll closes any reconnect/event gaps.
    useEffect(() => {
        if (currentData?.status === 'completed' || currentData?.status === 'failed') return;
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                void fetchData();
                return;
            }
            v2DisplayStateRef.current = pauseProgressDisplay(
                v2DisplayStateRef.current,
                Date.now(),
            );
        };
        const refreshIfVisible = () => {
            if (document.visibilityState === 'visible') void fetchData();
        };
        const interval = window.setInterval(refreshIfVisible, 5_000);
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            window.clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [currentData?.status, fetchData]);

    return {
        data: currentData,
        loading: currentOutcome?.settled !== true,
        error: currentOutcome?.error ?? null,
        refetch: fetchData,
    };
}
