import * as Sentry from '@sentry/nextjs';
import { sentryOptions } from './lib/observability/sentry-config';

Sentry.init(sentryOptions({
    dsn: process.env.SENTRY_DSN,
    traceRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
    enabled: process.env.SENTRY_ENABLED,
}));
