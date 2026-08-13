// @vitest-environment jsdom

import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRECHECKOUT_DEMO_DURATION_MS,
    PRECHECKOUT_DEMO_STAGE_DURATIONS_MS,
    PrecheckoutDemo,
} from './precheckout-demo';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const DEMO_DURATION_MS = PRECHECKOUT_DEMO_DURATION_MS;

function stubMatchMedia(matches: (query: string) => boolean = () => false) {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })));
}

async function advanceTimersBy(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
}

describe('PrecheckoutDemo', () => {
    let container: HTMLDivElement;
    let root: Root;
    let rafCallback: FrameRequestCallback | null;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        stubMatchMedia();
        rafCallback = null;
        vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
            rafCallback = cb;
            return 1;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        document.body.style.overflow = '';
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('renders four ordered stages with an announced current stage and no skip control', async () => {
        const onComplete = vi.fn();
        const onError = vi.fn();

        expect(PRECHECKOUT_DEMO_STAGE_DURATIONS_MS).toEqual([2_600, 2_700, 2_500, 2_600]);
        expect(PRECHECKOUT_DEMO_DURATION_MS).toBe(12_000);

        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'success',
                startedAtMs: 0,
                onComplete,
                onError,
            }));
        });

        expect(container.querySelectorAll('.precheckout-stage-graphs i')).toHaveLength(4);
        expect(container.querySelector('button')).toBeNull();
        expect(container.textContent).not.toMatch(/skip|건너뛰기/i);

        const status = container.querySelector('[role="status"]');
        expect(status?.getAttribute('aria-live')).toBe('polite');
        expect(status?.getAttribute('aria-atomic')).toBe('true');
        expect(status?.textContent).toContain('1/4');
        expect(onComplete).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();

        await act(async () => {
            vi.setSystemTime(0);
            rafCallback?.(0);
            vi.setSystemTime(2_600);
            rafCallback?.(2_600);
        });
        expect(status?.textContent).toContain('2/4');
        await act(async () => {
            vi.setSystemTime(5_300);
            rafCallback?.(5_300);
        });
        expect(status?.textContent).toContain('3/4');
        await act(async () => {
            vi.setSystemTime(7_800);
            rafCallback?.(7_800);
        });
        expect(status?.textContent).toContain('4/4');
    });

    it('runs both modes for exactly 12,000ms and completes exactly once without Instagram work', async () => {
        const onComplete = vi.fn();
        const onError = vi.fn();
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'success',
                startedAtMs: 0,
                onComplete,
                onError,
            }));
        });

        expect(container.querySelector('[data-precheckout-demo-mode="success"]')).not.toBeNull();
        await advanceTimersBy(DEMO_DURATION_MS - 1);
        expect(onComplete).not.toHaveBeenCalled();
        await advanceTimersBy(1);
        expect(onComplete).toHaveBeenCalledTimes(1);
        await advanceTimersBy(DEMO_DURATION_MS * 2);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();

        act(() => root.unmount());
        root = createRoot(container);
        vi.setSystemTime(0);
        const fallbackComplete = vi.fn();
        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete: fallbackComplete,
                onError,
            }));
        });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(container.querySelectorAll('.precheckout-stage-graphs i')).toHaveLength(4);
        await advanceTimersBy(DEMO_DURATION_MS);
        expect(fallbackComplete).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it('does not duplicate completion when StrictMode replays effects', async () => {
        const onComplete = vi.fn();

        await act(async () => {
            root.render(createElement(StrictMode, null, createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete,
                onError: vi.fn(),
            })));
        });

        await advanceTimersBy(DEMO_DURATION_MS);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('does not reset the absolute stage timeline when StrictMode replays effects', async () => {
        const onComplete = vi.fn();

        await act(async () => {
            root.render(createElement(StrictMode, null, createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete,
                onError: vi.fn(),
            })));
        });

        await advanceTimersBy(10_000);
        await act(async () => {
            rafCallback?.(0);
        });
        expect(container.querySelector('[role="status"]')?.textContent).toContain('4/4');
        await advanceTimersBy(DEMO_DURATION_MS - 10_001);
        expect(onComplete).not.toHaveBeenCalled();
        await advanceTimersBy(1);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('keeps the original demo deadline across a remount', async () => {
        const firstComplete = vi.fn();
        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete: firstComplete,
                onError: vi.fn(),
            }));
        });
        await advanceTimersBy(10_000);
        expect(firstComplete).not.toHaveBeenCalled();

        act(() => root.unmount());
        root = createRoot(container);
        const remountComplete = vi.fn();
        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete: remountComplete,
                onError: vi.fn(),
            }));
        });
        expect(container.querySelector('[role="status"]')?.textContent).toContain('4/4');
        await advanceTimersBy(DEMO_DURATION_MS - 10_001);
        expect(remountComplete).not.toHaveBeenCalled();
        await advanceTimersBy(1);
        expect(remountComplete).toHaveBeenCalledTimes(1);
    });

    it('locks mobile body scrolling and restores the previous overflow on cleanup', async () => {
        document.body.style.overflow = 'scroll';
        stubMatchMedia(query => query.includes('max-width'));

        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete: vi.fn(),
                onError: vi.fn(),
            }));
        });
        expect(document.body.style.overflow).toBe('hidden');

        act(() => root.unmount());
        root = createRoot(container);
        expect(document.body.style.overflow).toBe('scroll');
    });

    it('keeps the 12-second contract under reduced motion', async () => {
        stubMatchMedia(query => query.includes('prefers-reduced-motion'));
        const onComplete = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'success',
                startedAtMs: 0,
                onComplete,
                onError: vi.fn(),
            }));
        });

        await advanceTimersBy(DEMO_DURATION_MS - 1);
        expect(onComplete).not.toHaveBeenCalled();
        await advanceTimersBy(1);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it.each(['success', 'fallback'] as const)('reports an animation-frame runtime failure through onError in %s mode', async mode => {
        const onError = vi.fn();
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => {
            throw new Error('animation runtime unavailable');
        }));

        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode,
                startedAtMs: 0,
                onComplete: vi.fn(),
                onError,
            }));
        });

        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('reports a render-boundary error once and exposes an accessible alert', async () => {
        vi.resetModules();
        vi.doMock('./precheckout-stage-graphs', () => ({
            PRECHECKOUT_DEMO_DURATION_MS: DEMO_DURATION_MS,
            PRECHECKOUT_DEMO_STAGE_DURATIONS_MS: [2_600, 2_700, 2_500, 2_600],
            PrecheckoutStageGraphs: () => {
                throw new Error('demo asset unavailable');
            },
        }));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const [react, reactDom, brokenModule] = await Promise.all([
            import('react'),
            import('react-dom/client'),
            import('./precheckout-demo'),
        ]);
        const brokenRoot = reactDom.createRoot(container);

        await react.act(async () => {
            brokenRoot.render(react.createElement(brokenModule.PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete: vi.fn(),
                onError: vi.fn(),
            }));
        });

        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        expect(consoleError).toHaveBeenCalled();
        await react.act(async () => brokenRoot.unmount());
        vi.doUnmock('./precheckout-stage-graphs');
        vi.resetModules();
    });

    it('routes completion callback failures to onError without retrying completion', async () => {
        const onComplete = vi.fn(() => {
            throw new Error('runtime failure');
        });
        const onError = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutDemo, {
                mode: 'fallback',
                startedAtMs: 0,
                onComplete,
                onError,
            }));
        });
        await advanceTimersBy(DEMO_DURATION_MS);
        await advanceTimersBy(DEMO_DURATION_MS);

        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
    });
});
