// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useAnalysisV2Preflight,
} from '@/hooks/useAnalysisV2Preflight';
import {
    readPreflightDisplayTarget,
    storePreflightDisplayTarget,
} from '@/lib/services/pending-analysis-target';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_PREFLIGHT_ID = '223e4567-e89b-42d3-a456-426614174000';
const EXPIRES_AT = '2030-08-14T12:00:00.000Z';

type PreflightHook = ReturnType<typeof useAnalysisV2Preflight>;

function pendingStatus(preflightId: string) {
    return {
        schemaVersion: 1,
        preflightId,
        expiresAt: EXPIRES_AT,
        status: 'pending',
        exclusionDecision: 'pending',
    } as const;
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(value => {
        resolve = value;
    });
    return { promise, resolve };
}

async function settleReact() {
    await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
}

function HookProbe({
    capture,
    timeline,
}: {
    capture: (value: PreflightHook) => void;
    timeline: string[];
}) {
    const value = useAnalysisV2Preflight();
    capture(value);
    timeline.push(value.preflight ? `render:${value.preflight.status}` : 'render:reset');
    if (value.error) timeline.push(`error:${value.error}`);
    return null;
}

describe('preflight terminal error runtime behavior', () => {
    let container: HTMLDivElement;
    let root: Root;
    let latest: PreflightHook | null;

    beforeEach(() => {
        window.sessionStorage.clear();
        latest = null;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        [410, 'PREFLIGHT_EXPIRED', 'preflight expired'],
        [401, 'UNAUTHORIZED', 'preflight unauthorized'],
    ] as const) (
        'clears the matching display target synchronously for terminal %s %s before reset',
        async (status, code, message) => {
            const terminalResponse = deferred<Response>();
            const timeline: string[] = [];
            storePreflightDisplayTarget(window.sessionStorage, {
                preflightId: PREFLIGHT_ID,
                target: 'target.name',
            });
            const nativeRemoveItem = Storage.prototype.removeItem;
            const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
                .mockImplementation(function (this: Storage, key) {
                    timeline.push(`remove:${key}`);
                    nativeRemoveItem.call(this, key);
                });
            const fetchMock = vi.fn(async () => {
                if (fetchMock.mock.calls.length === 1) {
                    return jsonResponse(pendingStatus(PREFLIGHT_ID));
                }
                return terminalResponse.promise;
            });
            vi.stubGlobal('fetch', fetchMock);

            act(() => {
                root.render(createElement(HookProbe, {
                    capture: value => { latest = value; },
                    timeline,
                }));
            });
            await act(async () => {
                await latest?.resumePreflight(PREFLIGHT_ID, 'target.name');
            });
            await settleReact();

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(latest?.preflight?.status).toBe('pending');
            timeline.length = 0;

            terminalResponse.resolve(jsonResponse({ code, error: message }, status));
            await settleReact();

            expect(readPreflightDisplayTarget(window.sessionStorage, {
                preflightId: PREFLIGHT_ID,
            })).toBeNull();
            expect(removeItem).toHaveBeenCalledWith('preflight_display_target_v1');
            const removeIndex = timeline.indexOf('remove:preflight_display_target_v1');
            const resetIndex = timeline.indexOf('render:reset');
            expect(removeIndex).toBeGreaterThanOrEqual(0);
            expect(resetIndex).toBeGreaterThan(removeIndex);
            expect(latest?.preflight).toBeNull();
            expect(latest?.error).toBe(message);
        },
    );

    it.each([
        [410, 'PREFLIGHT_EXPIRED', 'preflight expired'],
        [401, 'UNAUTHORIZED', 'preflight unauthorized'],
    ] as const) (
        'clears the matching display target on the initial terminal %s %s before error handling',
        async (status, code, message) => {
            const timeline: string[] = [];
            storePreflightDisplayTarget(window.sessionStorage, {
                preflightId: PREFLIGHT_ID,
                target: 'target.name',
            });
            const nativeRemoveItem = Storage.prototype.removeItem;
            const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
                .mockImplementation(function (this: Storage, key) {
                    timeline.push(`remove:${key}`);
                    nativeRemoveItem.call(this, key);
                });
            const fetchMock = vi.fn(async () => jsonResponse({
                code,
                error: message,
            }, status));
            vi.stubGlobal('fetch', fetchMock);

            act(() => {
                root.render(createElement(HookProbe, {
                    capture: value => { latest = value; },
                    timeline,
                }));
            });
            await act(async () => {
                await latest?.resumePreflight(PREFLIGHT_ID, 'target.name');
            });
            await settleReact();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(readPreflightDisplayTarget(window.sessionStorage, {
                preflightId: PREFLIGHT_ID,
            })).toBeNull();
            expect(removeItem).toHaveBeenCalledWith('preflight_display_target_v1');
            const removeIndex = timeline.indexOf('remove:preflight_display_target_v1');
            const errorIndex = timeline.indexOf(`error:${message}`);
            expect(removeIndex).toBeGreaterThanOrEqual(0);
            expect(errorIndex).toBeGreaterThan(removeIndex);
            expect(latest?.preflight).toBeNull();
            expect(latest?.error).toBe(message);
        },
    );

    it('retains the display target on a nonterminal initial resume error', async () => {
        storePreflightDisplayTarget(window.sessionStorage, {
            preflightId: PREFLIGHT_ID,
            target: 'target.name',
        });
        const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
        const fetchMock = vi.fn(async () => jsonResponse({
            code: 'RATE_LIMITED',
            error: 'try again later',
        }, 429));
        vi.stubGlobal('fetch', fetchMock);

        act(() => {
            root.render(createElement(HookProbe, {
                capture: value => { latest = value; },
                timeline: [],
            }));
        });
        await act(async () => {
            await latest?.resumePreflight(PREFLIGHT_ID, 'target.name');
        });
        await settleReact();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(removeItem).not.toHaveBeenCalled();
        expect(readPreflightDisplayTarget(window.sessionStorage, {
            preflightId: PREFLIGHT_ID,
        })).toBe('target.name');
    });

    it('does not clear a display target owned by another preflight on terminal polling error', async () => {
        const terminalResponse = deferred<Response>();
        const timeline: string[] = [];
        storePreflightDisplayTarget(window.sessionStorage, {
            preflightId: OTHER_PREFLIGHT_ID,
            target: 'other.target',
        });
        const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
        const fetchMock = vi.fn(async () => {
            if (fetchMock.mock.calls.length === 1) {
                return jsonResponse(pendingStatus(PREFLIGHT_ID));
            }
            return terminalResponse.promise;
        });
        vi.stubGlobal('fetch', fetchMock);

        act(() => {
            root.render(createElement(HookProbe, {
                capture: value => { latest = value; },
                timeline,
            }));
        });
        await act(async () => {
            await latest?.resumePreflight(PREFLIGHT_ID, 'target.name');
        });
        await settleReact();

        terminalResponse.resolve(jsonResponse({
            code: 'PREFLIGHT_EXPIRED',
            error: 'preflight expired',
        }, 410));
        await settleReact();

        expect(removeItem).not.toHaveBeenCalled();
        expect(readPreflightDisplayTarget(window.sessionStorage, {
            preflightId: OTHER_PREFLIGHT_ID,
        })).toBe('other.target');
    });

    it('retains the display target while a pending poll takes the retryable path', async () => {
        vi.useFakeTimers();
        storePreflightDisplayTarget(window.sessionStorage, {
            preflightId: PREFLIGHT_ID,
            target: 'target.name',
        });
        const fetchMock = vi.fn(async () => {
            if (fetchMock.mock.calls.length === 1) {
                return jsonResponse(pendingStatus(PREFLIGHT_ID));
            }
            throw new TypeError('network unavailable');
        });
        vi.stubGlobal('fetch', fetchMock);

        act(() => {
            root.render(createElement(HookProbe, {
                capture: value => { latest = value; },
                timeline: [],
            }));
        });
        await act(async () => {
            await latest?.resumePreflight(PREFLIGHT_ID, 'target.name');
        });
        await settleReact();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(latest?.preflight?.status).toBe('pending');
        expect(readPreflightDisplayTarget(window.sessionStorage, {
            preflightId: PREFLIGHT_ID,
        })).toBe('target.name');
    });
});
