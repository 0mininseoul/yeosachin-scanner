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
    const unsafeContextFormatter = vi.fn((event: Record<string, unknown>) => ({
        ...event,
        request_url: 'https://example.com/?buyer=private',
        fields: {
            ...(event.fields as Record<string, unknown>),
            email: 'buyer@example.com',
            url: 'https://example.com/?token=secret',
        },
    }));

    return {
        axiomConstructor,
        transportConstructor,
        loggerConstructor,
        loggerLog,
        loggerFlush,
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
    nextJsFormatters: [axiomMocks.unsafeContextFormatter],
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
            event: 'privacy.checked',
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
            'privacy.checked',
            expect.objectContaining({
                schema_version: 1,
                service: 'yeosachin-web',
                event: 'privacy.checked',
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

        expect(() => logger.emit({ event: 'disabled.checked', severity: 'info' })).not.toThrow();
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

        expect(() => synchronous.emit({ event: 'emit.failed', severity: 'error' })).not.toThrow();
        expect(() => asynchronous.emit({ event: 'emit.rejected', severity: 'error' })).not.toThrow();
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
});

describe('server-only module boundary', () => {
    it('uses the compile-time Next marker before importing Axiom and pins its package', () => {
        const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
        const packageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { dependencies?: Record<string, string> };
        const markerIndex = source.indexOf("import 'server-only';");
        const axiomIndex = source.indexOf("from '@axiomhq/js';");

        expect(markerIndex).toBeGreaterThanOrEqual(0);
        expect(markerIndex).toBeLessThan(axiomIndex);
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

        operationalLogger.emit({ event: 'runtime.disabled', severity: 'info' });
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
            event: 'runtime.enabled',
            severity: 'info',
            fields: { provider: 'apify', email: 'buyer@example.com' },
        });

        expect(axiomMocks.axiomConstructor).toHaveBeenCalledWith({
            token: 'runtime-token',
            orgId: 'aa-example',
        });
        const axiom = axiomMocks.axiomConstructor.mock.results[0]?.value;
        expect(axiomMocks.transportConstructor).toHaveBeenCalledWith({
            axiom,
            dataset: 'yeosachin-logs',
        });
        expect(axiomMocks.loggerConstructor).toHaveBeenCalledTimes(1);
        expect(axiomMocks.loggerLog).toHaveBeenCalledWith(
            'info',
            'runtime.enabled',
            expect.objectContaining({ provider: 'apify' }),
        );
        expect(JSON.stringify(axiomMocks.loggerLog.mock.calls)).not.toContain('buyer@example.com');
        expect(JSON.stringify(axiomMocks.loggerLog.mock.calls)).not.toContain('runtime-token');

        const config = axiomMocks.loggerConstructor.mock.calls[0]?.[0] as {
            formatters: Array<(event: Record<string, unknown>) => Record<string, unknown>>;
            overrideDefaultFormatters: boolean;
        };
        expect(config.overrideDefaultFormatters).toBe(true);
        const formatted = config.formatters.reduce<Record<string, unknown>>(
            (event, formatter) => formatter(event),
            {
            level: 'info',
            message: 'runtime.enabled',
            fields: { event: 'runtime.enabled', severity: 'info', provider: 'apify' },
            _time: '2026-07-18T00:00:00.000Z',
            '@app': { 'next-axiom-version': '0.3.0' },
            source: 'server-log',
            },
        );
        expect(formatted).not.toHaveProperty('request_url');
        expect(formatted.fields).toEqual(expect.objectContaining({
            event: 'runtime.enabled',
            severity: 'info',
            provider: 'apify',
        }));
        expect(JSON.stringify(formatted)).not.toContain('buyer@example.com');
        expect(JSON.stringify(formatted)).not.toContain('token=secret');

        await flushOperationalLogs();
        expect(axiomMocks.loggerFlush).toHaveBeenCalledTimes(1);
        operationalLogger.emit({ event: 'runtime.second', severity: 'debug' });
        expect(axiomMocks.loggerConstructor).toHaveBeenCalledTimes(1);
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
            event: 'runtime.constructor_failed',
            severity: 'error',
        })).not.toThrow();
        await expect(flushOperationalLogs()).resolves.toBeUndefined();
    });
});
