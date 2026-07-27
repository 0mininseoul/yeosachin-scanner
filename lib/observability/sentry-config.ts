import {
    scrubSentryBreadcrumb,
    scrubSentryEvent,
    scrubSentrySpan,
    scrubSentryTransaction,
} from './sentry-scrubber';

function sampleRate(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function sentryEnvironment(): 'development' | 'preview' | 'production' {
    if (process.env.VERCEL_ENV === 'production') return 'production';
    if (process.env.VERCEL_ENV === 'preview') return 'preview';
    return 'development';
}

export function sentryOptions(options: {
    dsn: string | undefined;
    traceRate: string | undefined;
    enabled: string | undefined;
}) {
    const environment = sentryEnvironment();
    const explicitlyEnabled = options.enabled === 'true';
    return {
        dsn: options.dsn,
        enabled: Boolean(options.dsn) && (environment !== 'development' || explicitlyEnabled),
        environment,
        sendDefaultPii: false,
        tracesSampleRate: sampleRate(
            options.traceRate,
            environment === 'production' ? 0.05 : environment === 'preview' ? 0.1 : 0,
        ),
        beforeSend: scrubSentryEvent,
        beforeSendTransaction: scrubSentryTransaction,
        beforeSendSpan: scrubSentrySpan,
        beforeBreadcrumb: scrubSentryBreadcrumb,
    };
}
