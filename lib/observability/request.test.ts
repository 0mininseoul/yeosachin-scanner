import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observabilityMocks = vi.hoisted(() => ({
    afterTask: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: observabilityMocks.afterTask }));
vi.mock('./server', () => ({
    operationalLogger: { emit: observabilityMocks.emit },
    flushOperationalLogs: observabilityMocks.flush,
}));

import { observeRoute, requestContext } from './request';
import { sanitizeOperationalEvent, type OperationalEvent } from './schema';

beforeEach(() => {
    vi.resetAllMocks();
    observabilityMocks.afterTask.mockImplementation(() => undefined);
    observabilityMocks.flush.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('requestContext', () => {
    it('accepts and lowercases a valid incoming request ID', () => {
        const context = requestContext(new Request('https://example.com/private?token=secret', {
            method: 'POST',
            headers: {
                'x-request-id': '01234567-89AB-4DEF-8123-456789ABCDEF',
            },
        }), '/api/example');

        expect(context).toEqual({
            request_id: '01234567-89ab-4def-8123-456789abcdef',
            trace_id: null,
            route: '/api/example',
            method: 'POST',
        });
    });

    it('extracts a valid nonzero W3C trace ID', () => {
        const context = requestContext(new Request('https://example.com', {
            headers: {
                traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            },
        }), '/api/example');

        expect(context.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('accepts an opaque extension for a valid higher traceparent version', () => {
        const context = requestContext(new Request('https://example.com', {
            headers: {
                traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future',
            },
        }), '/api/example');

        expect(context.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(JSON.stringify(context)).not.toContain('future');
    });

    it('accepts a valid higher-version base without an extension', () => {
        const context = requestContext(new Request('https://example.com', {
            headers: {
                traceparent: 'fe-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            },
        }), '/api/example');

        expect(context.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('accepts a future-version extension delimiter without interpreting fields', () => {
        const context = requestContext(new Request('https://example.com', {
            headers: {
                traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-',
            },
        }), '/api/example');

        expect(context.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(context).not.toHaveProperty('traceparent');
    });

    it('accepts a higher-version extension at the conservative length limit', () => {
        const traceparent = '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-'
            .padEnd(512, 'x');
        expect(traceparent).toHaveLength(512);

        const context = requestContext(new Request('https://example.com', {
            headers: { traceparent },
        }), '/api/example');

        expect(context.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('rejects an oversized higher-version traceparent extension', () => {
        const traceparent = '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-'
            .padEnd(513, 'x');
        expect(traceparent).toHaveLength(513);

        const context = requestContext(new Request('https://example.com', {
            headers: { traceparent },
        }), '/api/example');

        expect(context.trace_id).toBeNull();
    });

    it('bounds the raw traceparent before trimming outer whitespace', () => {
        const base = '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        const request = {
            method: 'GET',
            headers: {
                get(name: string) {
                    if (name === 'x-request-id') {
                        return '01234567-89ab-4def-8123-456789abcdef';
                    }
                    return name === 'traceparent' ? base.padEnd(513, ' ') : null;
                },
            },
        } as unknown as Request;

        expect(requestContext(request, '/api/example').trace_id).toBeNull();
    });

    it('generates a UUID when the incoming request ID is invalid', () => {
        const generated = '11234567-89ab-4def-8123-456789abcdef';
        const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(generated);

        const context = requestContext(new Request('https://example.com', {
            headers: { 'x-request-id': 'buyer@example.com' },
        }), '/api/example');

        expect(context.request_id).toBe(generated);
        expect(randomUuid).toHaveBeenCalledOnce();
        randomUuid.mockRestore();
    });

    it.each([
        '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
        '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
        'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01',
        '00-4bf92f3577b34da6a3ce929d0e0e4736-too-short-01',
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
        '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01future',
    ])('rejects an invalid traceparent value: %s', traceparent => {
        const context = requestContext(new Request('https://example.com', {
            headers: { traceparent },
        }), '/api/example');

        expect(context.trace_id).toBeNull();
    });

    it.each([
        '/api/example?buyer=private',
        '/api/example#private',
        'https://example.com/api/example',
        'api/example',
        `/${'a'.repeat(256)}`,
        '',
    ])('uses one fixed route label for an unsafe static label: %s', route => {
        const context = requestContext(new Request(
            'https://example.com/private/raw-path?buyer=private',
        ), route);

        expect(context.route).toBe('/unknown');
        expect(context.route).not.toContain('private');
    });

    it('uses a registered uppercase method even for malformed runtime input', () => {
        const request = {
            method: 'buyer@example.com',
            headers: new Headers(),
        } as Request;

        expect(requestContext(request, '/api/example').method).toBe('GET');
    });

    it('reads only request ID, traceparent, and method from the request', () => {
        const requestedHeaders: string[] = [];
        const approvedHeaders = new Map([
            ['x-request-id', '01234567-89ab-4def-8123-456789abcdef'],
            ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
        ]);
        const request = {
            method: 'post',
            headers: {
                get(name: string) {
                    requestedHeaders.push(name);
                    if (!approvedHeaders.has(name)) {
                        throw new Error(`forbidden header access: ${name}`);
                    }
                    return approvedHeaders.get(name) ?? null;
                },
            },
            get url() {
                throw new Error('request URL must not be read');
            },
            get body() {
                throw new Error('request body must not be read');
            },
            get cookies() {
                throw new Error('request cookies must not be read');
            },
        } as unknown as Request;

        expect(requestContext(request, '/api/example')).toEqual({
            request_id: '01234567-89ab-4def-8123-456789abcdef',
            trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
            route: '/api/example',
            method: 'POST',
        });
        expect(requestedHeaders).toEqual(['x-request-id', 'traceparent']);
    });
});

describe('observeRoute', () => {
    it('emits completion fields and defers flush without replacing the response', async () => {
        const request = new Request('https://example.com/private?buyer=private', {
            method: 'POST',
            headers: { 'x-request-id': '01234567-89ab-4def-8123-456789abcdef' },
        });
        const response = new Response(null, { status: 201 });
        const now = vi.spyOn(performance, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValue(142.25);

        const result = await observeRoute(request, '/api/example', async context => {
            expect(context).toEqual({
                request_id: '01234567-89ab-4def-8123-456789abcdef',
                trace_id: null,
                route: '/api/example',
                method: 'POST',
            });
            return response;
        });

        expect(result).toBe(response);
        expect(observabilityMocks.emit).toHaveBeenCalledWith({
            event: 'http.route_completed',
            severity: 'info',
            fields: {
                request_id: '01234567-89ab-4def-8123-456789abcdef',
                trace_id: null,
                route: '/api/example',
                method: 'POST',
                status: 201,
                duration_ms: 42.25,
            },
        });
        expect(observabilityMocks.flush).not.toHaveBeenCalled();
        expect(observabilityMocks.afterTask).toHaveBeenCalledOnce();

        const scheduled = observabilityMocks.afterTask.mock.calls[0]?.[0] as () => Promise<void>;
        await expect(scheduled()).resolves.toBeUndefined();
        expect(observabilityMocks.flush).toHaveBeenCalledOnce();
        now.mockRestore();
    });

    it('emits a failure, schedules flush, and rethrows the identical error', async () => {
        const request = new Request(
            'https://example.com/private/raw-path?buyer=private',
            {
                method: 'PATCH',
                headers: {
                    authorization: 'Bearer private-token',
                    'user-agent': 'private-user-agent',
                    'x-request-id': '01234567-89ab-4def-8123-456789abcdef',
                },
            },
        );
        const error = Object.assign(new Error('buyer@example.com private failure'), {
            code: 'INTERNAL_ERROR',
            stack: 'private stack',
        });
        vi.spyOn(performance, 'now')
            .mockReturnValueOnce(200)
            .mockReturnValue(225);

        await expect(observeRoute(request, '/api/example', async () => {
            throw error;
        })).rejects.toBe(error);

        expect(observabilityMocks.emit).toHaveBeenCalledWith({
            event: 'http.route_failed',
            severity: 'error',
            fields: {
                request_id: '01234567-89ab-4def-8123-456789abcdef',
                trace_id: null,
                route: '/api/example',
                method: 'PATCH',
                status: 500,
                duration_ms: 25,
            },
            error,
        });
        const emitted = observabilityMocks.emit.mock.calls[0]?.[0] as OperationalEvent;
        const emittedFields = emitted.fields;
        expect(JSON.stringify(emittedFields)).not.toContain('private');
        expect(JSON.stringify(emittedFields)).not.toContain('buyer@example.com');
        const sanitized = sanitizeOperationalEvent(emitted);
        expect(sanitized.fields).toMatchObject({
            error_name: 'Error',
            error_code: 'INTERNAL_ERROR',
        });
        expect(JSON.stringify(sanitized)).not.toContain('private');
        expect(JSON.stringify(sanitized)).not.toContain('buyer@example.com');
        expect(observabilityMocks.afterTask).toHaveBeenCalledOnce();

        const scheduled = observabilityMocks.afterTask.mock.calls[0]?.[0] as () => Promise<void>;
        await scheduled();
        expect(observabilityMocks.flush).toHaveBeenCalledOnce();
    });

    it('falls back without changing the response when scheduling and flush fail', async () => {
        const response = new Response('ok');
        observabilityMocks.emit.mockImplementation(() => {
            throw new Error('logger unavailable');
        });
        observabilityMocks.afterTask.mockImplementation(() => {
            throw new Error('after unavailable');
        });
        observabilityMocks.flush.mockRejectedValue(new Error('flush unavailable'));

        await expect(observeRoute(
            new Request('https://example.com'),
            '/api/example',
            async () => response,
        )).resolves.toBe(response);
        expect(observabilityMocks.flush).toHaveBeenCalledOnce();
    });

    it('does not await a scheduler or flush that never settles', async () => {
        const never = new Promise<void>(() => undefined);
        const response = new Response('ok');
        observabilityMocks.flush.mockReturnValue(never);
        observabilityMocks.afterTask.mockImplementation(task => {
            void task();
            return never;
        });

        await expect(observeRoute(
            new Request('https://example.com'),
            '/api/example',
            async () => response,
        )).resolves.toBe(response);
        expect(observabilityMocks.flush).toHaveBeenCalledOnce();
    });
});
