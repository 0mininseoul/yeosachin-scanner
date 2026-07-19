import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const axiomMocks = vi.hoisted(() => {
    const axiomConstructor = vi.fn(function MockAxiom(this: object, config: unknown) {
        void config;
        return this;
    });
    const transportConstructor = vi.fn(function MockAxiomTransport(this: object, config: unknown) {
        void config;
        return this;
    });
    const loggerLog = vi.fn();
    const loggerFlush = vi.fn(async () => undefined);
    const loggerConstructor = vi.fn(function MockLogger(this: object, config: unknown) {
        void config;
        return {
            log: loggerLog,
            flush: loggerFlush,
        };
    });
    const frameworkIdentifierFormatter = vi.fn((event: Record<string, unknown>) => ({
        ...event,
        '@app': { 'next-axiom-version': '0.3.0' },
    }));
    const unsafeContextFormatter = vi.fn((event: Record<string, unknown>) => ({
        ...event,
        message: 'context.secret_token',
        '@app': { 'next-axiom-version': 'secret-token' },
        request_url: 'https://example.com/?buyer=private',
        fields: {
            ...(event.fields as Record<string, unknown>),
            event: 'xaat-secret-token',
            email: 'buyer@example.com',
            url: 'https://example.com/?token=secret',
            provider: 'xaat-secret-token',
            operation: 'xaat-secret-token',
            phase: 'xaat-secret-token',
            disposition: 'xaat-secret-token',
            queue_name: 'xaat-secret-token',
            error_code: 'AUTH_SKLIVEABC123',
        },
    }));

    return {
        axiomConstructor,
        transportConstructor,
        loggerConstructor,
        loggerLog,
        loggerFlush,
        frameworkIdentifierFormatter,
        unsafeContextFormatter,
    };
});

vi.mock('server-only', () => ({}));
vi.mock('@axiomhq/js', () => ({ Axiom: axiomMocks.axiomConstructor }));
vi.mock('@axiomhq/logging', () => ({
    AxiomJSTransport: axiomMocks.transportConstructor,
    Logger: axiomMocks.loggerConstructor,
}));
vi.mock('@axiomhq/nextjs', () => ({
    frameworkIdentifierFormatter: axiomMocks.frameworkIdentifierFormatter,
    serverContextFieldsFormatter: axiomMocks.unsafeContextFormatter,
    nextJsFormatters: [
        axiomMocks.frameworkIdentifierFormatter,
        axiomMocks.unsafeContextFormatter,
    ],
}));

import {
    MAX_BATCH_EXCEPTION_EVENTS,
    createOperationalLogger,
    emitBatchOutcome,
    type OperationalBatchItemOutcome,
    type OperationalLogger,
    type OperationalTransport,
} from './server';

const AXIOM_ENV_NAMES = ['AXIOM_TOKEN', 'AXIOM_DATASET', 'AXIOM_ORG_ID'] as const;
const ORIGINAL_AXIOM_ENV = Object.fromEntries(
    AXIOM_ENV_NAMES.map(name => [name, process.env[name]]),
);

beforeEach(() => {
    vi.clearAllMocks();
    for (const name of AXIOM_ENV_NAMES) delete process.env[name];
});

afterEach(() => {
    vi.useRealTimers();
    for (const name of AXIOM_ENV_NAMES) {
        const original = ORIGINAL_AXIOM_ENV[name];
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
});

describe('createOperationalLogger', () => {
    it('sends only sanitized fields to an injected transport', () => {
        const transport: OperationalTransport = {
            log: vi.fn(),
            flush: vi.fn(async () => undefined),
        };
        const logger = createOperationalLogger(transport);

        logger.emit({
            event: 'scraper.candidate_failed',
            severity: 'info',
            fields: {
                provider: 'apify',
                candidate_instagram_id: 'Candidate.Account',
                email: 'buyer@example.com',
                payload: { token: 'secret' },
            },
        });

        expect(transport.log).toHaveBeenCalledTimes(1);
        expect(transport.log).toHaveBeenCalledWith(
            'info',
            'scraper.candidate_failed',
            expect.objectContaining({
                schema_version: 1,
                service: 'yeosachin-web',
                event: 'scraper.candidate_failed',
                severity: 'info',
                provider: 'apify',
                candidate_instagram_id: 'candidate.account',
            }),
        );
        const serialized = JSON.stringify(vi.mocked(transport.log).mock.calls);
        expect(serialized).not.toContain('buyer@example.com');
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('payload');
    });

    it('is disabled cleanly when no transport is available', async () => {
        const logger = createOperationalLogger();

        expect(() => logger.emit({ event: 'http.route_completed', severity: 'info' })).not.toThrow();
        await expect(logger.flush()).resolves.toBeUndefined();
    });

    it('swallows synchronous emit failures and asynchronous emit rejections', async () => {
        const synchronous = createOperationalLogger({
            log: () => {
                throw new Error('transport is unavailable');
            },
            flush: async () => undefined,
        });
        const asynchronous = createOperationalLogger({
            log: (() => Promise.reject(new Error('async transport failure'))) as OperationalTransport['log'],
            flush: async () => undefined,
        });

        expect(() => synchronous.emit({ event: 'http.route_failed', severity: 'error' })).not.toThrow();
        expect(() => asynchronous.emit({ event: 'next.request_error', severity: 'error' })).not.toThrow();
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('swallows synchronous and rejected flush failures', async () => {
        const synchronous = createOperationalLogger({
            log: () => undefined,
            flush: (() => {
                throw new Error('flush threw');
            }) as OperationalTransport['flush'],
        });
        const asynchronous = createOperationalLogger({
            log: () => undefined,
            flush: async () => {
                throw new Error('flush rejected');
            },
        });

        await expect(synchronous.flush()).resolves.toBeUndefined();
        await expect(asynchronous.flush()).resolves.toBeUndefined();
    });

    it('returns within one second when the transport flush never settles', async () => {
        vi.useFakeTimers();
        const logger = createOperationalLogger({
            log: () => undefined,
            flush: () => new Promise(() => undefined),
        });
        let completed = false;

        void logger.flush().then(() => {
            completed = true;
        });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(completed).toBe(true);
    });

    it('observes a transport rejection that arrives after the flush timeout', async () => {
        vi.useFakeTimers();
        let rejectTransport: ((reason: Error) => void) | undefined;
        const logger = createOperationalLogger({
            log: () => undefined,
            flush: () => new Promise((_, reject) => {
                rejectTransport = reject;
            }),
        });
        const unhandledRejection = vi.fn();
        process.on('unhandledRejection', unhandledRejection);

        try {
            const flushing = logger.flush();
            await vi.advanceTimersByTimeAsync(1_000);
            await flushing;
            rejectTransport?.(new Error('late transport failure'));
            await vi.advanceTimersByTimeAsync(0);

            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandledRejection);
        }
    });
});

describe('server-only module boundary', () => {
    it('uses the compile-time Next marker before importing Axiom and pins its package', () => {
        const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
        const packageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { dependencies?: Record<string, string> };
        const markerIndex = source.indexOf("import 'server-only';");

        expect(markerIndex).toBe(0);
        expect(source).not.toMatch(/^import .*['"]@axiomhq\/(?:js|logging|nextjs)['"];?$/m);
        expect(source).toContain("await import('@axiomhq/js')");
        expect(source).toContain("await import('@axiomhq/logging')");
        expect(source).toContain("await import('@axiomhq/nextjs')");
        expect(source).not.toContain('nextJsFormatters');
        expect(source).not.toContain('serverContextFieldsFormatter');
        expect(source).not.toContain("typeof window !== 'undefined'");
        expect(packageJson.dependencies?.['server-only']).toBe('0.0.1');
    });
});

describe('emitBatchOutcome', () => {
    it('emits one aggregate and no individual records for 1,000 successful items', () => {
        const emit = vi.fn();
        const logger: OperationalLogger = { emit, flush: async () => undefined };

        emitBatchOutcome({
            summary: {
                event: 'scraper.batch_completed',
                severity: 'info',
                fields: { input_count: 1_000, output_count: 1_000 },
            },
            items: Array.from({ length: 1_000 }, (_, index) => ({
                event: 'scraper.candidate_completed',
                disposition: 'success' as const,
                fields: { candidate_instagram_id: `candidate_${index}` },
            })),
        }, logger);

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'scraper.batch_completed',
        }));
    });

    it('emits only failure, retry, and fallback items up to the documented cap', () => {
        const emit = vi.fn();
        const logger: OperationalLogger = { emit, flush: async () => undefined };
        const exceptionalItems = Array.from({ length: MAX_BATCH_EXCEPTION_EVENTS + 10 }, (_, index) => ({
            event: 'scraper.candidate_failed',
            disposition: (['failure', 'retry', 'fallback'] as const)[index % 3],
            fields: { candidate_instagram_id: `failed_${index}` },
        }));

        emitBatchOutcome({
            summary: { event: 'scraper.batch_completed', severity: 'warn' },
            items: [
                { event: 'scraper.candidate_completed', disposition: 'success' },
                ...exceptionalItems,
            ],
        }, logger);

        expect(MAX_BATCH_EXCEPTION_EVENTS).toBeLessThanOrEqual(25);
        expect(emit).toHaveBeenCalledTimes(1 + MAX_BATCH_EXCEPTION_EVENTS);
        expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
            event: 'scraper.candidate_completed',
        }));
        expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
            fields: expect.objectContaining({ candidate_instagram_id: 'failed_25' }),
        }));
        expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
            severity: 'error',
            fields: expect.objectContaining({ disposition: 'failure' }),
        }));
        expect(emit).toHaveBeenNthCalledWith(3, expect.objectContaining({
            severity: 'warn',
            fields: expect.objectContaining({ disposition: 'retry' }),
        }));
    });

    it('caps exceptional attempts even when every injected item emit throws', () => {
        const emit = vi.fn(() => {
            throw new Error('injected logger failure');
        });
        const logger: OperationalLogger = { emit, flush: async () => undefined };

        emitBatchOutcome({
            summary: { event: 'scraper.batch_failed', severity: 'error' },
            items: Array.from({ length: 1_000 }, (_, index) => ({
                event: 'scraper.candidate_failed',
                disposition: 'failure' as const,
                fields: { candidate_instagram_id: `failed_${index}` },
            })),
        }, logger);

        expect(emit).toHaveBeenCalledTimes(1 + MAX_BATCH_EXCEPTION_EVENTS);
    });

    it('ignores unknown runtime dispositions', () => {
        const emit = vi.fn();
        const logger: OperationalLogger = { emit, flush: async () => undefined };

        emitBatchOutcome({
            summary: { event: 'scraper.batch_completed', severity: 'info' },
            items: [{
                event: 'scraper.candidate_failed',
                disposition: 'cancelled',
                fields: { candidate_instagram_id: 'must_not_emit' },
            } as unknown as OperationalBatchItemOutcome],
        }, logger);

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
            event: 'scraper.candidate_failed',
        }));
    });
});

describe('operationalLogger runtime transport', () => {
    it('does not construct Axiom when any trimmed server runtime setting is missing', async () => {
        process.env.AXIOM_TOKEN = '   ';
        process.env.AXIOM_DATASET = 'yeosachin-logs';
        process.env.AXIOM_ORG_ID = 'aa-example';
        vi.resetModules();
        const { operationalLogger, flushOperationalLogs } = await import('./server');

        operationalLogger.emit({ event: 'http.route_completed', severity: 'info' });
        await flushOperationalLogs();

        expect(axiomMocks.axiomConstructor).not.toHaveBeenCalled();
        expect(axiomMocks.transportConstructor).not.toHaveBeenCalled();
        expect(axiomMocks.loggerConstructor).not.toHaveBeenCalled();
    });

    it('constructs the official stack lazily with trimmed settings and re-sanitizes formatter output', async () => {
        process.env.AXIOM_TOKEN = '  runtime-token  ';
        process.env.AXIOM_DATASET = '  yeosachin-logs  ';
        process.env.AXIOM_ORG_ID = '  aa-example  ';
        vi.resetModules();
        const { operationalLogger, flushOperationalLogs } = await import('./server');

        expect(axiomMocks.axiomConstructor).not.toHaveBeenCalled();
        operationalLogger.emit({
            event: 'http.route_completed',
            severity: 'info',
            fields: { provider: 'apify', email: 'buyer@example.com' },
        });
        await flushOperationalLogs();

        expect(axiomMocks.axiomConstructor).toHaveBeenCalledWith({
            token: 'runtime-token',
            orgId: 'aa-example',
        });
        const axiom = axiomMocks.axiomConstructor.mock.results[0]?.value;
        expect(axiomMocks.transportConstructor).toHaveBeenCalledWith({
            axiom,
            dataset: 'yeosachin-logs',
            logLevel: 'debug',
        });
        expect(axiomMocks.loggerConstructor).toHaveBeenCalledTimes(1);
        expect(axiomMocks.loggerConstructor).toHaveBeenCalledWith(expect.objectContaining({
            logLevel: 'debug',
        }));
        expect(axiomMocks.loggerLog).toHaveBeenCalledWith(
            'info',
            'http.route_completed',
            expect.objectContaining({ provider: 'apify' }),
        );
        expect(JSON.stringify(axiomMocks.loggerLog.mock.calls)).not.toContain('buyer@example.com');
        expect(JSON.stringify(axiomMocks.loggerLog.mock.calls)).not.toContain('runtime-token');

        const config = axiomMocks.loggerConstructor.mock.calls[0]?.[0] as {
            formatters: Array<(event: Record<string, unknown>) => Record<string, unknown>>;
            overrideDefaultFormatters: boolean;
        };
        expect(config.overrideDefaultFormatters).toBe(true);
        expect(config.formatters).toHaveLength(2);
        expect(config.formatters[0]).toBe(axiomMocks.frameworkIdentifierFormatter);
        expect(config.formatters[1]).not.toBe(axiomMocks.unsafeContextFormatter);
        const formatted = config.formatters.reduce<Record<string, unknown>>(
            (event, formatter) => formatter(event),
            {
            level: 'info',
            message: 'context.secret_token',
            fields: { event: 'http.route_completed', severity: 'info', provider: 'apify' },
            _time: '2026-07-18T00:00:00.000Z',
            '@app': { 'next-axiom-version': 'secret-token' },
            source: 'server-log',
            },
        );
        expect(formatted).not.toHaveProperty('request_url');
        expect(formatted).not.toHaveProperty('@app');
        expect(formatted.message).toBe('http.route_completed');
        expect(formatted.fields).toEqual(expect.objectContaining({
            event: 'http.route_completed',
            severity: 'info',
            provider: 'apify',
        }));
        expect(JSON.stringify(formatted)).not.toContain('buyer@example.com');
        expect(JSON.stringify(formatted)).not.toContain('token=secret');
        expect(JSON.stringify(formatted)).not.toContain('xaat-secret-token');
        expect(JSON.stringify(formatted)).not.toContain('AUTH_SKLIVEABC123');
        expect(JSON.stringify(formatted)).not.toContain('secret-token');
        expect(axiomMocks.frameworkIdentifierFormatter).toHaveBeenCalledTimes(1);
        expect(axiomMocks.unsafeContextFormatter).not.toHaveBeenCalled();

        const smuggled = config.formatters.reduce<Record<string, unknown>>(
            (event, formatter) => formatter(event),
            {
                level: 'warn',
                message: 'xaat-secret-token',
                fields: {
                    event: 'xaat-secret-token',
                    severity: 'warn',
                    provider: 'xaat-secret-token',
                    operation: 'xaat-secret-token',
                    phase: 'xaat-secret-token',
                    disposition: 'xaat-secret-token',
                    queue_name: 'xaat-secret-token',
                    error_name: 'SecretToken',
                    error_code: 'AUTH_SKLIVEABC123',
                },
                '@app': { 'next-axiom-version': 'xaat-secret-token' },
            },
        );
        expect(smuggled.message).toBe('operational.invalid_event');
        expect(smuggled).not.toHaveProperty('@app');
        expect(JSON.stringify(smuggled)).not.toContain('xaat-secret-token');
        expect(JSON.stringify(smuggled)).not.toContain('SecretToken');
        expect(JSON.stringify(smuggled)).not.toContain('AUTH_SKLIVEABC123');
        expect(axiomMocks.frameworkIdentifierFormatter).toHaveBeenCalledTimes(2);
        expect(axiomMocks.unsafeContextFormatter).not.toHaveBeenCalled();

        expect(axiomMocks.loggerFlush).toHaveBeenCalledTimes(1);
        operationalLogger.emit({ event: 'next.request_error', severity: 'debug' });
        await flushOperationalLogs();
        expect(axiomMocks.loggerConstructor).toHaveBeenCalledTimes(1);
        expect(axiomMocks.loggerLog).toHaveBeenLastCalledWith(
            'debug',
            'next.request_error',
            expect.objectContaining({ severity: 'debug' }),
        );
        expect(axiomMocks.loggerFlush).toHaveBeenCalledTimes(2);
    });

    it('fails open when official transport construction throws', async () => {
        process.env.AXIOM_TOKEN = 'runtime-token';
        process.env.AXIOM_DATASET = 'yeosachin-logs';
        process.env.AXIOM_ORG_ID = 'aa-example';
        axiomMocks.axiomConstructor.mockImplementationOnce(() => {
            throw new Error('constructor failed');
        });
        vi.resetModules();
        const { operationalLogger, flushOperationalLogs } = await import('./server');

        expect(() => operationalLogger.emit({
            event: 'http.route_failed',
            severity: 'error',
        })).not.toThrow();
        await expect(flushOperationalLogs()).resolves.toBeUndefined();
    });
});
