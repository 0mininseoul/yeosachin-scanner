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
    __resetBrowserBliteRequestsForTest,
    PrecheckoutImmersive,
} from './precheckout-immersive';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBMITTED_AT = '2026-08-15T00:00:00.000Z';

function validDto(overrides: {
    genderRead?: { likelyFemale: boolean; confidence: number; reasons: [string, string, string] };
    candidateRange?: { min: number; max: number };
    postCount?: number;
} = {}) {
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
        candidateRange: overrides.candidateRange ?? { min: 3, max: 9 },
        genderRead: overrides.genderRead ?? {
            likelyFemale: false,
            confidence: 0.62,
            reasons: [
                '프로필과 공개 피드 신호가 한쪽으로 뚜렷하지 않아요.',
                '태그된 계정 구성이 한쪽으로 치우치지 않았어요.',
                '게시물 주제가 다양한 편이에요.',
            ],
        },
        postCount: overrides.postCount ?? 8,
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
        expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(4);
        expect(container.textContent).not.toContain('성별 판독 요약');
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

    it('does not postpone the fallback beyond T+90 when the deadline callback is late', async () => {
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
        await advance(90_001);

        expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
    });

    it('keeps the plan gate closed through a demo runtime error until the initial pass ends', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));
        vi.stubGlobal('matchMedia', vi.fn(() => {
            throw new Error('media query unavailable');
        }));

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
        await advance(11_999);
        expect(container.querySelector('[data-precheckout-fallback]')).toBeNull();
        await advance(1);

        expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
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

    it('always renders a fresh initial pass at mount, even with a stale accepted-preflight timestamp', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));
        const staleSubmittedAtMs = Date.parse(SUBMITTED_AT) - 20_000;

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: staleSubmittedAtMs,
                targetUsername: 'target',
                onGoToPlans: vi.fn(),
            }));
        });
        await settleUi();

        expect(container.querySelector('[data-precheckout-demo-phase="initial"]')).not.toBeNull();
        expect(container.querySelector('[data-precheckout-progress]')).toBeNull();
        expect(container.textContent).toContain('1/4');

        await advance(11_999);
        expect(container.querySelector('[data-precheckout-demo-phase="initial"]')).not.toBeNull();
        await advance(1);
        expect(container.querySelector('[data-precheckout-demo-phase="waiting"]')).not.toBeNull();
    });

    it('renders a fresh visible entry on every remount instead of resuming a stale elapsed position', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));
        const staleSubmittedAtMs = Date.parse(SUBMITTED_AT) - 20_000;
        const props = {
            preflightId: PREFLIGHT_ID,
            claimToken: null,
            submittedAtMs: staleSubmittedAtMs,
            targetUsername: 'target',
            onGoToPlans: vi.fn(),
        };

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, props));
        });
        await settleUi();
        expect(container.querySelector('[data-precheckout-demo-phase="initial"]')).not.toBeNull();

        act(() => root.unmount());
        vi.setSystemTime(new Date(Date.parse(SUBMITTED_AT) + 5_000));
        root = createRoot(container);
        await act(async () => {
            root.render(createElement(StrictMode, null, createElement(PrecheckoutImmersive, props)));
        });
        await settleUi();

        expect(container.querySelector('[data-precheckout-demo-phase="initial"]')).not.toBeNull();
        expect(container.querySelector('[data-precheckout-demo-phase="waiting"]')).toBeNull();
    });

    it('settles a mid-pass deadline at the next transition instead of cutting the fresh pass short', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));
        // submittedAtMs + BLITE_UX_DEADLINE_MS(90s) lands 8s after this mount's visible entry,
        // i.e. inside the freshly-restarted 12s initial pass.
        const staleSubmittedAtMs = Date.parse(SUBMITTED_AT) - 82_000;
        const onGoToPlans = vi.fn();

        await act(async () => {
            root.render(createElement(PrecheckoutImmersive, {
                preflightId: PREFLIGHT_ID,
                claimToken: null,
                submittedAtMs: staleSubmittedAtMs,
                targetUsername: 'target',
                onGoToPlans,
            }));
        });
        await settleUi();

        await advance(8_000);
        expect(container.querySelector('[data-precheckout-fallback]')).toBeNull();
        expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();

        await advance(3_999);
        expect(container.querySelector('[data-precheckout-fallback]')).toBeNull();

        await advance(1);
        expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();
    });

    it('gates a high-confidence female read behind a confirmation screen before revealing the result', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            ...completeStatus(),
            dto: validDto({
                genderRead: { likelyFemale: true, confidence: 0.70, reasons: ['근거 하나', '근거 둘', '근거 셋'] },
            }),
        })));
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

        expect(container.textContent).toContain('여성일 가능성이 높다는 고신뢰 판독');
        expect(container.textContent).toContain('근거 하나');
        expect(container.querySelector('[data-precheckout-result-card]')).toBeNull();
        expect(container.textContent).not.toContain('상세 분석 보기');

        clickButton(container, '예');
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_blite_gender_confirmation_completed', PREFLIGHT_ID,
            { gender_confirmation_outcome: 'confirmed' },
        );
        expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(4);
        expect(container.textContent).not.toContain('성별 판독 요약');
        expect(onGoToPlans).not.toHaveBeenCalled();
        clickButton(container, '상세 분석 보기');
        expect(onGoToPlans).toHaveBeenCalledOnce();
    });

    it('suppresses the result and reports no fallback when a high-confidence gender read is rejected', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            ...completeStatus(),
            dto: validDto({
                genderRead: { likelyFemale: true, confidence: 0.95, reasons: ['근거 하나', '근거 둘', '근거 셋'] },
            }),
        })));
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

        clickButton(container, '아니오');
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_blite_gender_confirmation_completed', PREFLIGHT_ID,
            { gender_confirmation_outcome: 'rejected' },
        );
        expect(analyticsMocks.trackPrecheckoutEvent).not.toHaveBeenCalledWith(
            'precheckout_blite_fallback_selected', PREFLIGHT_ID, expect.anything(),
        );
        expect(container.querySelector('[data-precheckout-result-card]')).toBeNull();
        expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
        expect(onGoToPlans).not.toHaveBeenCalled();

        clickButton(container, '상세 분석 보기');
        expect(onGoToPlans).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
            'precheckout_plan_gate_reached', PREFLIGHT_ID, { demo_mode: 'result' },
        );
    });

    it('does not gate a female read below the confirmation confidence threshold', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            ...completeStatus(),
            dto: validDto({
                genderRead: { likelyFemale: true, confidence: 0.69, reasons: ['근거 하나', '근거 둘', '근거 셋'] },
            }),
        })));

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

        expect(container.textContent).not.toContain('판독 방향 확인');
        expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(4);
        expect(container.textContent).toContain('상세 분석 보기');
    });

    it('renders the candidate range with a tilde and a generic feed caption without the exact post count', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            ...completeStatus(),
            dto: validDto({ candidateRange: { min: 34, max: 80 }, postCount: 47 }),
        })));

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

        expect(container.textContent).toContain('34~80명');
        expect(container.textContent).not.toContain('34 – 80명');
        expect(container.textContent).not.toContain('34-80명');
        expect(container.textContent).toContain('최근 게시물들에서 확인한 패턴');
        expect(container.textContent).not.toContain('47개');
    });
});
