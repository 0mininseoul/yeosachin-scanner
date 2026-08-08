// @vitest-environment jsdom

import { createElement, Suspense, useEffect } from 'react';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
    useSearchParams: () => navigation.searchParams,
}));

import {
    __test__,
    HydrationSafePlanQueryObserver,
    useHydrationSafeCheckoutPlanQuery,
    useHydrationSafePlanQuery,
} from '@/hooks/useHydrationSafePlanQuery';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function PlanProbe() {
    const plan = useHydrationSafePlanQuery();
    return createElement('output', null, plan ?? 'none');
}

function CheckoutProbe() {
    const plan = useHydrationSafeCheckoutPlanQuery();
    return createElement('output', null, plan ?? 'none');
}

function QueryObserverBoundary() {
    return createElement(
        Suspense,
        { fallback: null },
        createElement(HydrationSafePlanQueryObserver),
    );
}

function ProductProbe({ onMount }: { onMount: () => void }) {
    useEffect(onMount, [onMount]);
    return createElement(PlanProbe);
}

function App({ onProductMount, probes = 1 }: { onProductMount: () => void; probes?: number }) {
    return createElement(
        'main',
        null,
        createElement(QueryObserverBoundary),
        createElement(ProductProbe, { onMount: onProductMount }),
        ...Array.from({ length: probes - 1 }, (_, index) => createElement(PlanProbe, { key: index })),
    );
}

function CheckoutApp() {
    return createElement(
        'main',
        null,
        createElement(QueryObserverBoundary),
        createElement(CheckoutProbe),
    );
}

describe('hydration-safe linked plan query', () => {
    let root: ReturnType<typeof hydrateRoot> | null = null;

    afterEach(async () => {
        await act(async () => root?.unmount());
        root = null;
        __test__.reset();
        navigation.searchParams = new URLSearchParams();
        vi.restoreAllMocks();
    });

    it('hydrates without a mismatch, then updates the linked plan through the client navigation observer', async () => {
        navigation.searchParams = new URLSearchParams('plan=standard');
        const recoverable = vi.fn();
        const productMounted = vi.fn();
        const html = renderToString(createElement(App, { onProductMount: productMounted }));
        expect(html).toContain('none');

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.append(container);
        try {
            await act(async () => {
                root = hydrateRoot(container, createElement(App, {
                    onProductMount: productMounted,
                }), { onRecoverableError: recoverable });
                await new Promise(resolve => window.setTimeout(resolve, 0));
            });

            expect(recoverable).not.toHaveBeenCalled();
            expect(container.textContent).toBe('standard');
            expect(productMounted).toHaveBeenCalledTimes(1);

            navigation.searchParams = new URLSearchParams('plan=plus');
            await act(async () => {
                root!.render(createElement(App, { onProductMount: productMounted }));
                await new Promise(resolve => window.setTimeout(resolve, 0));
            });

            expect(container.textContent).toBe('plus');
            expect(productMounted).toHaveBeenCalledTimes(1);
        } finally {
            container.remove();
        }
    });

    it('cleans up all external-store subscribers for multiple product consumers', async () => {
        navigation.searchParams = new URLSearchParams('plan=basic');
        const html = renderToString(createElement(App, { onProductMount: () => undefined, probes: 2 }));
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.append(container);
        try {
            await act(async () => {
                root = hydrateRoot(container, createElement(App, {
                    onProductMount: () => undefined,
                    probes: 2,
                }));
                await new Promise(resolve => window.setTimeout(resolve, 0));
            });
            expect(__test__.listenerCount()).toBe(2);
            await act(async () => root?.unmount());
            root = null;
            expect(__test__.listenerCount()).toBe(0);
        } finally {
            container.remove();
        }
    });

    it('publishes only a complete checkout continuation before the product snapshot is ready', async () => {
        navigation.searchParams = new URLSearchParams(
            'preflight=223e4567-e89b-42d3-a456-426614174000&checkout=1&plan=standard'
        );
        const html = renderToString(createElement(CheckoutApp));
        expect(html).toContain('none');

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.append(container);
        try {
            await act(async () => {
                root = hydrateRoot(container, createElement(CheckoutApp));
                await new Promise(resolve => window.setTimeout(resolve, 0));
            });
            expect(container.textContent).toBe('standard');

            navigation.searchParams = new URLSearchParams('plan=standard');
            await act(async () => {
                root!.render(createElement(CheckoutApp));
                await new Promise(resolve => window.setTimeout(resolve, 0));
            });
            expect(container.textContent).toBe('none');
        } finally {
            container.remove();
        }
    });
});
