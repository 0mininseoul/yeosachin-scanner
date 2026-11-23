// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), init: vi.fn(), ready: vi.fn(), track: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/constants/dev-ui', () => ({ isDevUiTelemetryDisabled: () => false }));
vi.mock('@vercel/analytics', () => ({ inject: vi.fn() }));
vi.mock('@/lib/services/analytics', () => ({
    CHERRY_EVENTS: { VIEWED: 'cherry_viewed', CTA_CLICKED: 'cta', RESERVATION_SUBMITTED: 'submitted', RESERVATION_COMPLETED: 'completed' },
    initAmplitude: mocks.init,
    markAnalyticsIdentityReady: mocks.ready,
    trackEvent: mocks.track,
}));

describe('cherry analytics identity', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.init.mockResolvedValue(true);
        delete document.documentElement.dataset.variant;
    });

    it('tags cherry events with the landing variant', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
        document.documentElement.dataset.variant = 'crush';
        await import('@/lib/services/cherry-analytics');
        expect(mocks.track).toHaveBeenCalledWith('cherry_viewed', { variant: 'crush' });
        window.dispatchEvent(new Event('cherry-reservation-completed'));
        expect(mocks.track).toHaveBeenLastCalledWith('completed', { variant: 'crush' });
    });

    it('sends cherry events without a variant when the visitor has none', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
        await import('@/lib/services/cherry-analytics');
        expect(mocks.track).toHaveBeenCalledWith('cherry_viewed', undefined);
    });

    it('does not reset identity after repeated transient authentication errors', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthRetryableFetchError' } });
        await import('@/lib/services/cherry-analytics');
        await vi.waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(2));
        expect(mocks.init).not.toHaveBeenCalled();
    });

    it('initializes anonymously only when the session is missing', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
        await import('@/lib/services/cherry-analytics');
        await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledWith(null));
        expect(mocks.ready).toHaveBeenCalled();
    });
});
