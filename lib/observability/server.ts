import 'server-only';

import type {
    Formatter,
    LogEvent,
} from '@axiomhq/logging';

import {
    sanitizeOperationalEvent,
    type OperationalEvent,
    type OperationalSeverity,
} from './schema';

export interface OperationalTransport {
    log(
        level: OperationalSeverity,
        message: string,
        fields: Record<string, unknown>,
    ): void;
    flush(): Promise<void>;
}

export interface OperationalLogger {
    emit(input: OperationalEvent): void;
    flush(): Promise<void>;
}

export interface OperationalBatchItemOutcome {
    event: string;
    disposition: 'success' | 'failure' | 'retry' | 'fallback';
    fields?: Record<string, unknown>;
    error?: unknown;
}

export interface OperationalBatchOutcome {
    summary: OperationalEvent;
    items?: readonly OperationalBatchItemOutcome[];
}

/** Prevents one batch from generating an unbounded tail of exceptional item logs. */
export const MAX_BATCH_EXCEPTION_EVENTS = 25;
export const OPERATIONAL_FLUSH_TIMEOUT_MS = 1_000;

function swallowPossibleRejection(result: unknown): void {
    if (
        result
        && (typeof result === 'object' || typeof result === 'function')
        && typeof (result as PromiseLike<unknown>).then === 'function'
    ) {
        void Promise.resolve(result).catch(() => undefined);
    }
}

async function flushWithinDeadline(transport: OperationalTransport): Promise<void> {
    const transportFlush = Promise.resolve().then(() => transport.flush());
    void transportFlush.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            transportFlush,
            new Promise<void>(resolve => {
                timeout = setTimeout(resolve, OPERATIONAL_FLUSH_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export function createOperationalLogger(
    transport?: OperationalTransport,
): OperationalLogger {
    return {
        emit(input) {
            if (!transport) return;
            try {
                const sanitized = sanitizeOperationalEvent(input);
                const result = transport.log(
                    sanitized.fields.severity as OperationalSeverity,
                    sanitized.message,
                    sanitized.fields,
                ) as unknown;
                swallowPossibleRejection(result);
            } catch {
                // Observability must never change the product outcome.
            }
        },
        async flush() {
            if (!transport) return;
            try {
                await flushWithinDeadline(transport);
            } catch {
                // Observability must never change the product outcome.
            }
        },
    };
}

function formatterSeverity(value: unknown): OperationalSeverity {
    return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

const privacyBoundaryFormatter: Formatter = (logEvent): LogEvent => {
    const fields = logEvent.fields && typeof logEvent.fields === 'object'
        ? logEvent.fields as Record<string, unknown>
        : {};
    const severity = formatterSeverity(fields.severity);
    const event = typeof fields.event === 'string'
        ? fields.event
        : 'operational.invalid_event';
    const sanitized = sanitizeOperationalEvent({
        event,
        severity,
        fields,
    });

    return {
        level: severity,
        message: sanitized.message,
        fields: sanitized.fields,
        _time: new Date().toISOString(),
        source: 'server-log',
    } as LogEvent;
};

interface AxiomRuntimeConfig {
    token: string;
    dataset: string;
    orgId: string;
}

async function createAxiomRuntimeTransport(
    config: AxiomRuntimeConfig,
): Promise<OperationalTransport | undefined> {
    try {
        const { Axiom } = await import('@axiomhq/js');
        const { AxiomJSTransport, Logger } = await import('@axiomhq/logging');
        const { frameworkIdentifierFormatter } = await import('@axiomhq/nextjs');
        const axiom = new Axiom({ token: config.token, orgId: config.orgId });
        const logger = new Logger({
            transports: [new AxiomJSTransport({
                axiom,
                dataset: config.dataset,
                logLevel: 'debug',
            })],
            logLevel: 'debug',
            formatters: [frameworkIdentifierFormatter, privacyBoundaryFormatter],
            overrideDefaultFormatters: true,
        });

        return {
            log: (level, message, fields) => logger.log(level, message, fields),
            flush: () => logger.flush(),
        };
    } catch {
        return undefined;
    }
}

function runtimeTransport(): OperationalTransport | undefined {
    const token = process.env.AXIOM_TOKEN?.trim();
    const dataset = process.env.AXIOM_DATASET?.trim();
    const orgId = process.env.AXIOM_ORG_ID?.trim();
    if (!token || !dataset || !orgId) return undefined;

    let loadedTransport: Promise<OperationalTransport | undefined> | undefined;
    const pendingLogs = new Set<Promise<void>>();
    const load = () => {
        loadedTransport ??= createAxiomRuntimeTransport({ token, dataset, orgId });
        return loadedTransport;
    };

    return {
        log(level, message, fields) {
            const pending = load()
                .then(transport => transport?.log(level, message, fields))
                .then(() => undefined)
                .catch(() => undefined);
            pendingLogs.add(pending);
            void pending.then(() => pendingLogs.delete(pending));
        },
        async flush() {
            await Promise.allSettled([...pendingLogs]);
            const transport = await load();
            await transport?.flush();
        },
    };
}

let singletonLogger: OperationalLogger | undefined;

function lazyOperationalLogger(): OperationalLogger {
    if (singletonLogger) return singletonLogger;
    try {
        singletonLogger = createOperationalLogger(runtimeTransport());
    } catch {
        singletonLogger = createOperationalLogger();
    }
    return singletonLogger;
}

export const operationalLogger: OperationalLogger = {
    emit(input) {
        try {
            lazyOperationalLogger().emit(input);
        } catch {
            // Lazy construction and dispatch are both product-fail-open.
        }
    },
    async flush() {
        try {
            await lazyOperationalLogger().flush();
        } catch {
            // Lazy construction and dispatch are both product-fail-open.
        }
    },
};

export async function flushOperationalLogs(): Promise<void> {
    await operationalLogger.flush();
}

export function emitBatchOutcome(
    input: OperationalBatchOutcome,
    logger: OperationalLogger = operationalLogger,
): void {
    try {
        logger.emit(input.summary);
    } catch {
        // Preserve batch processing even when an injected logger is faulty.
    }

    let attempted = 0;
    for (const item of input.items ?? []) {
        if (item.disposition === 'success') continue;
        if (
            item.disposition !== 'failure'
            && item.disposition !== 'retry'
            && item.disposition !== 'fallback'
        ) {
            continue;
        }
        if (attempted === MAX_BATCH_EXCEPTION_EVENTS) break;
        attempted += 1;

        try {
            logger.emit({
                event: item.event,
                severity: item.disposition === 'failure' ? 'error' : 'warn',
                fields: {
                    ...item.fields,
                    disposition: item.disposition,
                },
                error: item.error,
            });
        } catch {
            // Preserve batch processing even when an injected logger is faulty.
        }
    }
}
