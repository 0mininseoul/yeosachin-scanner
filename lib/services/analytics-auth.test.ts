import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsMocks = vi.hoisted(() => ({
    EVENTS: {
        AUTH_COMPLETED: 'auth_completed',
        AUTH_STARTED: 'auth_started',
    },
    isCanonicalAnalyticsUserId: vi.fn(),
    trackEvent: vi.fn(),
}));

vi.mock('@/lib/services/analytics', () => analyticsMocks);
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const STARTED_AT = 1_750_000_000_000;

function createStorage() {
    const values = new Map<string, string>();
    return {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => {
            values.delete(key);
        }),
        setItem: vi.fn((key: string, value: string) => {
            values.set(key, value);
        }),
    };
}

describe('OAuth analytics marker', () => {
    beforeEach(() => {
        vi.resetModules();
        analyticsMocks.isCanonicalAnalyticsUserId
            .mockReset()
            .mockImplementation((userId: string) => userId === VALID_USER_ID);
        analyticsMocks.trackEvent.mockReset();
    });

    it('stores a timestamped provider marker and emits only the provider on start', async () => {
        const { beginPendingAuthEvent } = await import('./analytics-auth');
        const storage = createStorage();

        expect(beginPendingAuthEvent({
            now: STARTED_AT,
            provider: 'kakao',
            storage,
        })).toBe(true);

        const stored = storage.setItem.mock.calls[0];
        expect(stored[0]).toBe('amplitude_auth_started');
        expect(JSON.parse(stored[1])).toEqual({
            provider: 'kakao',
            started_at: STARTED_AT,
        });
        expect(analyticsMocks.trackEvent).toHaveBeenCalledWith('auth_started', {
            provider: 'kakao',
        });
    });

    it('identifies a fresh matching provider marker once, then removes it', async () => {
        const {
            beginPendingAuthEvent,
            completePendingAuthEvent,
        } = await import('./analytics-auth');
        const storage = createStorage();
        beginPendingAuthEvent({ now: STARTED_AT, provider: 'kakao', storage });
        analyticsMocks.trackEvent.mockClear();

        expect(completePendingAuthEvent({
            now: STARTED_AT + 60_000,
            provider: 'kakao',
            storage,
            userId: VALID_USER_ID,
        })).toBe(true);
        expect(completePendingAuthEvent({
            now: STARTED_AT + 60_001,
            provider: 'kakao',
            storage,
            userId: VALID_USER_ID,
        })).toBe(false);

        expect(storage.removeItem).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.trackEvent).toHaveBeenCalledWith('auth_completed', {
            provider: 'kakao',
        });
    });

    it.each([
        { age: 15 * 60_000 + 1, provider: 'kakao', userId: VALID_USER_ID },
        { age: -1, provider: 'kakao', userId: VALID_USER_ID },
        { age: 1_000, provider: 'google', userId: VALID_USER_ID },
        { age: 1_000, provider: 'kakao', userId: 'person@example.com' },
    ])('rejects stale, future, mismatched, or invalid-user completion %#', async (input) => {
        const {
            beginPendingAuthEvent,
            completePendingAuthEvent,
        } = await import('./analytics-auth');
        const storage = createStorage();
        beginPendingAuthEvent({ now: STARTED_AT, provider: 'kakao', storage });
        analyticsMocks.trackEvent.mockClear();

        expect(completePendingAuthEvent({
            now: STARTED_AT + input.age,
            provider: input.provider as 'google' | 'kakao',
            storage,
            userId: input.userId,
        })).toBe(false);
        expect(analyticsMocks.trackEvent).not.toHaveBeenCalled();
    });

    it('fails open for unavailable or malformed storage', async () => {
        const {
            beginPendingAuthEvent,
            completePendingAuthEvent,
        } = await import('./analytics-auth');
        const throwingStorage = {
            getItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
            removeItem: vi.fn(),
            setItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
        };

        expect(() => beginPendingAuthEvent({
            now: STARTED_AT,
            provider: 'kakao',
            storage: throwingStorage,
        })).not.toThrow();
        expect(completePendingAuthEvent({
            now: STARTED_AT,
            provider: 'kakao',
            storage: throwingStorage,
            userId: VALID_USER_ID,
        })).toBe(false);
    });
});

describe('auth button analytics integration', () => {
    beforeEach(() => {
        vi.resetModules();
        analyticsMocks.isCanonicalAnalyticsUserId.mockReset();
        analyticsMocks.trackEvent.mockReset();
    });

    it('starts analytics immediately before OAuth without tracking URL or contact data', async () => {
        const { performOAuthSignIn } = await import('../../components/auth-buttons');
        const storage = createStorage();
        const signInWithOAuth = vi.fn().mockResolvedValue({ error: null });

        await expect(performOAuthSignIn({
            now: STARTED_AT,
            options: {
                redirectTo: 'https://app.example/auth/callback?next=%2Fanalyze',
                scopes: 'account_email phone_number',
            },
            provider: 'kakao',
            signInWithOAuth,
            storage,
        })).resolves.toEqual({ error: null });

        expect(storage.setItem.mock.invocationCallOrder[0])
            .toBeLessThan(signInWithOAuth.mock.invocationCallOrder[0]);
        expect(analyticsMocks.trackEvent).toHaveBeenCalledWith('auth_started', {
            provider: 'kakao',
        });
        const analyticsPayload = JSON.stringify(analyticsMocks.trackEvent.mock.calls);
        expect(analyticsPayload).not.toContain('app.example');
        expect(analyticsPayload).not.toContain('account_email');
        expect(analyticsPayload).not.toContain('phone_number');
    });

    it.each(['returned', 'thrown'] as const)('clears the marker on %s OAuth failure', async (kind) => {
        const { performOAuthSignIn } = await import('../../components/auth-buttons');
        const storage = createStorage();
        const failure = new Error('oauth failed');
        const signInWithOAuth = kind === 'returned'
            ? vi.fn().mockResolvedValue({ error: failure })
            : vi.fn().mockRejectedValue(failure);

        const result = performOAuthSignIn({
            now: STARTED_AT,
            options: { redirectTo: 'https://app.example/auth/callback' },
            provider: 'kakao',
            signInWithOAuth,
            storage,
        });

        if (kind === 'returned') {
            await expect(result).resolves.toEqual({ error: failure });
        } else {
            await expect(result).rejects.toThrow('oauth failed');
        }
        expect(storage.getItem('amplitude_auth_started')).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('amplitude_auth_started');
    });
});
