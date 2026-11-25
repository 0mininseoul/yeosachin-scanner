import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { expect, vi } from 'vitest';
import { GET } from '@/app/api/analysis/v2/result/[requestId]/route';
import ResultPage from '@/app/result/[requestId]/page';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};

export async function assertOwnerPage(requestId: string, candidate: string, kind: 'public' | 'private' = 'public') {
    const location = DEV_UI_APP_ORIGIN + '/result/' + requestId + '?devAnalysis=live';
    const { window } = new JSDOM('<div id="root"></div>', { url: location });
    const requested: string[] = [];
    const route = '/api/analysis/v2/result/' + requestId;
    const params = Promise.resolve({ requestId });
    let imagePath: string | undefined;
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('self', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, location);
        requested.push(url.pathname);
        if (url.origin !== DEV_UI_APP_ORIGIN || url.pathname !== route)
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
