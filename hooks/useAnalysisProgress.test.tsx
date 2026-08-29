// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisProgress } from './useAnalysisProgress';

const REQUEST_A = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_B = '223e4567-e89b-42d3-a456-426614174000';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    captureExceptionSafely: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/observability/sentry-capture', () => ({
    captureExceptionSafely: mocks.captureExceptionSafely,
}));

import type { ProgressEventV1, ProgressSnapshotV1 } from '@/lib/contracts/analysis-v2';

function snapshot(
    requestId: string,
    overrides: Partial<ProgressSnapshotV1> = {},
): ProgressSnapshotV1 {
    return {
        schemaVersion: 1,
        requestId,
        revision: 1,
        status: 'processing',
        progressBp: 0,
        backgroundProcessing: true,
        tracks: {
            relationshipAi: {
                state: 'running',
                stageCode: 'PROFILE_SCREENING',
                done: 0,
                total: 1,
                progressBp: 0,
            },
            interactions: {
                state: 'pending',
                stageCode: 'INTERACTIONS_QUEUED',
                done: 0,
                total: 1,
                progressBp: 0,
            },
            finalization: {
                state: 'pending',
                stageCode: 'FINALIZATION_QUEUED',
                done: 0,
                total: 1,
                progressBp: 0,
            },
        },
        activeProfile: {
            maskedUsername: 'a***',
            imageUrl: null,
            currentOrdinal: 10,
            totalCount: 30,
            callPhase: 'fetching',
        },
        candidateMedia: [],
        etaRange: { lowSeconds: 30, highSeconds: 90 },
        lastEventSeq: 0,
        ...overrides,
    };
}

function event(requestId: string, seq = 1, revision = 1): ProgressEventV1 {
    return {
        schemaVersion: 1,
        requestId,
        seq,
        revision,
        occurredAt: '2026-08-29T00:00:00.000Z',
        state: 'confirmed',
        eventCode: 'PROFILE_SCREENED',
        copyCode: 'PROFILE_SCREENED_CONFIRMED',
        aggregateCount: 1,
    };
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function Harness({
    requestId,
    onRefetch,
    onRender,
}: {
    requestId: string;
    onRefetch?: (refetch: () => Promise<void>) => void;
    onRender?: () => void;
}) {
    const { data, loading, refetch } = useAnalysisProgress(requestId);
    onRefetch?.(refetch);
    onRender?.();
    return <>
        <output data-testid="progress">{loading ? 'loading' : `${data?.status}:${data?.progress}`}</output>
        <output data-testid="history">{data?.events.length ?? -1}</output>
    </>;
}

describe('useAnalysisProgress V2 display lifecycle', () => {
    let root: Root;
    let container: HTMLDivElement;
    let current = new Map<string, ProgressSnapshotV1>();
    let currentEvents = new Map<string, ProgressEventV1[]>();
    let fetchUrls: string[] = [];
    let refetch: (() => Promise<void>) | undefined;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
        vi.setSystemTime(0);
        current = new Map([
            [REQUEST_A, snapshot(REQUEST_A, { lastEventSeq: 1 })],
            [REQUEST_B, snapshot(REQUEST_B, {
                activeProfile: null,
                tracks: {
                    relationshipAi: {
                        state: 'running',
                        stageCode: 'PROFILE_SCREENING',
                        done: 0,
                        total: 30,
                        progressBp: 0,
                    },
                    interactions: {
                        state: 'pending',
                        stageCode: 'INTERACTIONS_QUEUED',
                        done: 0,
                        total: 1,
                        progressBp: 0,
                    },
                    finalization: {
                        state: 'pending',
                        stageCode: 'FINALIZATION_QUEUED',
                        done: 0,
                        total: 1,
                        progressBp: 0,
                    },
                },
            })],
        ]);
        currentEvents = new Map([
            [REQUEST_A, [event(REQUEST_A)]],
            [REQUEST_B, []],
        ]);
        fetchUrls = [];
        const channel = {
            on: vi.fn().mockReturnThis(),
            subscribe: vi.fn().mockReturnValue({}),
        };
        mocks.createClient.mockReturnValue({
            channel: vi.fn().mockReturnValue(channel),
            removeChannel: vi.fn().mockResolvedValue(undefined),
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            fetchUrls.push(url);
            if (url.includes('/api/analysis/status/')) {
                const requestId = url.includes(REQUEST_B) ? REQUEST_B : REQUEST_A;
                return response({
                    code: 'V2_ROUTE_REQUIRED',
                    pipelineVersion: 'v2',
                    progressUrl: `/api/analysis/progress/${requestId}`,
                }, 409);
            }
            const requestId = url.includes(REQUEST_B) ? REQUEST_B : REQUEST_A;
            const afterSeq = Number(new URL(url, 'https://example.com')
                .searchParams.get('afterSeq') ?? 0);
            return response({
                schemaVersion: 1,
                snapshot: current.get(requestId),
                events: (currentEvents.get(requestId) ?? [])
                    .filter(item => item.seq > afterSeq),
            });
        }));
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    async function render(requestId = REQUEST_A, onRender?: () => void): Promise<void> {
        await act(async () => {
            root.render(<Harness
                requestId={requestId}
                onRefetch={value => { refetch = value; }}
                onRender={onRender}
            />);
            await Promise.resolve();
            await Promise.resolve();
        });
    }

    function displayed(): string {
        return container.querySelector('[data-testid="progress"]')?.textContent ?? '';
    }

    it('moves through initial and later visible plateaus and responds to phase and ordinal signals', async () => {
        await render();
        const initial = displayed();
        await act(async () => {
            vi.advanceTimersByTime(5_000);
            await Promise.resolve();
        });
        const first = displayed();
        await act(async () => {
            vi.advanceTimersByTime(5_000);
            await Promise.resolve();
        });
        const second = displayed();
        expect(initial).toBe('processing:0');
        expect(first).not.toBe(initial);
        expect(second).not.toBe(first);

        current.set(REQUEST_A, snapshot(REQUEST_A, {
            revision: 2,
            activeProfile: {
                maskedUsername: 'a***',
                imageUrl: null,
                currentOrdinal: 20,
                totalCount: 30,
                callPhase: 'analyzing',
            },
        }));
        await act(async () => { await refetch?.(); });
        // A changed ordinal/phase is a non-durable signal: it re-anchors at the
        // prior display and only moves on a later visible timer tick.
        expect(Number(displayed().split(':')[1])).toBe(Number(second.split(':')[1]));
        await act(async () => {
            vi.advanceTimersByTime(1_000);
            await Promise.resolve();
        });
        expect(Number(displayed().split(':')[1])).toBeGreaterThan(Number(second.split(':')[1]));
    });

    it('keeps sub-percent easing ticks out of React renders while integer progress advances', async () => {
        let renderCount = 0;
        await render(REQUEST_A, () => { renderCount += 1; });
        const settledRenderCount = renderCount;
        const initial = displayed();

        await act(async () => {
            vi.advanceTimersByTime(250);
            await Promise.resolve();
        });
        expect(displayed()).toBe(initial);
        expect(renderCount).toBe(settledRenderCount);

        await act(async () => {
            vi.advanceTimersByTime(2_250);
            await Promise.resolve();
        });
        expect(Number(displayed().split(':')[1])).toBeGreaterThan(0);
        expect(renderCount).toBeGreaterThan(settledRenderCount);
    });

    it('pauses hidden time, freezes a failure, resets by request, and reaches 100 only at completion', async () => {
        await render();
        await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
        const beforeHidden = displayed();

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
            vi.advanceTimersByTime(60_000);
            await Promise.resolve();
        });
        expect(displayed()).toBe(beforeHidden);

        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
        expect(displayed()).toBe(beforeHidden);
        await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
        const afterVisible = displayed();
        expect(Number(afterVisible.split(':')[1])).toBeGreaterThan(Number(beforeHidden.split(':')[1]));

        current.set(REQUEST_A, snapshot(REQUEST_A, {
            revision: 2,
            status: 'failed',
            progressBp: 500,
            activeProfile: null,
            etaRange: null,
        }));
        await act(async () => { await refetch?.(); });
        const failed = displayed();
        await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
        expect(displayed()).toBe(failed);

        await render(REQUEST_B);
        const reset = Number(displayed().split(':')[1]);
        expect(reset).toBeLessThan(Number(failed.split(':')[1]));
        expect(reset).toBeLessThan(10);

        current.set(REQUEST_B, snapshot(REQUEST_B, {
            revision: 2,
            status: 'completed',
            progressBp: 10_000,
            backgroundProcessing: false,
            tracks: {
                relationshipAi: {
                    state: 'completed', stageCode: 'RELATIONSHIP_AI_COMPLETE', done: 1, total: 1, progressBp: 10_000,
                },
                interactions: {
                    state: 'completed', stageCode: 'INTERACTIONS_COMPLETE', done: 1, total: 1, progressBp: 10_000,
                },
                finalization: {
                    state: 'completed', stageCode: 'FINALIZATION_COMPLETE', done: 1, total: 1, progressBp: 10_000,
                },
                },
            activeProfile: null,
            etaRange: null,
        }));
        await act(async () => { await refetch?.(); });
        expect(displayed()).toBe('completed:100');
    });

    it('preserves display progress while publication lag returns a queued snapshot, then reaches 100 after publication', async () => {
        await render();
        expect(container.querySelector('[data-testid="history"]')?.textContent).toBe('1');
        await act(async () => {
            vi.advanceTimersByTime(15_000);
            await Promise.resolve();
        });
        const beforePublicationLag = Number(displayed().split(':')[1]);
        expect(beforePublicationLag).toBeGreaterThan(0);

        current.set(REQUEST_A, snapshot(REQUEST_A, {
            revision: 2,
            status: 'queued',
            progressBp: 0,
            backgroundProcessing: true,
            activeProfile: null,
            candidateMedia: [],
            etaRange: null,
            tracks: {
                relationshipAi: {
                    state: 'pending',
                    stageCode: 'PENDING',
                    done: 0,
                    total: 0,
                    progressBp: 0,
                },
                interactions: {
                    state: 'pending',
                    stageCode: 'PENDING',
                    done: 0,
                    total: 0,
                    progressBp: 0,
                },
                finalization: {
                    state: 'pending',
                    stageCode: 'PENDING',
                    done: 0,
                    total: 0,
                    progressBp: 0,
                },
            },
            lastEventSeq: 0,
            publicationLagReset: true,
        }));
        currentEvents.set(REQUEST_A, []);
        await act(async () => { await refetch?.(); });
        expect(Number(displayed().split(':')[1])).toBeGreaterThanOrEqual(beforePublicationLag);
        expect(container.querySelector('[data-testid="history"]')?.textContent).toBe('0');

        await act(async () => {
            vi.advanceTimersByTime(10_000);
            await Promise.resolve();
        });
        expect(Number(displayed().split(':')[1])).toBe(beforePublicationLag);

        await act(async () => { await refetch?.(); });
        expect(fetchUrls.at(-1)).toContain('afterSeq=0');
        expect(container.querySelector('[data-testid="history"]')?.textContent).toBe('0');

        current.set(REQUEST_A, snapshot(REQUEST_A, {
            revision: 3,
            status: 'completed',
            progressBp: 10_000,
            backgroundProcessing: false,
            activeProfile: null,
            candidateMedia: [],
            etaRange: null,
            tracks: {
                relationshipAi: {
                    state: 'completed',
                    stageCode: 'RELATIONSHIP_AI_COMPLETE',
                    done: 1,
                    total: 1,
                    progressBp: 10_000,
                },
                interactions: {
                    state: 'completed',
                    stageCode: 'INTERACTIONS_COMPLETE',
                    done: 1,
                    total: 1,
                    progressBp: 10_000,
                },
                finalization: {
                    state: 'completed',
                    stageCode: 'FINALIZATION_COMPLETE',
                    done: 1,
                    total: 1,
                    progressBp: 10_000,
                },
            },
            lastEventSeq: 0,
        }));
        await act(async () => { await refetch?.(); });
        expect(displayed()).toBe('completed:100');
    });
});
