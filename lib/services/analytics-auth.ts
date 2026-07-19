'use client';

import {
    EVENTS,
    type AnalyticsAuthProvider,
    isCanonicalAnalyticsUserId,
    trackEvent,
} from './analytics';

const AUTH_STARTED_STORAGE_KEY = 'amplitude_auth_started';
const AUTH_MARKER_TTL_MS = 15 * 60_000;

export type AuthMarkerStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

interface PendingAuthMarker {
    provider: AnalyticsAuthProvider;
    started_at: number;
}

interface BeginPendingAuthEventInput {
    now?: number;
    provider: AnalyticsAuthProvider;
    storage?: AuthMarkerStorage;
}

interface CompletePendingAuthEventInput {
    now?: number;
    provider: AnalyticsAuthProvider | null;
    storage?: AuthMarkerStorage;
    userId: string | null;
}

export function analyticsAuthProvider(value: unknown): AnalyticsAuthProvider | null {
    return value === 'google' || value === 'kakao' ? value : null;
}

export function availableAnalyticsSessionStorage(): AuthMarkerStorage | undefined {
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

export function beginPendingAuthEvent({
    now = Date.now(),
    provider,
    storage,
}: BeginPendingAuthEventInput): boolean {
    let stored = false;

    try {
        storage?.setItem(AUTH_STARTED_STORAGE_KEY, JSON.stringify({
            provider,
            started_at: now,
        } satisfies PendingAuthMarker));
        stored = Boolean(storage);
    } catch {
        stored = false;
    }

    trackEvent(EVENTS.AUTH_STARTED, { provider });
    return stored;
}

export function clearPendingAuthEvent(storage?: AuthMarkerStorage): void {
    try {
        storage?.removeItem(AUTH_STARTED_STORAGE_KEY);
    } catch {
        // Storage is optional; OAuth behavior must continue without analytics state.
    }
}

function readPendingMarker(storage: AuthMarkerStorage): PendingAuthMarker | null {
    try {
        const raw = storage.getItem(AUTH_STARTED_STORAGE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const provider = analyticsAuthProvider(Reflect.get(parsed, 'provider'));
        const startedAt = Reflect.get(parsed, 'started_at');
        if (!provider || typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt)) {
            return null;
        }
        return { provider, started_at: startedAt };
    } catch {
        return null;
    }
}

export function completePendingAuthEvent({
    now = Date.now(),
    provider,
    storage,
    userId,
}: CompletePendingAuthEventInput): boolean {
    if (!storage || !provider || !userId || !isCanonicalAnalyticsUserId(userId)) return false;

    const marker = readPendingMarker(storage);
    if (!marker) return false;

    const age = now - marker.started_at;
    if (marker.provider !== provider || age < 0 || age > AUTH_MARKER_TTL_MS) {
        clearPendingAuthEvent(storage);
        return false;
    }

    try {
        storage.removeItem(AUTH_STARTED_STORAGE_KEY);
    } catch {
        return false;
    }

    trackEvent(EVENTS.AUTH_COMPLETED, { provider });
    return true;
}
