/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIFY_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';
import { AnalysisAuditWorkbench } from './workbench';

const requestId = '10000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);
const timestamp = '2026-09-05T08:00:00.000Z';
const retention = {
    state: 'retained' as const,
    queueStatus: 'completed' as const,
    version: 1,
    assembledAt: timestamp,
    purgeFencedAt: null,
    purgeFenceReason: null,
    purgedAt: null,
    queueUpdatedAt: timestamp,
};
const inventory = APIFY_CREDENTIAL_SLOTS.map(credentialSlot => ({
    credentialSlot,
    workloadRole: credentialSlot === 'secondary' ? 'paid' as const : 'free' as const,
    healthState: 'healthy' as const,
    freshnessState: 'fresh' as const,
    monthlyLimitUsd: 5,
    monthlyUsageUsd: 0,
    effectiveRemainingUsd: 5,
    billingCycleStartAt: '2026-09-01T00:00:00.000Z',
    billingCycleEndAt: '2026-10-01T00:00:00.000Z',
    cycleResetAt: '2026-10-01T00:00:00.000Z',
    observedAt: timestamp,
    refreshedAt: timestamp,
    manuallyExcluded: false,
}));
const summary = {
    requestId,
    version: 1,
    bundleHash: hash,
    previousVersionHash: null,
    sourceSetHash: hash,
    status: 'complete' as const,
    completeness: 'complete' as const,
    gapCodes: [],
    pipelineVersion: 'v2' as const,
    pipelinePolicy: {},
    riskPolicyVersion: null,
    aiPolicyVersion: null,
    schedulerPolicyVersion: null,
    planId: 'basic' as const,
    accessMode: 'production' as const,
    orderId: null,
    targetInstagramId: 'synthetic.target',
    targetProfileAvailable: true,
    targetPostsAvailable: true,
    targetPostCount: 1,
    followers: { declared: 1, collected: 1 },
    following: { declared: 1, collected: 1 },
    mutuals: {
        total: 1,
        public: 1,
        private: 0,
        screened: 1,
        declared: 1,
        collected: 1,
        listHash: hash,
        keyCoverage: { expected: ['mutual'], observed: ['mutual'], missing: [], extra: [], complete: true },
    },
    gender: { initialResolved: 1, finalResolved: 1 },
    risk: { declared: 1, collected: 1 },
    interactions: {
        declared: 1,
        collected: 1,
        targetLikes: { declared: 1, collected: 1 },
        targetComments: { declared: 0, collected: 0 },
        candidateLikes: { declared: null, collected: null, evidenceCollected: null },
        tags: { declared: 0, collected: 0 },
        mentions: { declared: 0, collected: 0 },
    },
    providerRuns: [],
    stageStatus: {
        relationships: true,
        targetEvidence: true,
        candidateFeatures: true,
        riskScores: true,
        finalized: true,
        cost: 'complete' as const,
        costSourceHash: hash,
        candidateKeyCoverage: { expected: [], observed: [], missing: [], extra: [], complete: true },
        targetLikes: true,
        targetComments: true,
        candidateLikes: false,
        tags: false,
        mentions: false,
        retainedEvidenceSourceSetHash: hash,
    },
    retention,
    assembledAt: timestamp,
    cost: { currency: 'USD', status: 'complete' as const, knownUsd: 0.12, conservativeUsd: 0.14, usageUnknown: false },
    usageUnknown: false,
};
const listRow = {
    requestId,
    orderId: null,
    targetInstagramId: 'synthetic.target',
    planId: 'basic' as const,
    version: 1,
    completenessStatus: 'complete' as const,
    gapCodes: [],
    cost: { status: 'complete' as const, knownUsd: 0.12, conservativeUsd: 0.14, usageUnknown: false },
    gender: { initialResolved: 1, finalResolved: 1 },
    risk: { declared: 1, collected: 1 },
    retention,
    stageStatus: { relationships: true, targetEvidence: true, candidateFeatures: true, riskScores: true, finalized: true },
    assembledAt: timestamp,
};

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.restoreAllMocks();
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
});

function renderWorkbench(initialRequestId = ''): void {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(AnalysisAuditWorkbench, { initialRequestId })));
}

describe('independent-review regressions', () => {
    // Regression: ISSUE-007 — two failed first-page reloads retained a stale page-2 cursor.
    it('disables order pagination after an append failure and failed first-page retry', async () => {
        let orderRequests = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory });
            if (url.pathname === '/api/admin/order-audit') {
                orderRequests += 1;
                if (orderRequests === 1) {
                    return jsonResponse({ rows: [listRow], nextCursor: { assembledAt: timestamp, requestId } });
                }
                return jsonResponse({ error: 'synthetic failure' }, 503);
            }
            return jsonResponse({ error: 'not found' }, 404);
        }));

        renderWorkbench();
        await settle();
        const orders = container!.querySelector('[aria-labelledby="orders-title"]')!;
        const next = [...orders.querySelectorAll('button')].find(button => button.textContent === '다음 25건')!;
        expect(next.disabled).toBe(false);

        await act(async () => next.click());
        await settle();
        const retry = [...orders.querySelectorAll('button')].find(button => button.textContent === '주문 다시 시도')!;
        await act(async () => retry.click());
        await settle();

        expect(orderRequests).toBe(3);
        expect(orders.querySelector('.oc-order-table button.oc-link')).toBeNull();
        expect(next.disabled).toBe(true);
        expect(orders.textContent).toContain('주문 목록 확인 불가');
    });

    // Regression: ISSUE-008 — Back from an initialRequestId detail left focus on the document body.
    it('moves focus to the overview heading when returning from a direct detail entry', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory });
            if (url.pathname === '/api/admin/order-audit') return jsonResponse({ rows: [], nextCursor: null });
            if (url.pathname === `/api/admin/order-audit/${requestId}`) {
                return jsonResponse({ summary, section: 'summary', rows: [], total: 0, nextCursor: null });
            }
            return jsonResponse({ error: 'not found' }, 404);
        }));

        renderWorkbench(requestId);
        await settle();
        const back = [...container!.querySelectorAll('button')].find(button => button.textContent === '← 주문 목록')!;
        await act(async () => back.click());
        await settle();

        const overviewHeading = container!.querySelector('h1');
        expect(overviewHeading?.textContent).toBe('판독 운영 콘솔');
        expect(overviewHeading?.getAttribute('tabindex')).toBe('-1');
        expect(document.activeElement).toBe(overviewHeading);
    });
});
