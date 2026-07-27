// @vitest-environment jsdom

import { createElement } from 'react';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHydrationSafePlanQuery } from '@/hooks/useHydrationSafePlanQuery';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function PlanProbe() {
    const plan = useHydrationSafePlanQuery();
    return createElement('output', null, plan ?? 'none');
}

describe('hydration-safe linked plan query', () => {
    let root: ReturnType<typeof hydrateRoot> | null = null;

    afterEach(() => {
        root?.unmount();
        root = null;
        window.history.replaceState({}, '', '/analyze');
        vi.restoreAllMocks();
    });

    it('hydrates the linked plan after an identical server and first-client snapshot', async () => {
        window.history.replaceState({}, '', '/analyze?plan=standard');
        const recoverable = vi.fn();
        const html = renderToString(createElement(PlanProbe));
        expect(html).toContain('none');

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.append(container);
        try {
            await act(async () => {
                root = hydrateRoot(container, createElement(PlanProbe), {
                    onRecoverableError: recoverable,
                });
                await new Promise(resolve => window.setTimeout(resolve, 0));
            });

            expect(recoverable).not.toHaveBeenCalled();
            expect(container.textContent).toBe('standard');
        } finally {
            await act(async () => root?.unmount());
            root = null;
            container.remove();
        }
    });
});
