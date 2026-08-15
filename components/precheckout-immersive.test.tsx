// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRECHECKOUT_BLITE_SCHEMA_VERSION,
} from '@/lib/services/precheckout/blite-contract';

const analyticsMocks = vi.hoisted(() => ({
    PRECHECKOUT_EVENTS: {
        BLITE_AVAILABLE: 'precheckout_blite_available',
        BLITE_RESULT_VIEWED: 'precheckout_blite_result_viewed',
        BLITE_FALLBACK_SELECTED: 'precheckout_blite_fallback_selected',
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
    __resetBrowserBliteRequestsForTest,
    PrecheckoutImmersive,
} from './precheckout-immersive';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBMITTED_AT = '2026-08-15T00:00:00.000Z';

function validDto() {
    return {
        schemaVersion: PRECHECKOUT_BLITE_SCHEMA_VERSION,
        persona: {
            headline: '관계를 자주 드러내는 활발한 소통형 계정',
            summary: '최근 공개 피드에서 관계와 소통 패턴이 반복적으로 관찰됐어요.',
        },
        signals: [
            { claim: '태그된 사람과의 관계를 자주 드러내는 편이에요.', category: '관계 노출 성향', confidence: 0.82, band: 'high' as const },
            { claim: '캐러셀 게시물을 자주 활용해요.', category: '게시 습관', confidence: 0.62, band: 'medium' as const },
            { claim: '해시태그 사용이 적은 편이에요.', category: '게시 습관', confidence: 0.35, band: 'low' as const },
            { claim: '댓글 반응을 활발히 유도해요.', category: '소통 성향', confidence: 0.71, band: 'high' as const },
        ],
        candidateRange: { min: 3, max: 9 },
        genderRead: {
            likelyFemale: false,
            confidence: 0.62,
            reasons: [
                '프로필과 공개 피드 신호가 한쪽으로 뚜렷하지 않아요.',
                '태그된 계정 구성이 한쪽으로 치우치지 않았어요.',
                '게시물 주제가 다양한 편이에요.',
            ],
        },
        postCount: 8,
        evidenceFields: ['post.caption', 'post.hashtags', 'post.taggedUsers'],
    };
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function completeStatus() {
    return {
        state: 'complete',
        submittedAt: SUBMITTED_AT,
        fallbackAt: new Date(Date.parse(SUBMITTED_AT) + 78_000).toISOString(),
        dto: validDto(),
    };
}

function pendingStatus() {
    return {
        state: 'pending',
        submittedAt: SUBMITTED_AT,
        fallbackAt: new Date(Date.parse(SUBMITTED_AT) + 78_000).toISOString(),
        retryAfterMs: 1_000,
    };
}

function failedStatus() {
    return {
        state: 'failed',
        submittedAt: SUBMITTED_AT,
        fallbackAt: new Date(Date.parse(SUBMITTED_AT) + 78_000).toISOString(),
    };
}

function noBody(status = 204): Response {
    return new Response(null, { status });
}

async function settleUi() {
    await act(async () => {
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
}

async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await settleUi();
}

function clickButton(container: HTMLElement, label: string) {
    const button = [...container.querySelectorAll('button')]
        .find(candidate => candidate.textContent?.trim() === label);
    if (!button) throw new Error(`button not found: ${label}`);
    act(() => button.click());
}

describe('PrecheckoutImmersive', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        __resetBrowserBliteRequestsForTest();
        analyticsMocks.trackPrecheckoutEvent.mockReset();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(SUBMITTED_AT));
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('matchMedia', vi.fn(() => ({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })));
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

    it('starts the waiting demo immediately for an unresolved B-lite status', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();
        expect(container.querySelector('[data-precheckout-target-card]')).toBeNull();
        expect(container.querySelector('[data-precheckout-result-card]')).toBeNull();
        expect(container.textContent).not.toContain('상세 분석 보기');
    });

    it('does not let a durable result preempt the initial four-stage pass', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeStatus())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();
        await advance(11_999);
        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();
        expect(container.querySelector('[data-precheckout-result-card]')).toBeNull();
    });

    it('keeps plans closed until the full B-lite result CTA is clicked', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeStatus())));
        const onGoToPlans = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans,
            }));
        });
        await settleUi();
        await advance(12_000);

        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_blite_available', PREFLIGHT_ID,
        );
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_demo_completed', PREFLIGHT_ID, { demo_mode: 'result', duration_ms: 12_000 },
        );
        expect(container.querySelector('[data-precheckout-fallback]')).toBeNull();
        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).toBeNull();
        expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(5);
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_blite_result_viewed', PREFLIGHT_ID,
        );
        expect(container.textContent).toContain('@target');
        expect(container.textContent).toContain('관계를 자주 드러내는 활발한 소통형 계정');
        expect(onGoToPlans).not.toHaveBeenCalled();
        clickButton(container, '상세 분석 보기');
        expect(onGoToPlans).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_plan_gate_reached', PREFLIGHT_ID, { demo_mode: 'result' },
        );
    });

    it('uses the slow loop with changing progress while B-lite is pending', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(pendingStatus(), 202)));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();
        await advance(12_000);
        const firstCopy = container.querySelector('[data-precheckout-progress]')?.textContent;
        await advance(6_000);
        const secondCopy = container.querySelector('[data-precheckout-progress]')?.textContent;

        expect(firstCopy).toContain('추가 신호');
        expect(secondCopy).toContain('연결 밀도');
        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();
    });

    it('ends naturally at T+90 with a neutral fallback CTA and no early plan release', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));
        const onGoToPlans = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans,
            }));
        });
        await settleUi();
        expect(onGoToPlans).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('상세 분석 보기');
        await advance(90_000);

        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_blite_fallback_selected', PREFLIGHT_ID, { fallback_reason: 'unresolved_at_90' },
        );
        expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
        expect(container.textContent).toContain('상세 분석 보기');
        expect(container.textContent).not.toContain('실패');
        clickButton(container, '상세 분석 보기');
        expect(onGoToPlans).toHaveBeenCalledOnce();
    });

    it('holds a terminal B-lite status behind the same neutral T+90 fallback', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(failedStatus())));

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();
        await advance(89_999);
        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();
        await advance(1);

        expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
        expect(container.textContent).not.toContain('B-lite');
        expect(container.textContent).not.toContain('실패');
    });

    it('reconstructs a complete result on refresh without a second status request', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeStatus()));
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: 'claim-token',
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();
        act(() => root.unmount());
        root = createRoot(container);
        await act(async () => {
            root.render(createElement(StrictMode, null, createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: 'claim-token',
                submittedAtMs: Date.parse(SUBMITTED_AT),
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            })));
        });
        await settleUi();

        expect(fetchMock).toHaveBeenCalledOnce();
        const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((options.headers as Record<string, string>)['x-preflight-claim-token'])
            .toBe('claim-token');
    });
});
