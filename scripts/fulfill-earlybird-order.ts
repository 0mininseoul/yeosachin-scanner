import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    admitAndAdvanceEarlybirdFulfillment,
} from '../lib/services/earlybird/fulfillment-store';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const outputSchema = z.object({
    orderId: uuidSchema,
    status: z.enum([
        'admission_pending',
        'analysis_in_progress',
        'completed',
        'manual_review',
    ]),
    requestId: uuidSchema.nullable(),
    nextAction: z.enum([
        'wait_for_fresh_admission',
        'monitor_analysis',
        'completed',
        'manual_review',
    ]),
}).strict();

export interface EarlybirdFulfillmentCliDependencies {
    fulfill(orderId: string): Promise<unknown>;
    writeStdout(value: string): void;
}

export function parseEarlybirdFulfillmentCliArgs(
    args: readonly string[]
): { orderId: string } {
    let orderId: string | null = null;
    let confirmed = false;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--confirm-paid-api-call') {
            if (confirmed) {
                throw new Error(
                    '--confirm-paid-api-call must be provided exactly once'
                );
            }
            confirmed = true;
            continue;
        }
        if (option === '--order-id') {
            if (orderId !== null) {
                throw new Error('--order-id must be provided exactly once');
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--order-id requires a UUID');
            }
            orderId = uuidSchema.parse(value);
            index += 1;
            continue;
        }
        throw new Error(`unknown argument: ${option}`);
    }
    if (!orderId || !confirmed) {
        throw new Error(
            '--order-id and --confirm-paid-api-call are required'
        );
    }
    return Object.freeze({ orderId });
}

function defaultDependencies(): EarlybirdFulfillmentCliDependencies {
    return {
        fulfill: orderId => admitAndAdvanceEarlybirdFulfillment(orderId),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runEarlybirdFulfillmentCli(
    args: readonly string[],
    dependencies: EarlybirdFulfillmentCliDependencies = defaultDependencies()
) {
    const { orderId } = parseEarlybirdFulfillmentCliArgs(args);
    const output = outputSchema.parse(
        await dependencies.fulfill(orderId)
    );
    dependencies.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    return Object.freeze(output);
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runEarlybirdFulfillmentCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            errorCode: 'EARLYBIRD_FULFILLMENT_FAILED',
        })}\n`);
        process.exitCode = 1;
    });
}
