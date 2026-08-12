// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    PRECHECKOUT_BLITE_SCHEMA_VERSION,
} from '@/lib/services/precheckout/blite-contract';
import { PrecheckoutImmersive } from './precheckout-immersive';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';

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
            validDto({ likelyFemale: true, confidence: PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD })
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(container.textContent).toContain('이 계정의 인물이 남자가 맞나요?');
    });

    it('skips the confirmation screen below the confidence threshold', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
            validDto({ likelyFemale: true, confidence: PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD - 0.01 })
        )));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        expect(container.textContent).not.toContain('이 계정의 인물이 남자가 맞나요?');
        expect(container.textContent).toContain('관계 판독 미리보기');
    });

    it('아니오 dismisses the whole preview and leaves the page renderable again', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validDto())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();
        expect(container.textContent).toContain('이 계정의 인물이 남자가 맞나요?');

        await clickButton(container, '아니오');

        expect(container.innerHTML).toBe('');
    });

    it('예 proceeds to the B-lite result screen', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validDto())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();

        await clickButton(container, '예');

        expect(container.textContent).toContain('관계를 자주 드러내는 활발한 소통형 계정');
        expect(container.textContent).toContain('분석 후보 예상 범위 3 – 9명');
    });

    it('the final CTA is inert before the sequence completes and becomes active after', async () => {
        let rafCallback: FrameRequestCallback | null = null;
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            rafCallback = cb;
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        // likelyFemale: false skips the confirmation branch so one click reaches the demo screen.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validDto({ likelyFemale: false }))));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();
        await clickButton(container, '관계 판독 미리보기');

        const ctaBefore = button(container, '분석 결과 확인하기');
        expect(ctaBefore.disabled).toBe(true);
        expect(ctaBefore.closest('.precheckout-reveal')?.classList.contains('is-visible')).toBe(false);

        expect(rafCallback).not.toBeNull();
        await act(async () => {
            // First frame starts the clock; second frame is far past the 12s total, completing it.
            rafCallback?.(0);
            rafCallback?.(20_000);
        });

        const ctaAfter = button(container, '분석 결과 확인하기');
        expect(ctaAfter.disabled).toBe(false);
        expect(ctaAfter.closest('.precheckout-reveal')?.classList.contains('is-visible')).toBe(true);
    });

    it('the CTA calls onGoToPlans and nothing else once active, and does nothing before that', async () => {
        let rafCallback: FrameRequestCallback | null = null;
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            rafCallback = cb;
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validDto({ likelyFemale: false }))));
        const onGoToPlans = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans }));
        });
        await settleUi();
        await clickButton(container, '관계 판독 미리보기');

        await act(async () => {
            button(container, '분석 결과 확인하기').click();
        });
        expect(onGoToPlans).not.toHaveBeenCalled();

        await act(async () => {
            rafCallback?.(0);
            rafCallback?.(20_000);
        });

        await clickButton(container, '분석 결과 확인하기');

        expect(onGoToPlans).toHaveBeenCalledTimes(1);
        expect(container.textContent).not.toContain('분석 결과 확인하기');
        expect(document.body.style.overflow).toBe('');
    });

    it('renders the completed state immediately under prefers-reduced-motion', async () => {
        stubMatchMedia(query => query.includes('reduce'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validDto({ likelyFemale: false }))));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, { preflightId: PREFLIGHT_ID, claimToken: null, onGoToPlans: vi.fn() }));
        });
        await settleUi();
        await clickButton(container, '관계 판독 미리보기');

        const cta = button(container, '분석 결과 확인하기');
        expect(cta.disabled).toBe(false);
        expect(cta.closest('.precheckout-reveal')?.classList.contains('is-visible')).toBe(true);
    });

    it('sends the anonymous claim token header when claimToken is provided', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validDto({ likelyFemale: false })));
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
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validDto({ likelyFemale: false }))));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                onGoToPlans: vi.fn(),
                onAvailabilityChange,
            }));
        });
        await settleUi();

        expect(onAvailabilityChange).toHaveBeenNthCalledWith(1, false);
        expect(onAvailabilityChange).toHaveBeenLastCalledWith(true);
    });

    it('omits the claim token header when claimToken is null', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validDto({ likelyFemale: false })));
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
