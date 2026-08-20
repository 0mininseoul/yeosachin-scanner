// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultActions } from './result-actions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const shareUrl = 'https://yeosachin.com/share/result-token';

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

function render(onShare: (channel: 'clipboard' | 'instagram_dm') => void) {
    act(() => {
        root.render(createElement(ResultActions, {
            onKakaoShare: vi.fn(),
            kakaoBusy: false,
            kakaoAvailable: false,
            shareUrl,
            onShare,
        }));
    });
}

function buttonByText(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')]
        .find(button => button.textContent?.trim() === text);
    if (!found) throw new Error(`button not found: ${text}`);
    return found;
}

function openMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (!trigger) throw new Error('share menu trigger not found');
    act(() => trigger.click());
}

beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
    });
    vi.spyOn(window, 'open').mockImplementation(() => null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe('ResultActions share analytics callbacks', () => {
    it('reports clipboard only after writeText resolves', async () => {
        const onShare = vi.fn();
        render(onShare);
        openMenu();

        await act(async () => {
            buttonByText('링크 복사').click();
            await Promise.resolve();
        });

        expect(writeText).toHaveBeenCalledWith(shareUrl);
        expect(onShare).toHaveBeenCalledWith('clipboard');
    });

    it('reports Instagram DM only after the link copy resolves', async () => {
        const onShare = vi.fn();
        render(onShare);
        openMenu();

        await act(async () => {
            buttonByText('DM 공유').click();
            await Promise.resolve();
        });

        expect(writeText).toHaveBeenCalledWith(shareUrl);
        expect(onShare).toHaveBeenCalledWith('instagram_dm');
    });

    it('does not report a failed copy as a share', async () => {
        const onShare = vi.fn();
        writeText.mockRejectedValue(new Error('denied'));
        render(onShare);
        openMenu();

        await act(async () => {
            buttonByText('링크 복사').click();
            await Promise.resolve();
        });

        expect(onShare).not.toHaveBeenCalled();
    });
});
