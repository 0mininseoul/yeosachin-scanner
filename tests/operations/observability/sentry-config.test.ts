import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentryOptions } from '../../../lib/observability/sentry-config';

afterEach(() => vi.unstubAllEnvs());

describe('Sentry configuration', () => {
    it.each(['DEPLOYMENT_ROLE', 'NEXT_PUBLIC_DEPLOYMENT_ROLE'])('disables Sentry for a Dev marker even with production credentials: %s', marker => {
        vi.stubEnv(marker, 'dev');
        expect(sentryOptions({ dsn: 'https://public@example.ingest/1', traceRate: '1', enabled: 'true' }).enabled).toBe(false);
    });

    it('registers error, transaction, span, and breadcrumb privacy hooks with conservative production sampling', () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        const options = sentryOptions({ dsn: 'https://public@example.ingest/1', traceRate: undefined, enabled: 'true' });

        expect(options.enabled).toBe(true);
        expect(options.tracesSampleRate).toBe(0.05);
        expect(options.sendDefaultPii).toBe(false);
        expect(options.beforeSendTransaction).toBeTypeOf('function');
        expect(options.beforeSendSpan).toBeTypeOf('function');
        expect(options.beforeBreadcrumb).toBeTypeOf('function');
    });

    it('requires explicit enablement even for a production DSN', () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        expect(sentryOptions({ dsn: 'https://public@example.ingest/1', traceRate: undefined, enabled: 'false' }).enabled).toBe(false);
        expect(sentryOptions({ dsn: 'https://public@example.ingest/1', traceRate: undefined, enabled: 'true' }).enabled).toBe(true);
    });
});
