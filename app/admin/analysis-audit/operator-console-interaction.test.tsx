/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisAuditWorkbench } from './workbench';

const requestId = '10000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);
const timestamp = '2026-09-05T08:00:00.000Z';

const summary = {
    requestId,
    version: 1,
    bundleHash: hash,
    previousVersionHash: null,
    sourceSetHash: hash,
    status: 'partial' as const,
    completeness: 'partial' as const,
    gapCodes: ['TARGET_POSTS_MISSING'],
    pipelineVersion: 'v2' as const,
    pipelinePolicy: {},
    riskPolicyVersion: null,
    aiPolicyVersion: null,
    schedulerPolicyVersion: null,
    planId: 'basic' as const,
    accessMode: 'production' as const,
    orderId: null,
    targetInstagramId: 'target.account',
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
    retention: {
        state: 'retained' as const,
        queueStatus: 'completed' as const,
        version: 1,
        assembledAt: timestamp,
        purgeFencedAt: null,
        purgeFenceReason: null,
        purgedAt: null,
        queueUpdatedAt: timestamp,
    },
    assembledAt: timestamp,
    cost: {
        currency: 'USD',
        status: 'complete' as const,
        knownUsd: 0.12,
        conservativeUsd: 0.14,
        usageUnknown: false,
    },
    usageUnknown: false,
};

const listRow = {
    requestId,
    orderId: null,
    targetInstagramId: 'target.account',
    planId: 'basic' as const,
    version: 1,
    completenessStatus: 'partial' as const,
    gapCodes: ['TARGET_POSTS_MISSING'],
    cost: { status: 'complete' as const, knownUsd: 0.12, conservativeUsd: 0.14, usageUnknown: false },
    gender: { initialResolved: 1, finalResolved: 1 },
    risk: { declared: 1, collected: 1 },
    retention: summary.retention,
    stageStatus: {
        relationships: true,
        targetEvidence: true,
        candidateFeatures: true,
        riskScores: true,
        finalized: true,
    },
    assembledAt: timestamp,
};

const mutualRow = {
    candidateId: 'candidate:1',
    username: 'mutual.account',
    mutualOrdinal: 1,
    followingOrdinal: 1,
    isPrivate: false,
    isVerified: false,
    profileAvailable: true,
    profileImageAvailable: false,
    profileFailureCode: null,
    finalInclusionState: 'included' as const,
    completeness: 'complete' as const,
};

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function mutualResponse(nextCursor: number | null = null): Response {
    return jsonResponse({
        summary,
        section: 'mutuals',
        rows: [mutualRow],
        total: 1,
        nextCursor,
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function installWorkbenchFetch(
    onMutualRequest: (requestNumber: number) => Response | Promise<Response> = () => mutualResponse(),
): { fetchMock: ReturnType<typeof vi.fn>; mutualRequestCount: () => number } {
    let mutualRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory: [] });
        if (url.pathname === '/api/admin/order-audit') {
            return jsonResponse({ rows: [listRow], nextCursor: null });
        }
        if (url.pathname === `/api/admin/order-audit/${requestId}`) {
            const section = url.searchParams.get('section');
            if (section === 'summary') return jsonResponse({ summary, section, rows: [], total: 0, nextCursor: null });
            if (section === 'mutuals') {
                mutualRequests += 1;
                return onMutualRequest(mutualRequests);
            }
        }
        return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, mutualRequestCount: () => mutualRequests };
}

let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.restoreAllMocks();
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
});

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

function renderWorkbench(): void {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
        root.render(createElement(AnalysisAuditWorkbench, { initialRequestId: '' }));
    });
}

async function openMutualStage(): Promise<{ stage: Element; header: HTMLButtonElement }> {
    await settle();
    const orderLink = container!.querySelector('button.oc-link.oc-mono');
    expect(orderLink).toBeTruthy();
    await act(async () => orderLink!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const stage = container!.querySelector('.oc-stage');
    const header = stage?.querySelector('.oc-stage-header') as HTMLButtonElement | null;
    expect(header).toBeTruthy();
    await act(async () => header!.click());
    await settle();
    await settle();
    return { stage: stage!, header: header! };
}

describe('production operator console interactions', () => {
    it('renders unknown inventory, paginates orders, and expands a paginated evidence stage', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory: [] });
            if (url.pathname === '/api/admin/order-audit') {
                if (url.searchParams.has('cursorAssembledAt')) return jsonResponse({ rows: [], nextCursor: null });
                return jsonResponse({
                    rows: [listRow],
                    nextCursor: { assembledAt: timestamp, requestId },
                });
            }
            if (url.pathname === `/api/admin/order-audit/${requestId}`) {
                const section = url.searchParams.get('section');
                if (section === 'summary') return jsonResponse({ summary, section, rows: [], total: 0, nextCursor: null });
                if (section === 'mutuals') {
                    const cursor = Number(url.searchParams.get('cursor') ?? '0');
                    return jsonResponse({
                        summary,
                        section,
                        rows: cursor === 0 ? [mutualRow] : [],
                        total: 26,
                        nextCursor: cursor === 0 ? 25 : null,
                    });
                }
            }
            return jsonResponse({ error: 'not found' }, 404);
        });
        vi.stubGlobal('fetch', fetchMock);

        container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        act(() => {
            root.render(createElement(AnalysisAuditWorkbench, { initialRequestId: '' }));
        });
        await settle();

        expect(container.textContent).toContain('secondary');
        expect(container.textContent).toContain('무료 계정 9개');
        expect(container.textContent).toContain('미상');
        expect(container.textContent).toContain('@target.account');

        const orderPageButton = [...container.querySelectorAll('button')]
            .find(button => button.textContent?.includes('다음 25건'));
        expect(orderPageButton).toBeDefined();
        await act(async () => orderPageButton!.click());
        await settle();
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('cursorAssembledAt='))).toBe(true);

        const orderLink = container.querySelector('button.oc-link.oc-mono');
        expect(orderLink).toBeTruthy();
        await act(async () => orderLink!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await settle();
        expect(container.textContent).toContain('증거 단계');
        expect(container.textContent).toContain('영구 보관됨');

        const firstStage = container.querySelector('.oc-stage')!;
        const stageButton = firstStage.querySelector('.oc-stage-header') as HTMLButtonElement;
        expect(stageButton.getAttribute('aria-expanded')).toBe('false');
        expect(stageButton.getAttribute('aria-controls')).toContain('evidence-');
        await act(async () => stageButton.click());
        await settle();
        expect(stageButton.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('@mutual.account');
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('section=mutuals'))).toBe(true);

        const stageNext = [...firstStage.querySelectorAll('button')]
            .find(button => button.textContent?.includes('다음 25건'));
        expect(stageNext).toBeDefined();
        await act(async () => stageNext!.click());
        await settle();
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('section=mutuals') && String(input).includes('cursor=25'))).toBe(true);
    });

    it('shows loading for a fresh request after closing and reopening a completed stage', async () => {
        const secondRequest = deferred<Response>();
        const { mutualRequestCount } = installWorkbenchFetch(requestNumber => (
            requestNumber === 2 ? secondRequest.promise : mutualResponse()
        ));
        renderWorkbench();

        const { header } = await openMutualStage();
        expect(container!.textContent).toContain('@mutual.account');
        expect(mutualRequestCount()).toBe(1);

        await act(async () => header.click());
        await act(async () => {
            header.click();
            await Promise.resolve();
        });
        expect(header.getAttribute('aria-expanded')).toBe('true');
        expect(container!.querySelector('.oc-stage .oc-loading')).toBeTruthy();
        expect(mutualRequestCount()).toBe(2);

        secondRequest.resolve(mutualResponse());
        await settle();
        expect(container!.textContent).toContain('@mutual.account');
        expect(container!.querySelector('.oc-stage .oc-loading')).toBeNull();
    });

    it('does nothing when selecting the already-selected filter', async () => {
        const { mutualRequestCount } = installWorkbenchFetch();
        renderWorkbench();

        const { stage } = await openMutualStage();
        const filterButton = [...stage.querySelectorAll('.oc-stage-tools .oc-button')]
            .find(button => button.textContent === '전체');
        expect(filterButton).toBeTruthy();
        expect(mutualRequestCount()).toBe(1);

        await act(async () => filterButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(mutualRequestCount()).toBe(1);
        expect(container!.textContent).toContain('@mutual.account');
        expect(container!.querySelector('.oc-stage .oc-loading')).toBeNull();
    });

    it('does nothing when selecting the current evidence cursor', async () => {
        const { mutualRequestCount } = installWorkbenchFetch(() => mutualResponse(0));
        renderWorkbench();

        const { stage } = await openMutualStage();
        const nextButton = [...stage.querySelectorAll('.oc-pager .oc-button')]
            .find(button => button.textContent?.includes('다음 25건'));
        expect(nextButton).toBeTruthy();
        expect(mutualRequestCount()).toBe(1);

        await act(async () => nextButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(mutualRequestCount()).toBe(1);
        expect(container!.textContent).toContain('@mutual.account');
        expect(container!.querySelector('.oc-stage .oc-loading')).toBeNull();
    });
});
