// @vitest-environment jsdom
import { act, Suspense } from 'react';
import ProgressPage from '@/app/progress/[requestId]/page';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisProgress } from '../../../hooks/useAnalysisProgress';

const REQUEST_A = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_B = '223e4567-e89b-42d3-a456-426614174000';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    captureExceptionSafely: vi.fn(),
    push: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.PropsWithChildren<{ href: string }>) => <a href={href} {...props}>{children}</a> }));

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
    const { data, loading, refetch, error, errorKind, refreshing } = useAnalysisProgress(requestId);
    onRefetch?.(refetch);
    onRender?.();
    return <>
        <output data-testid="progress">{loading ? 'loading' : `${data?.status}:${data?.progress}`}</output>
        <output data-testid="history">{data?.events.length ?? -1}</output>
        <output data-testid="error-kind">{errorKind}</output>
        <output data-testid="error">{error}</output>
        <output data-testid="refreshing">{String(refreshing)}</output>
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
        vi.unstubAllEnvs();
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

    function errorKind(): string {
        return container.querySelector('[data-testid="error-kind"]')?.textContent ?? '';
    }

    async function renderPage(): Promise<void> {
        const params = Promise.resolve({ requestId: REQUEST_A });
        await act(async () => {
            root.render(<Suspense fallback="loading"><ProgressPage params={params} /></Suspense>);
            for (let count = 0; count < 10; count += 1) await Promise.resolve();
        });
    }

    async function clickPage(label: string): Promise<void> {
        const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
        expect(button).toBeDefined();
        await act(async () => { button!.click(); for (let count = 0; count < 10; count += 1) await Promise.resolve(); });
    }

    it.each(['gateway', 'network'] as const)('recovers an initial %s error with a shared GET retry and no new execution', async failure => {
        const fetchSpy = vi.mocked(fetch);
        if (failure === 'gateway') fetchSpy.mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }));
        else fetchSpy.mockRejectedValueOnce(new TypeError('raw network details'));
        await render();
        expect(errorKind()).toBe('transient');
        expect(displayed()).not.toContain('loading');
        expect(container.textContent).not.toContain('raw network details');
        let resolveRead!: (value: Response) => void;
        fetchSpy.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
        const callsBeforeRetry = fetchSpy.mock.calls.length;
        let first!: Promise<void>;
        await act(async () => { first = refetch!(); expect(refetch!()).toBe(first); });
        expect(container.querySelector('[data-testid="refreshing"]')?.textContent).toBe('true');
        await act(async () => {
            resolveRead(response({ code: 'V2_ROUTE_REQUIRED', pipelineVersion: 'v2', progressUrl: `/api/analysis/progress/${REQUEST_A}` }, 409));
            await first;
        });
        expect(errorKind()).toBe('');
        expect(displayed()).toContain('processing:');
        expect(container.querySelector('[data-testid="refreshing"]')?.textContent).toBe('false');
        expect(fetchSpy.mock.calls.length - callsBeforeRetry).toBe(2);
        expect(fetchSpy.mock.calls.every(([url, init]) => String(url).startsWith('/api/analysis/') && (init?.method ?? 'GET') === 'GET')).toBe(true);
    });

    it.each([1, 2])('clears a later transient notice after revision %i without regressing retained progress', async revision => {
        current.set(REQUEST_A, snapshot(REQUEST_A, { revision: 2, progressBp: 1200, lastEventSeq: 1 }));
        await render();
        const before = displayed();
        vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network disconnected'));
        await act(async () => { await refetch!(); });
        expect(errorKind()).toBe('transient');
        expect(displayed()).toBe(before);
        current.set(REQUEST_A, snapshot(REQUEST_A, { revision, progressBp: revision === 1 ? 0 : 1200 }));
        await act(async () => { await refetch!(); });
        expect(errorKind()).toBe('');
        expect(displayed()).toBe(before);
        expect(container.querySelector('[data-testid="history"]')?.textContent).toBe('1');
    });

    it.each([[404, 'not_found'], [401, 'unauthorized'], [403, 'forbidden']] as const)('clears owner data on HTTP %i and stops automatic retries', async (status, kind) => {
        await render();
        vi.mocked(fetch).mockResolvedValueOnce(new Response('private raw body', { status }));
        await act(async () => { await refetch!(); });
        expect(errorKind()).toBe(kind);
        expect(displayed()).toBe('undefined:undefined');
        expect(container.textContent).not.toContain('private raw body');
        const callCount = vi.mocked(fetch).mock.calls.length;
        await act(async () => { vi.advanceTimersByTime(10_000); document.dispatchEvent(new Event('visibilitychange')); });
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(callCount);
    });

    it('ignores a late old response and an old retry callback after switching requests', async () => {
        await render();
        const oldRefetch = refetch!;
        let resolveRead!: (value: Response) => void;
        vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
        let pending!: Promise<void>;
        await act(async () => { pending = oldRefetch(); });
        await render(REQUEST_B);
        const before = displayed();
        const calls = vi.mocked(fetch).mock.calls.length;
        await act(async () => {
            resolveRead(response({ schemaVersion: 1, snapshot: snapshot(REQUEST_A, { revision: 999, status: 'failed' }), events: [] }));
            await pending;
            await oldRefetch();
        });
        expect(displayed()).toBe(before);
        expect(errorKind()).toBe('');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
        await act(async () => { await refetch!(); });
        expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain(REQUEST_B);
    });

    it('ignores stale route discovery after its JSON body resolves for a previous request', async () => {
        let resolveBody!: (value: unknown) => void;
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: false, status: 409, headers: new Headers(),
            json: () => new Promise(resolve => { resolveBody = resolve; }),
        } as Response);
        await render();
        expect(displayed()).toBe('loading');
        await render(REQUEST_B);
        const calls = vi.mocked(fetch).mock.calls.length;
        await act(async () => {
            resolveBody({ code: 'V2_ROUTE_REQUIRED', pipelineVersion: 'v2', progressUrl: `/api/analysis/progress/${REQUEST_A}` });
            for (let count = 0; count < 5; count += 1) await Promise.resolve();
        });
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
        await act(async () => { await refetch!(); });
        expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain(REQUEST_B);
        expect(displayed()).toContain('processing:');
    });

    it('rejects a snapshot for a different request without publishing its owner data', async () => {
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        vi.mocked(fetch).mockResolvedValueOnce(response({ schemaVersion: 1, snapshot: snapshot(REQUEST_B), events: [] }));
        await render();
        expect(errorKind()).toBe('transient');
        expect(displayed()).toBe('undefined:undefined');
    });

    it('presents parallel work, accessible overall progress and explicit profile ordinal without track counts', async () => {
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        const base = snapshot(REQUEST_A, { progressBp: 2500, lastEventSeq: 1 });
        current.set(REQUEST_A, { ...base, tracks: {
            ...base.tracks,
            relationshipAi: { state: 'running', stageCode: 'PROFILE_SCREENING', done: 25, total: 100, progressBp: 2500 },
            interactions: { state: 'running', stageCode: 'INTERACTIONS_RUNNING', done: 50, total: 100, progressBp: 5000 },
        } });
        await renderPage();
        const meter = container.querySelector('[role="progressbar"]');
        expect(meter?.getAttribute('aria-label')).toBe('전체 진행률');
        expect(meter?.getAttribute('aria-valuenow')).toBe('25');
        expect(meter?.getAttribute('aria-valuemin')).toBe('0');
        expect(meter?.getAttribute('aria-valuemax')).toBe('100');
        expect(container.querySelector('h1')?.textContent).toBe('맞팔 계정을 판독하고 있습니다.');
        const rows = [...container.querySelectorAll('li')].map(row => row.textContent);
        expect(rows).toEqual(['맞팔·AI 판독진행 중', '위험 단서 수집진행 중', '위험도·총평 정리대기']);
        expect(container.textContent).toContain('현재 10번째 / 대상 30개');
        expect(container.textContent).not.toMatch(/25 \/ 100|50%|50 \/ 100/);
        expect(container.textContent).toContain('테스트 분석은 약 45초 동안 진행돼요');
        expect(container.querySelector('a[href="/mypage"]')?.textContent).toContain('보관함으로 이동');
        expect(mocks.push).not.toHaveBeenCalled();
        expect(vi.mocked(fetch).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    });

    it('keeps production demo reads on variable timing and hides partial profile counts', async () => {
        current.set(REQUEST_A, snapshot(REQUEST_A, { lastEventSeq: 1, activeProfile: { maskedUsername: 'a***', imageUrl: null, currentOrdinal: 10 } }));
        const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
        vi.mocked(fetch).mockImplementation(async (...args) => {
            const result = await defaultFetch(...args);
            result.headers.set('x-analytics-eligible', '0');
            return result;
        });
        await renderPage();
        expect(container.textContent).toContain('계정 규모와 수집 상황에 따라 판독 시간이 달라질 수 있어요');
        expect(container.textContent).not.toContain('45초');
        expect(container.textContent).not.toContain('현재 10번째');
        expect(container.textContent).not.toContain('대상 30개');

    });

    it('keeps the page open for client-driven work without an archive exit CTA', async () => {
        vi.mocked(fetch).mockImplementation(async (url) => {
            if (url === '/api/analysis/step') return new Promise<Response>(() => undefined);
            return response({ requestId: REQUEST_A, pipelineVersion: 'v1', status: 'processing', progress: 25,
                progressStep: '판독 중', errorMessage: null, backgroundProcessing: false });
        });
        await renderPage();
        expect(container.querySelector('a[href="/mypage"]')).toBeNull();
        expect(container.textContent).toContain('이 페이지를 닫지 마세요');
    });

    it('keeps the progress view visible on later 503 and disables its GET-only retry while in flight', async () => {
        await renderPage();
        const heading = container.querySelector('h1')?.textContent;
        vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }));
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(container.querySelector('h1')?.textContent).toBe(heading);
        expect(container.textContent).toContain('마지막으로 확인한 진행 상황');
        let resolveRead!: (value: Response) => void;
        vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
        await clickPage('다시 조회');
        const button = [...container.querySelectorAll('button')].find(item => item.textContent === '조회 중…');
        expect(button?.disabled).toBe(true);
        const calls = vi.mocked(fetch).mock.calls.length;
        await act(async () => { button!.click(); });
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
        await act(async () => { resolveRead(response({ schemaVersion: 1, snapshot: current.get(REQUEST_A), events: [] })); });
        expect(container.textContent).not.toContain('마지막으로 확인한 진행 상황');
        expect(mocks.push).not.toHaveBeenCalled();
        expect(vi.mocked(fetch).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    });

    it('continues the existing run on revisit and navigates to its result only after completion', async () => {
        current.set(REQUEST_A, snapshot(REQUEST_A, { progressBp: 9200, lastEventSeq: 1, activeProfile: null }));
        await renderPage();
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('92');
        expect(mocks.push).not.toHaveBeenCalled();
        await act(async () => { root.render(null); });
        await renderPage();
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('92');
        current.set(REQUEST_A, snapshot(REQUEST_A, {
            revision: 2, status: 'completed', progressBp: 10000, lastEventSeq: 1, activeProfile: null,
            tracks: {
                relationshipAi: { state: 'completed', stageCode: 'RELATIONSHIP_AI_COMPLETE', done: 1, total: 1, progressBp: 10000 },
                interactions: { state: 'completed', stageCode: 'INTERACTIONS_COMPLETE', done: 1, total: 1, progressBp: 10000 },
                finalization: { state: 'completed', stageCode: 'FINALIZATION_COMPLETE', done: 1, total: 1, progressBp: 10000 },
            },
        }));
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
        expect([...container.querySelectorAll('li')].every(row => row.textContent?.endsWith('완료'))).toBe(true);
        expect(mocks.push).toHaveBeenCalledWith(`/result/${REQUEST_A}?pipeline=v2`);
        expect(vi.mocked(fetch).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    });

    it.each(['failed', 'missing'] as const)('offers a new analysis for %s instead of retrying the run', async state => {
        if (state === 'failed') current.set(REQUEST_A, snapshot(REQUEST_A, { status: 'failed', activeProfile: null, lastEventSeq: 1 }));
        else vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
        await renderPage();
        expect(container.querySelector('a[href="/mypage"]')).toBeNull();
        expect(container.textContent).not.toContain('다시 조회');
        const calls = vi.mocked(fetch).mock.calls.length;
        await clickPage('새 분석 시작하기');
        expect(mocks.push).toHaveBeenCalledWith('/analyze');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
    });

    it('offers a safe initial retry and a login return path for an expired session', async () => {
        vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
        await renderPage();
        expect(container.textContent).toContain('다시 조회');
        expect(container.querySelector('a[href="/mypage"]')).toBeNull();
        vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
        await clickPage('다시 조회');
        await clickPage('로그인하기');
        expect(mocks.push).toHaveBeenCalledWith(`/login?redirectTo=${encodeURIComponent(`/progress/${REQUEST_A}`)}`);
    });

    it('polls the exact Dev resource directly without production discovery or Realtime clients', async () => {
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        await render();
        expect(fetchUrls[0]).toBe(`/api/analysis/v2/progress/${REQUEST_A}?afterSeq=0&limit=200`);
        expect(fetchUrls.every(url => url.startsWith('/api/analysis/v2/progress/'))).toBe(true);
        expect(mocks.createClient).not.toHaveBeenCalled();
        expect(displayed()).toContain('processing:');
    });

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
