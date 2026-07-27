import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentryOptions } from './sentry-config';

afterEach(() => vi.unstubAllEnvs());

describe('Sentry configuration', () => {
    it('registers error, transaction, span, and breadcrumb privacy hooks with conservative production sampling', () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        const options = sentryOptions({ dsn: 'https://public@example.ingest/1', traceRate: undefined, enabled: undefined });

        expect(options.enabled).toBe(true);
        expect(options.tracesSampleRate).toBe(0.05);
        expect(options.sendDefaultPii).toBe(false);
        expect(options.beforeSendTransaction).toBeTypeOf('function');
        expect(options.beforeSendSpan).toBeTypeOf('function');
        expect(options.beforeBreadcrumb).toBeTypeOf('function');
    });
});
