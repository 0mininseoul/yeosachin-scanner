/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function installFetch(): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory: [] });
        if (url.pathname === '/api/admin/order-audit') return jsonResponse({ rows: [listRow], nextCursor: null });
        if (url.pathname === `/api/admin/order-audit/${requestId}`) {
            return jsonResponse({ summary, section: 'summary', rows: [], total: 0, nextCursor: null });
        }
        return jsonResponse({ error: 'not found' }, 404);
    }));
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

describe('operator console detail navigation', () => {
    // Regression: ISSUE-002 — detail navigation kept the overview scroll and dropped keyboard focus.
    // Found by /qa on 2026-09-08
    // Report: reports/admin-console-verification-20260908/report.md
    it('moves to the detail top, focuses Back, and restores the order trigger on return', async () => {
        installFetch();

        container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        act(() => root.render(createElement(AnalysisAuditWorkbench, { initialRequestId: '' })));
        await settle();

        const orderButton = container.querySelector('button.oc-link.oc-mono') as HTMLButtonElement | null;
        expect(orderButton).toBeTruthy();
        document.documentElement.scrollTop = 640;
        orderButton!.focus();
        await act(async () => orderButton!.click());
        await settle();

        const backButton = [...container.querySelectorAll('button')]
            .find(button => button.textContent === '← 주문 목록');
        expect(container.querySelector('h1')?.textContent).toBe('@synthetic.target');
        expect(document.activeElement).toBe(backButton);
        expect(document.documentElement.scrollTop).toBe(0);

        await act(async () => backButton!.click());
        await settle();

        const restoredOrderButton = container.querySelector('button.oc-link.oc-mono');
        expect(document.activeElement).toBe(restoredOrderButton);
        expect(document.documentElement.scrollTop).toBe(640);
    });
});
