// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    PRECHECKOUT_BLITE_SCHEMA_VERSION,
} from '@/lib/services/precheckout/blite-contract';
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
});
