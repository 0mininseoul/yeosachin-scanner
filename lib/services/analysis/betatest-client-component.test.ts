// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
    useRouter: () => navigation,
}));

import { BetaTestClient } from '@/app/betatest/betatest-client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const PREFLIGHT_ONE = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_TWO = '223e4567-e89b-42d3-a456-426614174000';
const REQUEST_ID = '323e4567-e89b-42d3-a456-426614174000';
const EXPIRES_AT = '2030-08-02T12:00:00.000Z';
const PRICING_VERSION = 'earlybird-2026-07-v2';

const PLANS = [
    {
        planId: 'basic',
        launchStatus: 'production',
        relationshipCapacity: { followers: 400, following: 400 },
        detailedMutualLimit: 300,
        selectionState: 'required',
        unavailableReason: null,
        pricingVersion: PRICING_VERSION,
        price: { status: 'quoted', currency: 'KRW', amountKrw: 6_900 },
    },
    {
        planId: 'standard',
        launchStatus: 'production',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
        selectionState: 'available_upgrade',
        unavailableReason: null,
        pricingVersion: PRICING_VERSION,
        price: { status: 'quoted', currency: 'KRW', amountKrw: 9_900 },
    },
    {
        planId: 'plus',
        launchStatus: 'production',
        relationshipCapacity: { followers: 1_200, following: 1_200 },
        detailedMutualLimit: 900,
        selectionState: 'available_upgrade',
        unavailableReason: null,
        pricingVersion: PRICING_VERSION,
        price: { status: 'deferred', currency: 'KRW', amountKrw: null },
    },
] as const;

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function accepted(preflightId: string) {
    return {
        schemaVersion: 1,
        preflightId,
        expiresAt: EXPIRES_AT,
        status: 'pending',
        exclusionDecision: 'pending',
    } as const;
}

function capacityBlocked(preflightId: string) {
    return {
        schemaVersion: 1,
        preflightId,
        expiresAt: EXPIRES_AT,
        status: 'blocked',
        exclusionDecision: 'pending',
        code: 'BETA_CAPACITY_UNAVAILABLE',
    } as const;
}

function queueBlocked(preflightId: string) {
    return {
        schemaVersion: 1,
        preflightId,
        expiresAt: EXPIRES_AT,
        status: 'blocked',
        exclusionDecision: 'pending',
        code: 'QUEUE_UNAVAILABLE',
    } as const;
}

function ready(preflightId: string) {
    return {
        schemaVersion: 1,
        preflightId,
        expiresAt: EXPIRES_AT,
        status: 'ready',
        exclusionDecision: 'pending',
        target: {
            username: 'beta.target',
            fullName: 'Beta Target',
            bio: null,
            profileImage: null,
            followersCount: 120,
            followingCount: 150,
            isPrivate: false,
        },
        accessMode: 'production',
        capacityRequiredPlan: 'basic',
        requiredPlan: 'basic',
        plans: PLANS,
        pricingVersion: PRICING_VERSION,
    } as const;
}

function requestUrl(input: RequestInfo | URL): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

async function settleUi() {
    await act(async () => {
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
}

function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('input value setter unavailable');
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
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
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
}

type RecordedRequest = { url: string; init: RequestInit };

function installReadyFlow(admissions: Response[] = []) {
    const calls: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = requestUrl(input);
        calls.push({ url, init });
        if (url === '/api/analysis/betatest/preflight' && init.method === 'POST') {
            return jsonResponse(accepted(PREFLIGHT_ONE), 202);
        }
        if (url === `/api/analysis/preflight/${PREFLIGHT_ONE}` && !init.method) {
            return jsonResponse(ready(PREFLIGHT_ONE));
        }
        if (url === `/api/analysis/preflight/${PREFLIGHT_ONE}` && init.method === 'PATCH') {
            return new Response(null, { status: 204 });
        }
        if (
            url === `/api/analysis/betatest/preflight/${PREFLIGHT_ONE}/admit`
            && init.method === 'POST'
        ) {
            const response = admissions.shift();
            if (!response) throw new Error('unexpected extra admission request');
            return response;
        }
        throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
}

async function enterReadyFlow(container: HTMLElement) {
    const target = container.querySelector<HTMLInputElement>('#beta-target-instagram');
    expect(target).not.toBeNull();
    setInputValue(target!, 'beta.target');
    await clickButton(container, '무료 판독 가능 여부 확인');
    await settleUi();
}

describe('beta-test client', () => {
    let container: HTMLDivElement;
    let root: Root;
    let mounted: boolean;

    beforeEach(() => {
        navigation.push.mockReset();
        window.sessionStorage.clear();
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        mounted = true;
        act(() => root.render(createElement(BetaTestClient)));
    });

    afterEach(() => {
        if (mounted) act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('retries a terminal capacity check for the same target with a new preflight key', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID')
            .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
            .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        const creates: RequestInit[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === '/api/analysis/betatest/preflight' && init?.method === 'POST') {
                creates.push(init);
                const preflightId = creates.length === 1 ? PREFLIGHT_ONE : PREFLIGHT_TWO;
                return jsonResponse(accepted(preflightId), 202);
            }
            if (url === `/api/analysis/preflight/${PREFLIGHT_ONE}`) {
                return jsonResponse(capacityBlocked(PREFLIGHT_ONE));
            }
            if (url === `/api/analysis/preflight/${PREFLIGHT_TWO}`) {
                return jsonResponse(capacityBlocked(PREFLIGHT_TWO));
            }
            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const target = container.querySelector<HTMLInputElement>('#beta-target-instagram');
        expect(target).not.toBeNull();
        setInputValue(target!, 'same.target');
        await clickButton(container, '무료 판독 가능 여부 확인');
        await settleUi();

        expect(container.textContent).toContain(
            '현재 무료 판독 가능 인원이 모두 찼습니다. 잠시 후 다시 시도해주세요.'
        );
        const capacityCopy = [...container.querySelectorAll('p')].find(candidate => (
            candidate.textContent?.includes('현재 무료 판독 가능 인원이 모두 찼습니다.')
        ));
        expect(capacityCopy?.textContent).not.toMatch(/계정|primary|secondary|slot|잔액/i);

        await clickButton(container, '같은 대상으로 다시 확인');
        await settleUi();

        expect(creates).toHaveLength(2);
        expect(JSON.parse(String(creates[1].body))).toEqual({ targetInstagramId: 'same.target' });
        const firstKey = new Headers(creates[0].headers).get('idempotency-key');
        const secondKey = new Headers(creates[1].headers).get('idempotency-key');
        expect(firstKey).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        expect(secondKey).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    });

    it('retries a queue-unavailable beta preparation on the same target with a new preflight key', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID')
            .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
            .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        const creates: RequestInit[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === '/api/analysis/betatest/preflight' && init?.method === 'POST') {
                creates.push(init);
                const preflightId = creates.length === 1 ? PREFLIGHT_ONE : PREFLIGHT_TWO;
                return jsonResponse(accepted(preflightId), 202);
            }
            if (url === `/api/analysis/preflight/${PREFLIGHT_ONE}`) {
                return jsonResponse(queueBlocked(PREFLIGHT_ONE));
            }
            if (url === `/api/analysis/preflight/${PREFLIGHT_TWO}`) {
                return jsonResponse(queueBlocked(PREFLIGHT_TWO));
            }
            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }));

        const target = container.querySelector<HTMLInputElement>('#beta-target-instagram');
        expect(target).not.toBeNull();
        setInputValue(target!, 'queue.target');
        await clickButton(container, '무료 판독 가능 여부 확인');
        await settleUi();

        expect(container.textContent).toContain('사전 점검 작업이 지연되고 있습니다. 잠시 후 다시 시도해주세요.');
        await clickButton(container, '같은 대상으로 준비 다시 확인');
        await settleUi();

        expect(creates).toHaveLength(2);
        expect(JSON.parse(String(creates[1].body))).toEqual({ targetInstagramId: 'queue.target' });
        const firstKey = new Headers(creates[0].headers).get('idempotency-key');
        const secondKey = new Headers(creates[1].headers).get('idempotency-key');
        expect(firstKey).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        expect(secondKey).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    });

    it('shows a dedicated access message without presenting capacity retry state', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            schemaVersion: 1,
            code: 'BETA_ACCESS_UNAVAILABLE',
            error: 'internal access detail',
        }, 403)));

        const target = container.querySelector<HTMLInputElement>('#beta-target-instagram');
        setInputValue(target!, 'beta.target');
        await clickButton(container, '무료 판독 가능 여부 확인');

        expect(container.textContent).toContain('베타 테스트 이용 권한을 확인할 수 없습니다.');
        expect(container.textContent).not.toContain('같은 대상으로 다시 확인');
        expect(container.textContent).not.toContain('internal access detail');
    });

    it('keeps non-capacity terminal failures on the ordinary target-change action', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url === '/api/analysis/betatest/preflight' && init?.method === 'POST') {
                return jsonResponse(accepted(PREFLIGHT_ONE), 202);
            }
            if (url === `/api/analysis/preflight/${PREFLIGHT_ONE}`) {
                return jsonResponse({
                    schemaVersion: 1,
                    preflightId: PREFLIGHT_ONE,
                    expiresAt: EXPIRES_AT,
                    status: 'blocked',
                    exclusionDecision: 'pending',
                    code: 'TARGET_PRIVATE',
                });
            }
            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }));

        await enterReadyFlow(container);

        expect(container.textContent).toContain('비공개 계정은 판독할 수 없습니다.');
        expect(container.textContent).toContain('다른 계정 확인하기');
        expect(container.textContent).not.toContain('같은 대상으로 다시 확인');
    });

    it('requires an explicit exclusion decision before rendering plan admission', async () => {
        const { calls } = installReadyFlow();

        await enterReadyFlow(container);

        expect(container.textContent).toContain('본인 계정은 먼저 제외해주세요');
        expect(container.textContent).not.toContain('무료 판독 시작하기');
        await clickButton(container, '제외 없이 계속하기');
        await settleUi();

        const exclusion = calls.find(call => call.init.method === 'PATCH');
        expect(JSON.parse(String(exclusion?.init.body))).toEqual({ decision: 'skip' });
        expect(container.textContent).toContain('무료 판독 시작하기');
    });

    it('polls pending beta admission on the same preflight and navigates after replay', async () => {
        vi.useFakeTimers();
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        const firstPending = jsonResponse({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ONE,
            code: 'BETA_ADMISSION_PENDING',
            status: 'admission_pending',
            retryAfterMs: 250,
        }, 202);
        const secondPending = jsonResponse({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ONE,
            code: 'BETA_ADMISSION_PENDING',
            status: 'admission_pending',
            retryAfterMs: 250,
        }, 202);
        const success = jsonResponse({
            schemaVersion: 1,
            requestId: REQUEST_ID,
            status: 'queued',
            backgroundProcessing: true,
        });
        const { calls } = installReadyFlow([firstPending, secondPending, success]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');

        await clickButton(container, '무료 판독 시작하기');
        expect(container.textContent).not.toContain(
            '판독 배정을 확인하고 있습니다. 잠시 후 다시 시도해주세요.'
        );
        expect(navigation.push).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
        });

        expect(navigation.push).toHaveBeenCalledWith(`/progress/${REQUEST_ID}`);
        expect(navigation.push).toHaveBeenCalledTimes(1);
        expect(setItem.mock.calls.filter(([key]) => (
            key === `amplitude:analysis_started:${REQUEST_ID}`
        ))).toHaveLength(1);
        const admissionCalls = calls.filter(call => call.url.endsWith('/admit'));
        expect(admissionCalls).toHaveLength(3);
        expect(new Set(admissionCalls.map(call => call.url))).toEqual(new Set([
            `/api/analysis/betatest/preflight/${PREFLIGHT_ONE}/admit`,
        ]));
        expect(admissionCalls.map(call => JSON.parse(String(call.init.body))))
            .toEqual([{ planId: 'basic' }, { planId: 'basic' }, { planId: 'basic' }]);
    });

    it('aborts pending beta admission polling when the lifecycle is reset', async () => {
        vi.useFakeTimers();
        const pending = jsonResponse({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ONE,
            code: 'BETA_ADMISSION_PENDING',
            status: 'admission_pending',
            retryAfterMs: 250,
        }, 202);
        const { calls } = installReadyFlow([pending]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');
        await clickButton(container, '무료 판독 시작하기');

        const admission = calls.find(call => call.url.endsWith('/admit'));
        expect(admission?.init.signal?.aborted).toBe(false);

        await clickButton(container, '대상 변경');
        expect(admission?.init.signal?.aborted).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(calls.filter(call => call.url.endsWith('/admit'))).toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('판독 배정을 확인하고 있습니다.');
    });

    it('aborts pending beta admission polling on unmount without a late navigation', async () => {
        vi.useFakeTimers();
        const pending = jsonResponse({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ONE,
            code: 'BETA_ADMISSION_PENDING',
            status: 'admission_pending',
            retryAfterMs: 250,
        }, 202);
        const { calls } = installReadyFlow([pending]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');
        await clickButton(container, '무료 판독 시작하기');

        const admission = calls.find(call => call.url.endsWith('/admit'));
        act(() => root.unmount());
        mounted = false;
        expect(admission?.init.signal?.aborted).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(calls.filter(call => call.url.endsWith('/admit'))).toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('bounds pending beta admission polling and leaves the same preflight retryable', async () => {
        vi.useFakeTimers();
        const pendingAdmissions = Array.from({ length: 120 }, () => jsonResponse({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ONE,
            code: 'BETA_ADMISSION_PENDING',
            status: 'admission_pending',
            retryAfterMs: 250,
        }, 202));
        const { calls } = installReadyFlow(pendingAdmissions);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');
        await clickButton(container, '무료 판독 시작하기');

        for (let attempt = 1; attempt < 120; attempt += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(250);
            });
        }

        expect(calls.filter(call => call.url.endsWith('/admit'))).toHaveLength(120);
        expect(calls.filter(call => call.url === '/api/analysis/betatest/preflight'))
            .toHaveLength(1);
        expect(container.textContent).toContain(
            '무료 판독 배정을 확인하는 데 시간이 걸리고 있습니다. 다시 시도해주세요.'
        );
        expect(button(container, '무료 판독 시작하기').disabled).toBe(false);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('keeps a capacity rejection on the same preflight for a manual retry', async () => {
        const capacity = jsonResponse({
            schemaVersion: 1,
            code: 'BETA_CAPACITY_UNAVAILABLE',
            error: '베타 분석을 준비할 수 없습니다.',
        }, 409);
        const { calls } = installReadyFlow([capacity]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');
        await clickButton(container, '무료 판독 시작하기');

        expect(container.textContent).toContain(
            '현재 무료 판독 가능 인원이 모두 찼습니다. 잠시 후 다시 시도해주세요.'
        );
        expect(button(container, '무료 판독 다시 시도').disabled).toBe(false);
        expect(calls.filter(call => call.url.endsWith('/admit'))).toHaveLength(1);
        expect(calls.filter(call => call.url === '/api/analysis/betatest/preflight'))
            .toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('keeps an access rejection on the same preflight with safe manual retry copy', async () => {
        const access = jsonResponse({
            schemaVersion: 1,
            code: 'BETA_ACCESS_UNAVAILABLE',
            error: 'internal access detail',
        }, 403);
        const { calls } = installReadyFlow([access]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');
        await clickButton(container, '무료 판독 시작하기');

        expect(container.textContent).toContain('베타 테스트 이용 권한을 확인할 수 없습니다.');
        expect(container.textContent).not.toContain('internal access detail');
        expect(button(container, '무료 판독 시작하기').disabled).toBe(false);
        expect(calls.filter(call => call.url.endsWith('/admit'))).toHaveLength(1);
        expect(calls.filter(call => call.url === '/api/analysis/betatest/preflight'))
            .toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('treats a malformed pending admission as a safe manual retry error', async () => {
        const malformed = jsonResponse({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ONE,
            code: 'BETA_ADMISSION_PENDING',
            status: 'admission_pending',
        }, 202);
        const { calls } = installReadyFlow([malformed]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');
        await clickButton(container, '무료 판독 시작하기');

        expect(container.textContent).toContain('판독 시작 응답을 확인할 수 없습니다.');
        expect(button(container, '무료 판독 시작하기').disabled).toBe(false);
        expect(calls.filter(call => call.url.endsWith('/admit'))).toHaveLength(1);
        expect(calls.filter(call => call.url === '/api/analysis/betatest/preflight'))
            .toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('routes a successful beta request to normal progress without consuming credentials or commerce APIs', async () => {
        const admissionCredentialKey = 'analysis_v2_test_admission:beta.target';
        const entitlementKey = `analysis_v2_test_entitlement:${PREFLIGHT_ONE}:basic`;
        window.sessionStorage.setItem(admissionCredentialKey, JSON.stringify({
            idempotencyKey: 'test-admission-key-000001',
            token: 'v1.payload.signature',
        }));
        window.sessionStorage.setItem(entitlementKey, 'v1.payload.signature');
        const success = jsonResponse({
            schemaVersion: 1,
            requestId: REQUEST_ID,
            status: 'queued',
            backgroundProcessing: true,
        });
        const { calls } = installReadyFlow([success]);
        await enterReadyFlow(container);
        await clickButton(container, '제외 없이 계속하기');

        await clickButton(container, '무료 판독 시작하기');
        await settleUi();

        expect(navigation.push).toHaveBeenCalledWith(`/progress/${REQUEST_ID}`);
        expect(window.sessionStorage.getItem(admissionCredentialKey)).not.toBeNull();
        expect(window.sessionStorage.getItem(entitlementKey)).toBe('v1.payload.signature');
        for (const call of calls) {
            expect(call.url).not.toMatch(/entitle|checkout|payment|waitlist/i);
            const headers = new Headers(call.init.headers);
            expect(headers.has('x-analysis-test-admission')).toBe(false);
            expect(headers.has('x-analysis-test-entitlement')).toBe(false);
        }
    });
});
