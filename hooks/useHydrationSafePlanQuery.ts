'use client';

import { useSyncExternalStore } from 'react';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { parseEarlybirdPlanParam } from '@/lib/services/earlybird/ui-state';

function subscribeToLocation(listener: () => void) {
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
}

function readClientPlanQuery(): PlanId | null {
    return parseEarlybirdPlanParam(new URLSearchParams(window.location.search).get('plan'));
}

function readServerPlanQuery(): null {
    return null;
}

/**
 * Reads a return-link plan only after the initial hydration snapshot. The null
 * server snapshot keeps SSR and the first client render identical, while the
 * external-store update selects the linked plan without an effect state write.
 */
export function useHydrationSafePlanQuery(): PlanId | null {
    return useSyncExternalStore(
        subscribeToLocation,
        readClientPlanQuery,
        readServerPlanQuery,
    );
}
