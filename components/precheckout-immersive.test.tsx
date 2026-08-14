// @vitest-environment jsdom

import { act, createElement, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    PRECHECKOUT_BLITE_SCHEMA_VERSION,
} from '@/lib/services/precheckout/blite-contract';

const analyticsMocks = vi.hoisted(() => ({
    PRECHECKOUT_EVENTS: {
        BLITE_AVAILABLE: 'precheckout_blite_available',
        BLITE_RESULT_VIEWED: 'precheckout_blite_result_viewed',
        BLITE_FALLBACK_SELECTED: 'precheckout_blite_fallback_selected',
        BLITE_GENDER_CONFIRMATION_COMPLETED: 'precheckout_blite_gender_confirmation_completed',
        BLITE_PREVIEW_CTA_CLICKED: 'precheckout_blite_preview_cta_clicked',
        DEMO_STARTED: 'precheckout_demo_started',
        DEMO_COMPLETED: 'precheckout_demo_completed',
        DEMO_FAILED: 'precheckout_demo_failed',
        PLAN_GATE_REACHED: 'precheckout_plan_gate_reached',
    },
    trackPrecheckoutEvent: vi.fn(),
}));

vi.mock('@/lib/services/analytics', () => analyticsMocks);

import {
    PrecheckoutImmersive,
    __resetBrowserBliteRequestsForTest,
} from './precheckout-immersive';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBMITTED_AT = '2026-08-13T00:00:00.000Z';

function signal(overrides: Partial<{
    claim: string;
    category: string;
    confidence: number;
    band: 'high' | 'medium' | 'low';
}> = {}) {
    return {
        claim: '최근 게시물에서 관계를 자주 태그하는 경향이 보여요.',
        category: '관계 노출 성향',
        confidence: 0.62,
        band: 'medium' as const,
        ...overrides,
    };
}

function validDto(overrides: Partial<{ likelyFemale: boolean; confidence: number }> = {}) {
    return {
        schemaVersion: PRECHECKOUT_BLITE_SCHEMA_VERSION,
        persona: {
            headline: '관계를 자주 드러내는 활발한 소통형 계정',
            summary: '최근 게시물 패턴을 보면 태그와 멘션을 통해 주변 관계를 자주 드러내는 편이에요. 참고용 페르소나이며 확정적인 결론은 아니에요.',
        },
        signals: [
            signal({ claim: '태그된 사람과의 관계를 자주 드러내는 편이에요.', confidence: 0.82, band: 'high' as const }),
            signal({ claim: '캐러셀 게시물을 자주 활용해요.', category: '게시 습관', confidence: 0.62, band: 'medium' as const }),
            signal({ claim: '해시태그 사용이 적은 편이에요.', category: '게시 습관', confidence: 0.35, band: 'low' as const }),
            signal({ claim: '댓글 반응을 활발히 유도하는 캡션을 써요.', category: '소통 성향', confidence: 0.71, band: 'high' as const }),
        ],
        candidateRange: { min: 3, max: 9 },
        genderRead: {
            likelyFemale: overrides.likelyFemale ?? true,
            confidence: overrides.confidence ?? 0.81,
            reasons: [
                '캡션 어투가 여성형 표현에 가까워요.',
                '태그된 계정 구성이 여성형 이름에 가까워요.',
                '게시물 주제가 여성형 관심사에 가까워요.',
            ],
        },
        postCount: 8,
        evidenceFields: ['post.caption', 'post.hashtags', 'post.taggedUsers'],
    };
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function noBody(status = 204): Response {
    return new Response(null, { status });
}

function completeStatus(dto = validDto(), submittedAt = new Date().toISOString()) {
    return { state: 'complete' as const, submittedAt, dto };
}

function pendingStatus({
    submittedAt = new Date().toISOString(),
    fallbackAt = new Date(Date.parse(submittedAt) + 48_000).toISOString(),
    retryAfterMs = 5_000,
}: Partial<{ submittedAt: string; fallbackAt: string; retryAfterMs: number }> = {}) {
    return { state: 'pending' as const, submittedAt, fallbackAt, retryAfterMs };
}

function failedStatus({
    submittedAt = new Date().toISOString(),
    fallbackAt = new Date(Date.parse(submittedAt) + 48_000).toISOString(),
}: Partial<{ submittedAt: string; fallbackAt: string }> = {}) {
    return { state: 'failed' as const, submittedAt, fallbackAt };
}

async function settleUi() {
    await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')]
        .find(candidate => candidate.textContent?.trim() === label);
    if (!found) throw new Error(`button not found: ${label}`);
    return found;
}

async function clickButton(container: HTMLElement, label: string) {
    await act(async () => {
        button(container, label).click();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
}

/** Neither reduced-motion nor the mobile breakpoint match unless a test overrides it. */
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

describe('PrecheckoutImmersive', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        __resetBrowserBliteRequestsForTest();
        analyticsMocks.trackPrecheckoutEvent.mockReset();
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        stubMatchMedia();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        document.body.style.overflow = '';
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('renders nothing when the API answers 204 (feature unavailable)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody(204)));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(container.innerHTML).toBe('');
    });

    it('does not pin a transient unavailable response in the browser request map', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(noBody(204))
            .mockResolvedValueOnce(jsonResponse(completeStatus()));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { key: 'first', preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();
        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { key: 'second', preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain('이 계정의 인물이 남자가 맞나요?');
    });

    it('renders nothing when the 200 body fails schema validation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1, nonsense: true })));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(container.innerHTML).toBe('');
    });

    it('shows the gender confirmation screen at/above the likely-female confidence threshold', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            completeStatus(validDto({ likelyFemale: true, confidence: PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD }))
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(container.textContent).toContain('이 계정의 인물이 남자가 맞나요?');
    });

    it('skips the confirmation screen below the confidence threshold', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            completeStatus(validDto({ likelyFemale: true, confidence: PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD - 0.01 }))
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(container.textContent).not.toContain('이 계정의 인물이 남자가 맞나요?');
        expect(container.textContent).toContain('관계 판독 미리보기');
    });

    it('아니오 dismisses the whole preview and leaves the page renderable again', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeStatus())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();
        expect(container.textContent).toContain('이 계정의 인물이 남자가 맞나요?');

        await clickButton(container, '아니오');

        expect(container.innerHTML).toBe('');
    });

    it('예 proceeds to the B-lite result screen', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeStatus())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        await clickButton(container, '예');

        expect(container.textContent).toContain('관계를 자주 드러내는 활발한 소통형 계정');
        expect(container.textContent).toContain('분석 후보 예상 범위 3 – 9명');
    });

    it('runs the success demo for exactly 12 seconds before revealing plans', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onGoToPlans = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            completeStatus(validDto({ likelyFemale: false }))
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans }));
        });
        await settleUi();
        await clickButton(container, '관계 판독 미리보기');

        expect(container.querySelector('[data-precheckout-demo-mode="success"]')).not.toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(11_999);
        });
        expect(onGoToPlans).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(1);
        });

        expect(onGoToPlans).toHaveBeenCalledTimes(1);
    });

    it('starts the fallback demo on a terminal durable failure and reveals plans at failure plus 12 seconds', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onGoToPlans = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(failedStatus())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans }));
        });
        await settleUi();
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(11_999);
        });
        expect(onGoToPlans).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(onGoToPlans).toHaveBeenCalledTimes(1);
    });

    it('refreshes an immediate durable fallback failure after remount instead of retaining a stale pending path', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
            jsonResponse(failedStatus({ submittedAt: SUBMITTED_AT })),
        ));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                key: 'missing-source-first', preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                key: 'missing-source-refresh', preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
    });

    it('latches pending work to the original T+48 deadline and never displays a late result', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(pendingStatus(), 202)));
        const onGoToPlans = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans }));
        });
        await settleUi();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(48_000);
        });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
        expect(onGoToPlans).toHaveBeenCalledTimes(1);
    });

    it('sends the anonymous claim token header when claimToken is provided', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeStatus(validDto({ likelyFemale: false }))));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: 'anon-claim-token-abc',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = options.headers as Record<string, string>;
        expect(headers['x-preflight-claim-token']).toBe('anon-claim-token-abc');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('reports availability only after a valid B-lite payload arrives', async () => {
        const onAvailabilityChange = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeStatus(validDto({ likelyFemale: false })))));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
                onAvailabilityChange,
            }));
        });
        await settleUi();

        expect(onAvailabilityChange).toHaveBeenNthCalledWith(1, true);
        expect(onAvailabilityChange).toHaveBeenLastCalledWith(true);
    });

    it('releases the plan gate when B-lite is unavailable', async () => {
        const onAvailabilityChange = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
                onAvailabilityChange,
            }));
        });
        await settleUi();

        expect(onAvailabilityChange).toHaveBeenCalledOnce();
        expect(onAvailabilityChange).toHaveBeenLastCalledWith(false);
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_plan_gate_reached',
            PREFLIGHT_ID,
        );
    });

    it('keeps the plan gate closed through a transient status failure and retries to the authoritative T+48 clock', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onAvailabilityChange = vi.fn();
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('network unavailable'))
            .mockResolvedValueOnce(jsonResponse(pendingStatus({ submittedAt: SUBMITTED_AT }), 202));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
                onAvailabilityChange,
            }));
        });
        await settleUi();
        expect(onAvailabilityChange).not.toHaveBeenCalledWith(false);
        expect(container.innerHTML).toBe('');

        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        await settleUi();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(onAvailabilityChange).not.toHaveBeenCalledWith(false);

        await act(async () => { await vi.advanceTimersByTimeAsync(48_000); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
    });

    it('uses the original preflight clock when every status request is transient and starts the exact T+48 fallback demo', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onGoToPlans = vi.fn();
        const onAvailabilityChange = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                onGoToPlans,
                onAvailabilityChange,
            }));
        });
        await settleUi();
        expect(onAvailabilityChange).not.toHaveBeenCalledWith(false);
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).toBeNull();

        await act(async () => { await vi.advanceTimersByTimeAsync(47_999); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(11_999); });
        expect(onGoToPlans).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(onGoToPlans).toHaveBeenCalledOnce();
    });

    it('starts the fallback demo by the local deadline when anonymous status polling never yields a submission clock', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        await act(async () => { await vi.advanceTimersByTimeAsync(48_000); });

        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
    });

    it.each([
        ['pending', jsonResponse(pendingStatus({ submittedAt: SUBMITTED_AT }), 202)],
        ['failed', jsonResponse(failedStatus({ submittedAt: SUBMITTED_AT }))],
        ['complete', jsonResponse(completeStatus(validDto({ likelyFemale: false }), SUBMITTED_AT))],
    ] as const)('ignores a late %s response after an anonymous fallback latch', async (_state, lateResponse) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onAvailabilityChange = vi.fn();
        const onGoToPlans = vi.fn();
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans,
                onAvailabilityChange,
            }));
        });
        await settleUi();

        await act(async () => { await vi.advanceTimersByTimeAsync(48_000); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();

        fetchMock.mockResolvedValue(lateResponse);
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        await settleUi();

        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(onAvailabilityChange).not.toHaveBeenCalled();
        expect(onGoToPlans).not.toHaveBeenCalled();
        expect(analyticsMocks.trackPrecheckoutEvent).not.toHaveBeenCalledWith(
            'precheckout_plan_gate_reached',
            PREFLIGHT_ID,
        );
    });

    it('handles a fetch rejection caused by its aborted signal without an unhandled rejection', async () => {
        vi.useFakeTimers();
        const unhandledRejection = vi.fn();
        const abortObserved = vi.fn();
        const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) throw new Error('expected an AbortSignal');
                signal.addEventListener('abort', () => {
                    abortObserved(signal.aborted);
                    reject(new Error('fetch aborted because the supplied signal was aborted'));
                }, { once: true });
            })
        ));
        vi.stubGlobal('fetch', fetchMock);
        window.addEventListener('unhandledrejection', unhandledRejection);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(abortObserved).toHaveBeenCalledWith(true);
        expect(unhandledRejection).not.toHaveBeenCalled();
        window.removeEventListener('unhandledrejection', unhandledRejection);
    });

    it('replaces a provisional local clock with a late authoritative submission clock and preserves its T+48 deadline across remount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-13T00:00:10.000Z'));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
            jsonResponse(pendingStatus({ submittedAt: SUBMITTED_AT }), 202)
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                key: 'provisional',
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                key: 'authoritative-remount',
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        await act(async () => { await vi.advanceTimersByTimeAsync(37_999); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
    });

    it('does not report 204 unavailable while the fallback demo is running', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onAvailabilityChange = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pendingStatus({ submittedAt: SUBMITTED_AT }), 202));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                onGoToPlans: vi.fn(),
                onAvailabilityChange,
            }));
        });
        await settleUi();
        await act(async () => { await vi.advanceTimersByTimeAsync(48_000); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();

        fetchMock.mockResolvedValue(noBody(204));
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(onAvailabilityChange).not.toHaveBeenCalledWith(false);
        expect(analyticsMocks.trackPrecheckoutEvent).not.toHaveBeenCalledWith(
            'precheckout_plan_gate_reached',
            PREFLIGHT_ID,
        );
    });

    it('keeps the parent plan gate closed during fallback despite a later 204, until the demo CTA completes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pendingStatus({ submittedAt: SUBMITTED_AT }), 202));
        vi.stubGlobal('fetch', fetchMock);

        function ParentPlanGate() {
            const [surface, setSurface] = useState<'awaiting' | 'preview' | 'legacy'>('awaiting');
            if (surface === 'legacy') return <div data-plan-gate="open">plans</div>;
            return <PrecheckoutImmersive
                preflightId={PREFLIGHT_ID}
                claimToken={null}
                submittedAtMs={Date.parse(SUBMITTED_AT)}
                onGoToPlans={() => setSurface('legacy')}
                onAvailabilityChange={available => setSurface(available ? 'preview' : 'legacy')}
            />;
        }

        await act(async () => {
            root.render(createElement(ParentPlanGate));
        });
        await settleUi();
        await act(async () => { await vi.advanceTimersByTimeAsync(48_000); });
        expect(container.querySelector('[data-precheckout-demo-mode="fallback"]')).not.toBeNull();
        expect(container.querySelector('[data-plan-gate="open"]')).toBeNull();

        fetchMock.mockResolvedValue(noBody(204));
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(container.querySelector('[data-plan-gate="open"]')).toBeNull();

        await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
        expect(container.querySelector('[data-plan-gate="open"]')).not.toBeNull();
    });

    it('reuses one browser request when the same preflight remounts', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeStatus(validDto({ likelyFemale: false }))));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                claimToken: 'same-claim',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();
        act(() => root.unmount());
        root = createRoot(container);
        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                claimToken: 'same-claim',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('omits the claim token header when claimToken is null', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeStatus(validDto({ likelyFemale: false }))));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = options.headers as Record<string, string>;
        expect(headers['x-preflight-claim-token']).toBeUndefined();
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('tracks the normal B-lite funnel from availability through the plan gate', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onGoToPlans = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            completeStatus(validDto({ likelyFemale: false }), SUBMITTED_AT),
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans,
            }));
        });
        await settleUi();
        await clickButton(container, '관계 판독 미리보기');

        await act(async () => { vi.advanceTimersByTime(12_000); });

        expect(onGoToPlans).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackPrecheckoutEvent.mock.calls).toEqual([
            ['precheckout_blite_available', PREFLIGHT_ID],
            ['precheckout_blite_result_viewed', PREFLIGHT_ID],
            ['precheckout_blite_preview_cta_clicked', PREFLIGHT_ID],
            ['precheckout_demo_started', PREFLIGHT_ID, { demo_mode: 'success' }],
            ['precheckout_demo_completed', PREFLIGHT_ID, { demo_mode: 'success', duration_ms: 12_000 }],
            ['precheckout_plan_gate_reached', PREFLIGHT_ID, { demo_mode: 'success' }],
        ]);
    });

    it('tracks fallback demo selection and completion with a bounded reason and mode', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const onGoToPlans = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(failedStatus({
            submittedAt: SUBMITTED_AT,
        }))));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans,
            }));
        });
        await settleUi();
        await act(async () => { vi.advanceTimersByTime(12_000); });

        expect(onGoToPlans).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackPrecheckoutEvent.mock.calls).toEqual([
            ['precheckout_blite_fallback_selected', PREFLIGHT_ID, { fallback_reason: 'terminal_before_48' }],
            ['precheckout_demo_started', PREFLIGHT_ID, { demo_mode: 'fallback' }],
            ['precheckout_demo_completed', PREFLIGHT_ID, { demo_mode: 'fallback', duration_ms: 12_000 }],
            ['precheckout_plan_gate_reached', PREFLIGHT_ID, { demo_mode: 'fallback' }],
        ]);
    });

    it('tracks a fallback demo runtime failure before opening the plan gate', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('matchMedia', vi.fn(() => {
            throw new Error('demo runtime details must not escape');
        }));
        const onGoToPlans = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(failedStatus({
            submittedAt: SUBMITTED_AT,
        }))));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans,
            }));
        });
        await settleUi();

        expect(onGoToPlans).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackPrecheckoutEvent.mock.calls).toEqual([
            ['precheckout_blite_fallback_selected', PREFLIGHT_ID, { fallback_reason: 'terminal_before_48' }],
            ['precheckout_demo_started', PREFLIGHT_ID, { demo_mode: 'fallback' }],
            ['precheckout_demo_failed', PREFLIGHT_ID, { demo_mode: 'fallback', duration_ms: 0 }],
            ['precheckout_plan_gate_reached', PREFLIGHT_ID, { demo_mode: 'fallback' }],
        ]);
    });

    it('tracks gender confirmation outcomes and reaches the plan gate on rejection', async () => {
        const onGoToPlans = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            completeStatus(validDto({ likelyFemale: true }), SUBMITTED_AT),
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans,
            }));
        });
        await settleUi();
        await clickButton(container, '아니오');

        expect(onGoToPlans).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackPrecheckoutEvent.mock.calls).toEqual([
            ['precheckout_blite_available', PREFLIGHT_ID],
            ['precheckout_blite_gender_confirmation_completed', PREFLIGHT_ID, {
                gender_confirmation_outcome: 'rejected',
            }],
            ['precheckout_plan_gate_reached', PREFLIGHT_ID],
        ]);
    });

    it('does not duplicate lifecycle calls when React StrictMode remounts the flow', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            completeStatus(validDto({ likelyFemale: false }), SUBMITTED_AT),
        )));

        await act(async () => {
            root.render(createElement(StrictMode, null, createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
            })));
        });
        await settleUi();

        expect(analyticsMocks.trackPrecheckoutEvent.mock.calls).toEqual([
            ['precheckout_blite_available', PREFLIGHT_ID],
            ['precheckout_blite_result_viewed', PREFLIGHT_ID],
        ]);
    });
});
