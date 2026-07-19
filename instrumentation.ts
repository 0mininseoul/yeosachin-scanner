import 'server-only';

import type { Instrumentation } from 'next';

import {
    flushOperationalLogs,
    operationalLogger,
} from './lib/observability/server';

export const onRequestError: Instrumentation.onRequestError = async (
    error,
    errorRequest,
    errorContext,
) => {
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
