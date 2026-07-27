import * as Sentry from '@sentry/nextjs';
import { sentryOptions } from './lib/observability/sentry-config';

Sentry.init(sentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    traceRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    enabled: process.env.NEXT_PUBLIC_SENTRY_ENABLED,
}));
