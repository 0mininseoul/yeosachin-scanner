import {
    initAmplitude,
    markAnalyticsIdentityPending,
    markAnalyticsIdentityReady,
} from './analytics';

const PENDING_TARGET_KEY = 'pending_ig';
const PENDING_TARGET_TTL_MS = 30 * 60_000;
const PREFLIGHT_DISPLAY_TARGET_KEY = 'preflight_display_target_v1';
const PREFLIGHT_DISPLAY_TARGET_TTL_MS = 30 * 60_000;
const TARGET_PATTERN = /^[A-Za-z0-9._]{1,30}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_TARGET_STATES = new Set([
    'blocked',
    'completed',
    'consumed',
    'expired',
    'failed',
    'ready',
]);
const PREFLIGHT_DISPLAY_TERMINAL_STATES = new Set([
    'blocked',
    'completed',
    'consumed',
    'expired',
    'failed',
    'ready',
]);

export type PendingTargetStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

interface StoredPendingTarget {
    owner_id?: string;
    preflight_id?: string;
    stored_at: number;
    target: string;
}

interface BindPendingTargetInput {
    now?: number;
    ownerId: string;
    preflightId: string;
    target: string;
}

interface ReadBoundPendingTargetInput {
    now?: number;
    ownerId: string;
    preflightId: string;
}

interface StoredPreflightDisplayTarget {
    preflight_id: string;
    stored_at: number;
    target: string;
}

interface PreflightDisplayTargetInput {
    now?: number;
    preflightId: string;
    target: string;
}

interface ReadPreflightDisplayTargetInput {
    now?: number;
    preflightId: string;
}

type BrowserSignOut = () => Promise<{ error: unknown | null }>;

async function browserSignOut(): Promise<{ error: unknown | null }> {
    const { createClient } = await import('@/lib/supabase/client');
    return createClient().auth.signOut();
}

function normalizePendingTarget(value: string): string | null {
    const normalized = value.trim().replace(/^@+/, '');
    if (!TARGET_PATTERN.test(normalized)) return null;
    if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) return null;
    return normalized;
}

function isCanonicalUuid(value: unknown): value is string {
    return typeof value === 'string' && CANONICAL_UUID.test(value);
}

function normalizePreflightDisplayTarget(value: string): string | null {
    return normalizePendingTarget(value)?.toLowerCase() ?? null;
}

function removePreflightDisplayTargetRecord(storage: PendingTargetStorage): boolean {
    try {
        storage.removeItem(PREFLIGHT_DISPLAY_TARGET_KEY);
        return true;
    } catch {
        // Display state is best-effort and must not interrupt navigation.
        return false;
    }
}

export function clearPendingAnalysisTarget(storage: PendingTargetStorage): void {
    try {
        storage.removeItem(PENDING_TARGET_KEY);
    } catch {
        // Session handoff is best-effort and must not interrupt navigation.
    }
}

export function availablePendingTargetStorage(): PendingTargetStorage | undefined {
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

function readPendingTargetRecord(
    storage: PendingTargetStorage,
    now: number,
): StoredPendingTarget | null {
    try {
        const raw = storage.getItem(PENDING_TARGET_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            clearPendingAnalysisTarget(storage);
            return null;
        }

        const storedAt = Reflect.get(parsed, 'stored_at');
        const target = Reflect.get(parsed, 'target');
        const ownerId = Reflect.get(parsed, 'owner_id');
        const preflightId = Reflect.get(parsed, 'preflight_id');
        const normalized = typeof target === 'string' ? normalizePendingTarget(target) : null;
        const age = typeof storedAt === 'number' ? now - storedAt : Number.NaN;
        const isUnbound = ownerId === undefined && preflightId === undefined;
        const isBound = isCanonicalUuid(ownerId) && isCanonicalUuid(preflightId);
        if (
            !normalized
            || !Number.isSafeInteger(storedAt)
            || age < 0
            || age > PENDING_TARGET_TTL_MS
            || (!isUnbound && !isBound)
        ) {
            clearPendingAnalysisTarget(storage);
            return null;
        }

        return {
            ...(isBound ? { owner_id: ownerId, preflight_id: preflightId } : {}),
            stored_at: storedAt,
            target: normalized,
        };
    } catch {
        clearPendingAnalysisTarget(storage);
        return null;
    }
}

export function storePendingAnalysisTarget(
    storage: PendingTargetStorage,
    target: string,
    now = Date.now(),
): boolean {
    const normalized = normalizePendingTarget(target);
    if (!normalized || !Number.isSafeInteger(now)) return false;

    try {
        storage.setItem(PENDING_TARGET_KEY, JSON.stringify({
            stored_at: now,
            target: normalized,
        } satisfies StoredPendingTarget));
        return true;
    } catch {
        return false;
    }
}

export function bindPendingAnalysisTarget(
    storage: PendingTargetStorage,
    {
        now = Date.now(),
        ownerId,
        preflightId,
        target,
    }: BindPendingTargetInput,
): boolean {
    const normalized = normalizePendingTarget(target);
    if (
        !normalized
        || !Number.isSafeInteger(now)
        || !isCanonicalUuid(ownerId)
        || !isCanonicalUuid(preflightId)
    ) return false;

    try {
        storage.setItem(PENDING_TARGET_KEY, JSON.stringify({
            owner_id: ownerId,
            preflight_id: preflightId,
            stored_at: now,
            target: normalized,
        } satisfies StoredPendingTarget));
        return true;
    } catch {
        return false;
    }
}

export function storePreflightDisplayTarget(
    storage: PendingTargetStorage,
    {
        now = Date.now(),
        preflightId,
        target,
    }: PreflightDisplayTargetInput,
): boolean {
    const normalized = normalizePreflightDisplayTarget(target);
    if (!normalized || !isCanonicalUuid(preflightId) || !Number.isSafeInteger(now)) {
        return false;
    }

    try {
        storage.setItem(PREFLIGHT_DISPLAY_TARGET_KEY, JSON.stringify({
            preflight_id: preflightId,
            stored_at: now,
            target: normalized,
        } satisfies StoredPreflightDisplayTarget));
        return true;
    } catch {
        return false;
    }
}

export function readPreflightDisplayTarget(
    storage: PendingTargetStorage,
    {
        now = Date.now(),
        preflightId,
    }: ReadPreflightDisplayTargetInput,
): string | null {
    if (!isCanonicalUuid(preflightId) || !Number.isSafeInteger(now)) return null;

    try {
        const raw = storage.getItem(PREFLIGHT_DISPLAY_TARGET_KEY);
        if (!raw) return null;

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            removePreflightDisplayTargetRecord(storage);
            return null;
        }
        if (!parsed || typeof parsed !== 'object') {
            removePreflightDisplayTargetRecord(storage);
            return null;
        }

        const storedPreflightId = Reflect.get(parsed, 'preflight_id');
        const storedAt = Reflect.get(parsed, 'stored_at');
        const target = Reflect.get(parsed, 'target');
        const normalized = typeof target === 'string'
            ? normalizePreflightDisplayTarget(target)
            : null;
        const age = typeof storedAt === 'number' ? now - storedAt : Number.NaN;
        if (
            !isCanonicalUuid(storedPreflightId)
            || storedPreflightId !== preflightId
            || !normalized
            || !Number.isSafeInteger(storedAt)
            || age < 0
            || age > PREFLIGHT_DISPLAY_TARGET_TTL_MS
        ) {
            removePreflightDisplayTargetRecord(storage);
            return null;
        }

        return normalized;
    } catch {
        return null;
    }
}

export function clearPreflightDisplayTarget(
    storage: PendingTargetStorage,
    preflightId: string,
): boolean {
    if (!isCanonicalUuid(preflightId)) return false;

    try {
        const raw = storage.getItem(PREFLIGHT_DISPLAY_TARGET_KEY);
        if (!raw) return false;

        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return false;
        if (Reflect.get(parsed, 'preflight_id') !== preflightId) return false;

        return removePreflightDisplayTargetRecord(storage);
    } catch {
        return false;
    }
}

export function clearPreflightDisplayTargetForTerminalState(
    storage: PendingTargetStorage,
    {
        preflightId,
        status,
    }: { preflightId: string; status: string | null | undefined },
): boolean {
    if (!status || !PREFLIGHT_DISPLAY_TERMINAL_STATES.has(status)) return false;
    return clearPreflightDisplayTarget(storage, preflightId);
}

export function readPendingAnalysisTargetForAutostart(
    storage: PendingTargetStorage,
    now = Date.now(),
): string | null {
    const record = readPendingTargetRecord(storage, now);
    if (!record) return null;
    if (record.owner_id || record.preflight_id) {
        clearPendingAnalysisTarget(storage);
        return null;
    }
    return record.target;
}

export function readPendingAnalysisTargetForPreflight(
    storage: PendingTargetStorage,
    {
        now = Date.now(),
        ownerId,
        preflightId,
    }: ReadBoundPendingTargetInput,
): string | null {
    if (!isCanonicalUuid(ownerId) || !isCanonicalUuid(preflightId)) {
        clearPendingAnalysisTarget(storage);
        return null;
    }

    const record = readPendingTargetRecord(storage, now);
    if (!record) return null;
    if (record.owner_id !== ownerId || record.preflight_id !== preflightId) {
        clearPendingAnalysisTarget(storage);
        return null;
    }
    return record.target;
}

export function clearPendingAnalysisTargetForTerminalState(
    storage: PendingTargetStorage,
    status: string | null | undefined,
): boolean {
    if (!status || !TERMINAL_TARGET_STATES.has(status)) return false;
    clearPendingAnalysisTarget(storage);
    return true;
}

export async function signOutAndClearPendingAnalysisTarget(
    storage: PendingTargetStorage | undefined,
    signOut: BrowserSignOut = browserSignOut,
): Promise<boolean> {
    const { error } = await signOut();
    if (error) return false;

    markAnalyticsIdentityPending();
    await initAmplitude(null);
    markAnalyticsIdentityReady();
    if (storage) clearPendingAnalysisTarget(storage);
    return true;
}
