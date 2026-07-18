import 'server-only';

import { Axiom } from '@axiomhq/js';
import {
    AxiomJSTransport,
    Logger,
    type Formatter,
    type LogEvent,
} from '@axiomhq/logging';
import { nextJsFormatters } from '@axiomhq/nextjs';

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

function swallowPossibleRejection(result: unknown): void {
    if (
        result
        && (typeof result === 'object' || typeof result === 'function')
        && typeof (result as PromiseLike<unknown>).then === 'function'
    ) {
        void Promise.resolve(result).catch(() => undefined);
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
                await transport.flush();
            } catch {
                // Observability must never change the product outcome.
            }
        },
    };
}

function formatterSeverity(value: unknown): OperationalSeverity {
    return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

function safeNextJsVersion(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const version = (value as Record<string, unknown>)['next-axiom-version'];
    return typeof version === 'string'
        && version.length <= 32
        && /^[0-9A-Za-z.+-]+$/.test(version)
        ? version
        : undefined;
}

const privacyBoundaryFormatter: Formatter = (logEvent): LogEvent => {
    const severity = formatterSeverity(logEvent.level);
    const event = typeof logEvent.message === 'string'
        ? logEvent.message
        : 'operational.invalid_event';
    const sanitized = sanitizeOperationalEvent({
        event,
        severity,
        fields: logEvent.fields && typeof logEvent.fields === 'object'
            ? logEvent.fields as Record<string, unknown>
            : undefined,
    });
    const nextJsVersion = safeNextJsVersion(logEvent['@app']);

    return {
        level: severity,
        message: sanitized.message,
        fields: sanitized.fields,
        _time: new Date().toISOString(),
        '@app': nextJsVersion ? { 'next-axiom-version': nextJsVersion } : {},
        source: 'server-log',
    };
};

function runtimeTransport(): OperationalTransport | undefined {
    const token = process.env.AXIOM_TOKEN?.trim();
    const dataset = process.env.AXIOM_DATASET?.trim();
    const orgId = process.env.AXIOM_ORG_ID?.trim();
    if (!token || !dataset || !orgId) return undefined;

    const axiom = new Axiom({ token, orgId });
    const logger = new Logger({
        transports: [new AxiomJSTransport({ axiom, dataset })],
        formatters: [...nextJsFormatters, privacyBoundaryFormatter],
        overrideDefaultFormatters: true,
    });

    return {
        log: (level, message, fields) => logger.log(level, message, fields),
        flush: () => logger.flush(),
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
