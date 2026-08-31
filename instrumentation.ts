import 'server-only';

import type { Instrumentation } from 'next';
import * as Sentry from '@sentry/nextjs';

import {
    flushOperationalLogs,
    operationalLogger,
} from './lib/observability/server';
import { isBenignImageProxyRequestError } from './lib/observability/image-proxy-request-error';

export async function register(): Promise<void> {
    try {
        if (process.env.NEXT_RUNTIME === 'nodejs') {
            await import('./sentry.server.config');
        } else {
            await import('./sentry.edge.config');
        }
    } catch {
        // Monitoring initialization must never prevent application startup.
    }
}

export const onRequestError: Instrumentation.onRequestError = async (
    error,
    errorRequest,
    errorContext,
) => {
    let benignImageProxyError = false;
    try {
        benignImageProxyError = isBenignImageProxyRequestError({
            error,
            method: errorRequest.method,
            routePath: errorContext.routePath,
        });
    } catch {
        // A malformed error/request object must remain observable.
    }
    if (benignImageProxyError) {
        return;
    }

    try {
        Sentry.captureRequestError(error, errorRequest, errorContext);
    } catch {
        // Sentry is strictly fail-open.
    }
    try {
        operationalLogger.emit({
            event: 'next.request_error',
            severity: 'error',
            fields: {
                route: errorContext.routePath,
                method: errorRequest.method,
            },
            error,
        });
    } catch {
        // Observability must never change the product outcome.
    }

    try {
        await flushOperationalLogs();
    } catch {
        // This is the global error lifecycle boundary, but remains fail-open.
    }
};
