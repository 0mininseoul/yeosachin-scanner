import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const observabilityMocks = vi.hoisted(() => ({
    captureRequestError: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({
    captureRequestError: observabilityMocks.captureRequestError,
}));
vi.mock('./server', () => ({
    operationalLogger: { emit: observabilityMocks.emit },
    flushOperationalLogs: observabilityMocks.flush,
}));

import { onRequestError } from '../../instrumentation';
import { sanitizeOperationalEvent, type OperationalEvent } from './schema';

beforeEach(() => {
    vi.resetAllMocks();
});

describe('onRequestError', () => {
    it('suppresses only nested EPIPE for the GET image-proxy request boundary', async () => {
        const imageProxyEpipe = Object.assign(new Error('response write failed'), {
            cause: { code: 'EPIPE' },
        });
        const cases = [
            {
                name: 'image proxy GET EPIPE',
                method: 'GET',
                routePath: '/api/image-proxy',
                error: imageProxyEpipe,
                suppressed: true,
            },
            {
                name: 'image proxy POST EPIPE',
                method: 'POST',
                routePath: '/api/image-proxy',
                error: imageProxyEpipe,
                suppressed: false,
            },
            {
                name: 'image proxy lowercase method EPIPE',
                method: 'get',
                routePath: '/api/image-proxy',
                error: imageProxyEpipe,
                suppressed: false,
            },
            {
                name: 'image proxy GET non-EPIPE',
                method: 'GET',
                routePath: '/api/image-proxy',
                error: new Error('response write failed'),
                suppressed: false,
            },
            {
                name: 'other route GET EPIPE',
                method: 'GET',
                routePath: '/api/other',
                error: imageProxyEpipe,
                suppressed: false,
            },
        ];

        for (const testCase of cases) {
            vi.clearAllMocks();
            observabilityMocks.flush.mockResolvedValue(undefined);
            await onRequestError(testCase.error, {
                method: testCase.method,
                get path(): string {
                    throw new Error(`${testCase.name} must not inspect raw request path`);
                },
                get headers(): NodeJS.Dict<string | string[]> {
                    throw new Error(`${testCase.name} must not inspect request headers`);
                },
            }, {
                routerKind: 'App Router',
                routePath: testCase.routePath,
                routeType: 'route',
                revalidateReason: undefined,
            });

            if (testCase.suppressed) {
                expect(observabilityMocks.captureRequestError.mock.calls.length).toBe(0);
                expect(observabilityMocks.emit.mock.calls.length).toBe(0);
                expect(observabilityMocks.flush.mock.calls.length).toBe(0);
            } else {
                expect(observabilityMocks.captureRequestError.mock.calls.length).toBe(1);
                expect(observabilityMocks.emit.mock.calls.length).toBe(1);
                expect(observabilityMocks.flush.mock.calls.length).toBe(1);
            }
        }
    });

    it('uses only routePath and method, then awaits the bounded flush', async () => {
        let resolveFlush: (() => void) | undefined;
        observabilityMocks.flush.mockReturnValue(new Promise<void>(resolve => {
            resolveFlush = resolve;
        }));
        const error = Object.assign(new Error('buyer@example.com private failure'), {
            code: 'INTERNAL_ERROR',
            stack: 'private stack',
        });
        const errorRequest = {
            method: 'post',
            get path(): string {
                throw new Error('raw request path must not be read');
            },
            get headers(): NodeJS.Dict<string | string[]> {
                throw new Error('request headers must not be read');
            },
        };

        let completed = false;
        const capture = onRequestError(error, errorRequest, {
            routerKind: 'App Router',
            routePath: '/api/example',
            routeType: 'route',
            revalidateReason: undefined,
        });
        void Promise.resolve(capture).then(() => {
            completed = true;
        });
        await Promise.resolve();

        expect(completed).toBe(false);
        expect(observabilityMocks.emit).toHaveBeenCalledOnce();
        const input = observabilityMocks.emit.mock.calls[0]?.[0] as OperationalEvent;
        const sanitized = sanitizeOperationalEvent(input);
        expect(sanitized.message).toBe('next.request_error');
        expect(sanitized.fields).toMatchObject({
            event: 'next.request_error',
            severity: 'error',
            route: '/api/example',
            method: 'POST',
            error_name: 'Error',
            error_code: 'INTERNAL_ERROR',
        });
        expect(JSON.stringify(sanitized)).not.toContain('buyer@example.com');
        expect(JSON.stringify(sanitized)).not.toContain('private');

        resolveFlush?.();
        await capture;
        expect(completed).toBe(true);
    });

    it('drops an unsafe route and unregistered error code without exposing raw details', async () => {
        observabilityMocks.flush.mockResolvedValue(undefined);
        const error = Object.assign(new Error('buyer@example.com private message'), {
            code: 'BUYER_PRIVATE_SECRET',
            stack: 'private stack',
        });

        await onRequestError(error, {
            method: 'GET',
            path: '/raw/private-path?buyer=private',
            headers: { authorization: 'Bearer private-token' },
        }, {
            routerKind: 'App Router',
            routePath: '/api/example?buyer=private',
            routeType: 'route',
            revalidateReason: undefined,
        });

        const input = observabilityMocks.emit.mock.calls[0]?.[0] as OperationalEvent;
        const sanitized = sanitizeOperationalEvent(input);
        expect(sanitized.fields.route).toBeUndefined();
        expect(sanitized.fields.error_code).toBeUndefined();
        expect(sanitized.fields.error_name).toBe('Error');
        expect(JSON.stringify(sanitized)).not.toContain('private');
        expect(JSON.stringify(sanitized)).not.toContain('buyer@example.com');
        expect(JSON.stringify(sanitized)).not.toContain('authorization');
    });

    it('fails open when logging and flush both throw', async () => {
        observabilityMocks.emit.mockImplementation(() => {
            throw new Error('logger unavailable');
        });
        observabilityMocks.flush.mockRejectedValue(new Error('flush unavailable'));

        await expect(onRequestError(new Error('route failed'), {
            method: 'GET',
            path: '/private',
            headers: {},
        }, {
            routerKind: 'App Router',
            routePath: '/api/example',
            routeType: 'route',
            revalidateReason: undefined,
        })).resolves.toBeUndefined();
    });

    it('keeps a custom server-only source boundary with no default Axiom transforms', () => {
        const source = readFileSync(new URL('../../instrumentation.ts', import.meta.url), 'utf8');

        expect(source.indexOf("import 'server-only';")).toBe(0);
        expect(source).toContain('Instrumentation.onRequestError');
        expect(source).toContain('errorContext.routePath');
        expect(source).toContain('errorRequest.method');
        expect(source).not.toContain('errorRequest.path');
        expect(source).not.toContain('errorRequest.headers');
        expect(source).not.toContain('nextJsFormatters');
        expect(source).not.toContain('serverContextFieldsFormatter');
        expect(source).not.toContain('@axiomhq/nextjs');
    });
});
