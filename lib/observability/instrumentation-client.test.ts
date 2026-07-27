import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn(), captureRouterTransitionStart: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
    init: mocks.init,
    captureRouterTransitionStart: mocks.captureRouterTransitionStart,
}));

describe('Next App Router client instrumentation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.ingest/1');
        vi.stubEnv('NEXT_PUBLIC_SENTRY_ENABLED', 'true');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('initializes Sentry from instrumentation-client and exports the navigation hook', async () => {
        const client = await import('../../instrumentation-client');

        expect(mocks.init).toHaveBeenCalledOnce();
        expect(client.onRouterTransitionStart).toBe(mocks.captureRouterTransitionStart);
    });
});
