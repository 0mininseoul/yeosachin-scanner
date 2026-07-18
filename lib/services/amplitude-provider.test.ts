import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsMocks = vi.hoisted(() => ({
    initAmplitude: vi.fn(),
    isCanonicalAnalyticsUserId: vi.fn(),
    markAnalyticsIdentityPending: vi.fn(),
    markAnalyticsIdentityReady: vi.fn(),
}));

const authMarkerMocks = vi.hoisted(() => ({
    completePendingAuthEvent: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/services/analytics', () => analyticsMocks);
vi.mock('@/lib/services/analytics-auth', () => authMarkerMocks);

const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('AmplitudeProvider auth integration', () => {
    beforeEach(() => {
        analyticsMocks.initAmplitude.mockReset().mockResolvedValue(true);
        analyticsMocks.isCanonicalAnalyticsUserId
            .mockReset()
            .mockImplementation((userId: string) => (
                userId === VALID_USER_ID || userId === SECOND_USER_ID
            ));
        analyticsMocks.markAnalyticsIdentityPending.mockReset();
        analyticsMocks.markAnalyticsIdentityReady.mockReset();
        authMarkerMocks.completePendingAuthEvent.mockReset();
    });

    it('waits for resolved auth, then reconciles the first anonymous identity', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        let state = createAuthAnalyticsState();

        state = await syncAnalyticsAuth(state, {
            loading: true,
            provider: null,
            userId: null,
        });
        expect(analyticsMocks.initAmplitude).not.toHaveBeenCalled();
        expect(analyticsMocks.markAnalyticsIdentityPending).not.toHaveBeenCalled();

        state = await syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
        });
        await syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
        });

        expect(analyticsMocks.markAnalyticsIdentityPending).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude).toHaveBeenCalledWith(null);
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).not.toHaveBeenCalled();
    });

    it('initializes each canonical auth transition before completion and readiness', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        const storage = { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() };
        let state = createAuthAnalyticsState();

        state = await syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
            storage,
        });
        vi.clearAllMocks();
        analyticsMocks.initAmplitude.mockResolvedValue(true);

        state = await syncAnalyticsAuth(state, {
            loading: false,
            provider: 'kakao',
            userId: VALID_USER_ID,
            storage,
        });
        state = await syncAnalyticsAuth(state, {
            loading: false,
            provider: 'kakao',
            userId: VALID_USER_ID,
            storage,
        });

        expect(analyticsMocks.markAnalyticsIdentityPending).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude).toHaveBeenCalledWith(VALID_USER_ID);
        expect(authMarkerMocks.completePendingAuthEvent).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).toHaveBeenCalledWith({
            provider: 'kakao',
            storage,
            userId: VALID_USER_ID,
        });
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude.mock.invocationCallOrder[0])
            .toBeLessThan(authMarkerMocks.completePendingAuthEvent.mock.invocationCallOrder[0]);
        expect(authMarkerMocks.completePendingAuthEvent.mock.invocationCallOrder[0])
            .toBeLessThan(analyticsMocks.markAnalyticsIdentityReady.mock.invocationCallOrder[0]);

        vi.clearAllMocks();
        analyticsMocks.initAmplitude.mockResolvedValue(true);
        state = await syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
            storage,
        });
        await syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
            storage,
        });

        expect(analyticsMocks.initAmplitude).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude).toHaveBeenCalledWith(null);
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).not.toHaveBeenCalled();
    });

    it('does not complete or open delivery for a stale in-flight auth transition', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        let resolveInitialization!: (ready: boolean) => void;
        analyticsMocks.initAmplitude.mockReturnValue(new Promise<boolean>((resolve) => {
            resolveInitialization = resolve;
        }));
        const storage = { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() };
        const state = createAuthAnalyticsState();

        const stale = syncAnalyticsAuth(state, {
            loading: false,
            provider: 'kakao',
            userId: VALID_USER_ID,
            storage,
        }, () => false);
        const current = syncAnalyticsAuth(state, {
            loading: false,
            provider: 'google',
            userId: SECOND_USER_ID,
            storage,
        }, () => true);
        resolveInitialization(true);

        await expect(stale).resolves.toEqual(state);
        await expect(current).resolves.toEqual({
            provider: 'google',
            resolved: true,
            userId: SECOND_USER_ID,
        });
        expect(authMarkerMocks.completePendingAuthEvent).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).toHaveBeenCalledWith({
            provider: 'google',
            storage,
            userId: SECOND_USER_ID,
        });
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
    });

    it('opens readiness only after the current identity succeeds on its bounded retry', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        analyticsMocks.initAmplitude
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const state = createAuthAnalyticsState();

        await expect(syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
        })).resolves.toEqual({
            provider: null,
            resolved: true,
            userId: null,
        });

        expect(analyticsMocks.initAmplitude).toHaveBeenCalledTimes(2);
        expect(analyticsMocks.initAmplitude).toHaveBeenNthCalledWith(1, null);
        expect(analyticsMocks.initAmplitude).toHaveBeenNthCalledWith(2, null);
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude.mock.invocationCallOrder[1])
            .toBeLessThan(analyticsMocks.markAnalyticsIdentityReady.mock.invocationCallOrder[0]);
    });

    it('keeps identity unresolved and readiness closed when both attempts fail', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        analyticsMocks.initAmplitude.mockResolvedValue(false);
        const state = createAuthAnalyticsState();

        await expect(syncAnalyticsAuth(state, {
            loading: false,
            provider: 'kakao',
            userId: VALID_USER_ID,
        })).resolves.toBe(state);

        expect(analyticsMocks.initAmplitude).toHaveBeenCalledTimes(2);
        expect(analyticsMocks.initAmplitude).toHaveBeenNthCalledWith(1, VALID_USER_ID);
        expect(analyticsMocks.initAmplitude).toHaveBeenNthCalledWith(2, VALID_USER_ID);
        expect(analyticsMocks.markAnalyticsIdentityReady).not.toHaveBeenCalled();
        expect(authMarkerMocks.completePendingAuthEvent).not.toHaveBeenCalled();
    });

    it('keeps the SDK behind one client provider mounted once at the root', () => {
        const providerSource = readFileSync(
            new URL('../../components/amplitude-provider.tsx', import.meta.url),
            'utf8',
        );
        const layoutSource = readFileSync(
            new URL('../../app/layout.tsx', import.meta.url),
            'utf8',
        );

        expect(providerSource.startsWith("'use client';")).toBe(true);
        expect(providerSource).not.toContain('@amplitude/unified');
        expect(layoutSource).not.toContain('@amplitude/unified');
        expect(layoutSource).toContain(
            'import { AmplitudeProvider } from "@/components/amplitude-provider";',
        );
        expect(layoutSource.match(/<AmplitudeProvider>/g)).toHaveLength(1);
        expect(layoutSource).toMatch(
            /<AmplitudeProvider>\s*\{children\}\s*<\/AmplitudeProvider>/,
        );
    });
});
