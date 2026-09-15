/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfilePreviewDialog } from '@/components/profile-preview-dialog';

let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
});

describe('profile preview dialog', () => {
    it('moves focus into the dialog, traps Tab, closes on Escape, and restores its trigger', () => {
        const trigger = document.createElement('button');
        trigger.textContent = '프로필 보기';
        document.body.append(trigger);
        trigger.focus();
        const onClose = vi.fn();
        container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        act(() => {
            root.render(createElement(ProfilePreviewDialog, {
                profile: { instagramId: 'willow.archive', fullName: '강다온' },
                onClose,
            }));
        });

        const dialog = container.querySelector('[role="dialog"]')!;
        const close = dialog.querySelector('button')!;
        expect(document.activeElement).toBe(close);
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(document.activeElement).toBe(close);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(onClose).toHaveBeenCalledOnce();

        act(() => root.unmount());
        expect(document.activeElement).toBe(trigger);
    });
});
