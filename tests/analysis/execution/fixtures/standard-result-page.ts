import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { expect, vi } from 'vitest';
import { GET } from '@/app/api/analysis/v2/result/[requestId]/route';
import ResultPage from '@/app/result/[requestId]/page';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};

export async function assertOwnerPage(
    requestId: string, candidate: string, kind: 'public' | 'private' = 'public', expectScopeNote = false,
    pageUrl = DEV_UI_APP_ORIGIN + '/result/' + requestId + '?devAnalysis=live',
) {
    const location = new URL(pageUrl);
    const { window } = new JSDOM('<div id="root"></div>', { url: location.href });
    const requested: string[] = [];
    const route = '/api/analysis/v2/result/' + requestId;
    const params = Promise.resolve({ requestId });
    let imagePath: string | undefined;
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('self', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, location);
        // The normal result page warms its optional share control on mount.
        // This result-access fixture keeps that separate write offline.
        if (location.searchParams.get('pipeline') === 'v2' && url.origin === location.origin
            && url.pathname === '/api/share/enable' && init?.method === 'POST') {
            return Response.json({}, { status: 503 });
        }
        requested.push(url.pathname);
        if (url.origin !== location.origin || url.pathname !== route)
            throw new Error('Unexpected page request');
        const response = await GET(new Request(url), { params });
        const payload = await response.clone().json();
        const accounts = kind === 'private' ? payload.privateAccounts : payload.femaleAccounts;
        imagePath = accounts.find(
            (item: { instagramId: string }) => item.instagramId === candidate,
        )?.profileImage;
        return response;
    });
    const { createRoot } = await import('react-dom/client');
    const container = window.document.getElementById('root')!;
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(ResultPage, { params })));
        if (kind === 'private') {
            const button = () => Array.from(container.querySelectorAll('button')).find(
                node => node.textContent?.startsWith('비공개 계정'),
            );
            await vi.waitFor(() => expect(button()).toBeDefined());
            await act(async () => button()!.click());
        }
        await vi.waitFor(async () => {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
            });
            expect(container.textContent).toContain('@' + candidate);
        });
        const scopeNotes = Array.from(container.querySelectorAll('aside'))
            .filter(aside => aside.textContent?.includes('역방향 좋아요 확인 범위'));
        expect(scopeNotes).toHaveLength(expectScopeNote ? 1 : 0);
        if (expectScopeNote) {
            expect(scopeNotes[0]!.textContent).toContain('추가된 후보 1명');
            expect(scopeNotes[0]!.textContent).toContain('제외된 후보 0명');
            expect(scopeNotes[0]!.textContent).toContain('미수집');
        }
        expect(requested).toEqual([route]);
        if (!imagePath) throw new Error('Owner result response lacks the candidate image');
        const imageUrl = new URL(imagePath, location).href;
        const candidateImage = Array.from(container.querySelectorAll('img')).find(
            (image) => image.src === imageUrl,
        );
        expect(candidateImage).toBeDefined();
        return candidateImage!.src;
    } finally {
        await act(async () => root.unmount());
        window.close();
        vi.stubGlobal('fetch', previousFetch);
    }
}
