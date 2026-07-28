'use client';

import { type ReactNode, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import {
    enforceAmplitudeReplayRoutePrivacy,
    initAmplitude,
    installAmplitudeReplayNavigationGuards,
    isCanonicalAnalyticsUserId,
    markAnalyticsIdentityPending,
    markAnalyticsIdentityReady,
    teardownAmplitudeSessionReplay,
} from '@/lib/services/analytics';
import {
    analyticsAuthProvider,
    availableAnalyticsSessionStorage,
    completePendingAuthEvent,
    type AuthMarkerStorage,
} from '@/lib/services/analytics-auth';

export interface AuthAnalyticsState {
    provider: 'google' | 'kakao' | null;
    resolved: boolean;
    userId: string | null;
}

interface AuthAnalyticsSnapshot {
    loading: boolean;
    provider: 'google' | 'kakao' | null;
    storage?: AuthMarkerStorage;
    userId: string | null;
}

export function createAuthAnalyticsState(): AuthAnalyticsState {
    return { provider: null, resolved: false, userId: null };
}

export async function syncAnalyticsAuth(
    state: AuthAnalyticsState,
    snapshot: AuthAnalyticsSnapshot,
    isCurrent: () => boolean = () => true,
): Promise<AuthAnalyticsState> {
    if (snapshot.loading) return state;

    const userId = snapshot.userId && isCanonicalAnalyticsUserId(snapshot.userId)
        ? snapshot.userId
        : null;
    const provider = userId ? snapshot.provider : null;
    if (state.resolved && state.userId === userId && state.provider === provider) return state;

    markAnalyticsIdentityPending();
    let initialized = await initAmplitude(userId);
    if (!initialized && isCurrent()) {
        initialized = await initAmplitude(userId);
    }
    if (!initialized || !isCurrent()) return state;

    if (userId) {
        completePendingAuthEvent({
            provider,
            storage: snapshot.storage,
            userId,
        });
    }
    markAnalyticsIdentityReady();

    return { provider, resolved: true, userId };
}

interface AmplitudeProviderProps {
    children: ReactNode;
}

function AmplitudeProviderClient({ children }: AmplitudeProviderProps) {
    const { loading, user } = useAuth();
    const authState = useRef(createAuthAnalyticsState());
    const transitionGeneration = useRef(0);

    useLayoutEffect(() => {
        enforceAmplitudeReplayRoutePrivacy();
    }, []);

    useLayoutEffect(() => installAmplitudeReplayNavigationGuards(), []);

    useEffect(() => teardownAmplitudeSessionReplay, []);

    useEffect(() => {
        const generation = transitionGeneration.current + 1;
        transitionGeneration.current = generation;
        let active = true;
        const snapshot = {
            loading,
            provider: analyticsAuthProvider(
                user?.app_metadata?.provider ?? user?.identities?.[0]?.provider,
            ),
            storage: availableAnalyticsSessionStorage(),
            userId: user?.id ?? null,
        };

        void syncAnalyticsAuth(
            authState.current,
            snapshot,
            () => active && transitionGeneration.current === generation,
        ).then((nextState) => {
            if (active && transitionGeneration.current === generation) {
                authState.current = nextState;
            }
        });

        return () => {
            active = false;
        };
    }, [loading, user?.id, user?.app_metadata?.provider, user?.identities]);

    return (
        <>
            <Suspense fallback={null}>
                <AmplitudeReplayRouteObserver />
            </Suspense>
            {children}
        </>
    );
}

function AmplitudeReplayRouteObserver() {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    useEffect(() => {
        // Do not pass a path, query, request ID, or token to the SDK. The analytics adapter
        // reads the browser location only to make the binary capture/no-capture decision.
        void pathname;
        void searchParams;
        enforceAmplitudeReplayRoutePrivacy();
    }, [pathname, searchParams]);

    return null;
}

export function AmplitudeProvider({ children }: AmplitudeProviderProps) {
    // useSearchParams makes query-bearing URLs fail closed before they can be replayed.
    // Only the zero-DOM route observer suspends; the product subtree is mounted exactly once.
    return <AmplitudeProviderClient>{children}</AmplitudeProviderClient>;
}
