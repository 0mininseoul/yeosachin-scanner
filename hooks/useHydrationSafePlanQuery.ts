'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { parseEarlybirdPlanParam } from '@/lib/services/earlybird/ui-state';

type PlanListener = () => void;

let currentPlan: PlanId | null = null;
const listeners = new Set<PlanListener>();

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

/**
 * Zero-DOM observer for the official Next navigation signal. Mount this inside
 * a narrow Suspense boundary so a search-param update never remounts product UI.
 */
export function HydrationSafePlanQueryObserver() {
    const searchParams = useSearchParams();
    const plan = parseEarlybirdPlanParam(searchParams.get('plan'));

    useLayoutEffect(() => {
        publishPlan(plan);
        return () => {
            if (currentPlan === plan) publishPlan(null);
        };
    }, [plan]);

    return null;
}

/**
 * The null server snapshot keeps SSR and the first client render identical.
 * The observer subsequently publishes official client-router query changes.
 */
export function useHydrationSafePlanQuery(): PlanId | null {
    return useSyncExternalStore(subscribe, readClientPlan, readServerPlan);
}

export const __test__ = {
    listenerCount: () => listeners.size,
    reset: () => {
        currentPlan = null;
        listeners.clear();
    },
};
