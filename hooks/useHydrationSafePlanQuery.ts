'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { parseEarlybirdPlanParam } from '@/lib/services/earlybird/ui-state';
import {
    checkoutContinuationPlan,
    hasCheckoutContinuationIntent,
} from '@/lib/services/earlybird/post-login-checkout';

type PlanListener = () => void;

let currentPlan: PlanId | null = null;
const listeners = new Set<PlanListener>();
let currentCheckoutPlan: PlanId | null = null;
const checkoutListeners = new Set<PlanListener>();

function subscribe(listener: PlanListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function readClientPlan(): PlanId | null {
    return currentPlan;
}

function readServerPlan(): null {
    return null;
}

function publishPlan(nextPlan: PlanId | null) {
    if (currentPlan === nextPlan) return;
    currentPlan = nextPlan;
    listeners.forEach(listener => listener());
}

function subscribeCheckout(listener: PlanListener) {
    checkoutListeners.add(listener);
    return () => checkoutListeners.delete(listener);
}

function readClientCheckoutPlan(): PlanId | null {
    return currentCheckoutPlan;
}

function publishCheckoutPlan(nextPlan: PlanId | null) {
    if (currentCheckoutPlan === nextPlan) return;
    currentCheckoutPlan = nextPlan;
    checkoutListeners.forEach(listener => listener());
}

/**
 * Zero-DOM observer for the official Next navigation signal. Mount this inside
 * a narrow Suspense boundary so a search-param update never remounts product UI.
 */
export function HydrationSafePlanQueryObserver() {
    const searchParams = useSearchParams();
    const plan = parseEarlybirdPlanParam(searchParams.get('plan'));
    const checkoutPlan = hasCheckoutContinuationIntent(searchParams)
        ? checkoutContinuationPlan(searchParams)
        : null;

    useLayoutEffect(() => {
        publishPlan(plan);
        publishCheckoutPlan(checkoutPlan);
        return () => {
            if (currentPlan === plan) publishPlan(null);
            if (currentCheckoutPlan === checkoutPlan) publishCheckoutPlan(null);
        };
    }, [checkoutPlan, plan]);

    return null;
}

/**
 * The null server snapshot keeps SSR and the first client render identical.
 * The observer subsequently publishes official client-router query changes.
 */
export function useHydrationSafePlanQuery(): PlanId | null {
    return useSyncExternalStore(subscribe, readClientPlan, readServerPlan);
}

/**
 * Reads the complete OAuth checkout intent from the client navigation observer
 * without making the product UI depend directly on `useSearchParams`.
 */
export function useHydrationSafeCheckoutPlanQuery(): PlanId | null {
    return useSyncExternalStore(subscribeCheckout, readClientCheckoutPlan, readServerPlan);
}

export const __test__ = {
    listenerCount: () => listeners.size,
    checkoutListenerCount: () => checkoutListeners.size,
    reset: () => {
        currentPlan = null;
        listeners.clear();
        currentCheckoutPlan = null;
        checkoutListeners.clear();
    },
};
