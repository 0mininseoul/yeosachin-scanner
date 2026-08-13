// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDelayNotice } from './archive-delay-notice';
import {
    ARCHIVE_DELAY_NOTICE_SNOOZE_MS,
    ARCHIVE_DELAY_NOTICE_STORAGE_KEY,
    encodeDelayNoticeDismissal,
} from '@/lib/services/analysis/archive-delay-notice';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const trackEvent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/analytics', () => ({
    trackEvent,
    ARCHIVE_NOTICE_EVENTS: {
        DELAY_SHOWN: 'archive_delay_notice_shown',
        DELAY_DISMISSED: 'archive_delay_notice_dismissed',
    },
}));

let container: HTMLDivElement;
let root: Root;

function render() {
    act(() => {
        root.render(createElement(ArchiveDelayNotice));
    });
}

function dialog() {
    return container.querySelector('[role="dialog"]');
}

function buttonByText(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')]
        .find(element => element.textContent?.trim() === text);
    if (!found) throw new Error(`button not found: ${text}`);
    return found;
}

beforeEach(() => {
    window.localStorage.clear();
    trackEvent.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

describe('ArchiveDelayNotice', () => {
    it('opens on mount and reports the impression once', () => {
        render();

        expect(dialog()).not.toBeNull();
        expect(trackEvent).toHaveBeenCalledWith('archive_delay_notice_shown');
    });

    it('names itself for assistive technology', () => {
        render();

        const labelledBy = dialog()?.getAttribute('aria-labelledby');
        expect(dialog()?.getAttribute('aria-modal')).toBe('true');
        expect(container.querySelector(`#${labelledBy}`)?.textContent)
            .toBe('조금만 더 기다려 주세요');
    });

    it('promises delivery within two days', () => {
        render();

        expect(dialog()?.textContent)
            .toContain('늦어도 2일 이내에 가입하신 이메일로 결과 링크를 보내드릴게요.');
    });

    it('snoozes for 24 hours after 확인했어요', () => {
        render();
        act(() => buttonByText('확인했어요').click());

        expect(dialog()).toBeNull();
        expect(trackEvent).toHaveBeenCalledWith('archive_delay_notice_dismissed', {
            notice_dismiss_scope: 'snoozed',
        });
    });

    it('suppresses permanently after 다시 보지 않기', () => {
        render();
        act(() => buttonByText('다시 보지 않기').click());

        expect(trackEvent).toHaveBeenCalledWith('archive_delay_notice_dismissed', {
            notice_dismiss_scope: 'permanent',
        });

        act(() => root.unmount());
        root = createRoot(container);
        render();
        expect(dialog()).toBeNull();
    });

    it('stays closed while a snooze is live and returns once it expires', () => {
        const now = Date.now();
        window.localStorage.setItem(
            ARCHIVE_DELAY_NOTICE_STORAGE_KEY,
            encodeDelayNoticeDismissal('snoozed', now),
        );

        render();
        expect(dialog()).toBeNull();
        expect(trackEvent).not.toHaveBeenCalled();

        act(() => root.unmount());
        vi.useFakeTimers();
        vi.setSystemTime(now + ARCHIVE_DELAY_NOTICE_SNOOZE_MS + 1);
        root = createRoot(container);
        render();
        expect(dialog()).not.toBeNull();
    });

    it('closes on Escape and restores the page scroll lock', () => {
        render();
        expect(document.body.style.overflow).toBe('hidden');

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

        expect(dialog()).toBeNull();
        expect(document.body.style.overflow).toBe('');
        expect(trackEvent).toHaveBeenCalledWith('archive_delay_notice_dismissed', {
            notice_dismiss_scope: 'snoozed',
        });
    });
});
