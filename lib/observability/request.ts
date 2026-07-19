import 'server-only';

import { after } from 'next/server';

import { flushOperationalLogs, operationalLogger } from './server';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACEPARENT_BASE_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACEPARENT_BASE_LENGTH = 55;
const MAX_TRACEPARENT_LENGTH = 512;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_./:\[\]-]{0,255}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_PARENT_ID = '0'.repeat(16);
const UNKNOWN_ROUTE = '/unknown';
const METHODS = new Set([
    'CONNECT',
    'DELETE',
    'GET',
    'HEAD',
    'OPTIONS',
    'PATCH',
    'POST',
    'PUT',
    'TRACE',
]);

export interface OperationalRequestContext {
    request_id: string;
    trace_id: string | null;
    route: string;
    method: string;
}

function incomingRequestId(request: Request): string | undefined {
    const candidate = request.headers.get('x-request-id')?.trim();
    return candidate && UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : undefined;
}

function incomingTraceId(request: Request): string | null {
    const rawTraceparent = request.headers.get('traceparent');
    if (!rawTraceparent || rawTraceparent.length > MAX_TRACEPARENT_LENGTH) {
        return null;
    }
    const candidate = rawTraceparent.trim();
    if (candidate.length < TRACEPARENT_BASE_LENGTH) return null;

    const match = candidate.slice(0, TRACEPARENT_BASE_LENGTH)
        .match(TRACEPARENT_BASE_PATTERN);
    if (!match || match[1] === 'ff' || match[3] === ZERO_PARENT_ID) return null;

    const version = match[1];
    if (
        candidate.length > TRACEPARENT_BASE_LENGTH
        && (
            version === '00'
            || candidate[TRACEPARENT_BASE_LENGTH] !== '-'
        )
    ) {
        return null;
    }

    const traceId = match[2];
    return traceId && traceId !== ZERO_TRACE_ID ? traceId : null;
}

function safeRoute(route: unknown): string {
    if (typeof route !== 'string') return UNKNOWN_ROUTE;
    const candidate = route.trim();
    return ROUTE_PATTERN.test(candidate) ? candidate : UNKNOWN_ROUTE;
}

function safeMethod(method: unknown): string {
    if (typeof method !== 'string') return 'GET';
    const candidate = method.trim().toUpperCase();
    return METHODS.has(candidate) ? candidate : 'GET';
}

export function requestContext(
    request: Request,
    route: string,
): OperationalRequestContext {
    return {
        request_id: incomingRequestId(request) ?? crypto.randomUUID(),
        trace_id: incomingTraceId(request),
        route: safeRoute(route),
        method: safeMethod(request.method),
    };
}

function elapsedMilliseconds(startedAt: number): number {
    const duration = performance.now() - startedAt;
    return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

async function bestEffortFlush(): Promise<void> {
    try {
        await flushOperationalLogs();
    } catch {
        // Observability must never change the product outcome.
    }
}

function scheduleOperationalFlush(): void {
    try {
        after(() => bestEffortFlush());
    } catch {
        void bestEffortFlush();
    }
}

export async function observeRoute<T extends Response>(
    request: Request,
    route: string,
    operation: (context: OperationalRequestContext) => Promise<T>,
): Promise<T> {
    const context = requestContext(request, route);
    const startedAt = performance.now();
    try {
        const response = await operation(context);
        try {
            operationalLogger.emit({
                event: 'http.route_completed',
                severity: 'info',
                fields: {
                    ...context,
                    status: response.status,
                    duration_ms: elapsedMilliseconds(startedAt),
                },
            });
        } catch {
            // Observability must never change the product outcome.
        }
        return response;
    } catch (error) {
        try {
            operationalLogger.emit({
                event: 'http.route_failed',
                severity: 'error',
                fields: {
                    ...context,
                    status: 500,
                    duration_ms: elapsedMilliseconds(startedAt),
                },
                error,
            });
        } catch {
            // Observability must never change the product outcome.
        }
        throw error;
    } finally {
        scheduleOperationalFlush();
    }
}
