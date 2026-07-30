import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    recoverAndAdvanceEarlybirdSchemaFailedFulfillment,
} from '../lib/services/earlybird/fulfillment-store';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const outputSchema = z.object({
    status: z.enum([
        'admission_pending',
        'analysis_in_progress',
        'completed',
        'manual_review',
    ]),
    nextAction: z.enum([
        'wait_for_fresh_admission',
        'monitor_analysis',
        'completed',
        'manual_review',
    ]),
}).strict();

export interface EarlybirdSchemaFailureRecoveryCliDependencies {
    recover(orderId: string): Promise<unknown>;
    writeStdout(value: string): void;
}

export function parseEarlybirdSchemaFailureRecoveryCliArgs(
    args: readonly string[]
): { orderId: string } {
    let orderId: string | null = null;
    let confirmed = false;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--confirm-schema-failure-recovery') {
            if (confirmed) {
                throw new Error(
                    '--confirm-schema-failure-recovery must be provided exactly once'
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
            '--order-id and --confirm-schema-failure-recovery are required'
        );
    }
    return Object.freeze({ orderId });
}

function defaultDependencies(): EarlybirdSchemaFailureRecoveryCliDependencies {
    return {
        recover: orderId => recoverAndAdvanceEarlybirdSchemaFailedFulfillment(orderId),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runEarlybirdSchemaFailureRecoveryCli(
    args: readonly string[],
    dependencies: EarlybirdSchemaFailureRecoveryCliDependencies = defaultDependencies()
) {
    const { orderId } = parseEarlybirdSchemaFailureRecoveryCliArgs(args);
    const result = outputSchema.parse(await dependencies.recover(orderId));
    dependencies.writeStdout(`${JSON.stringify(result)}\n`);
    return Object.freeze(result);
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runEarlybirdSchemaFailureRecoveryCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            errorCode: 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_FAILED',
        })}\n`);
        process.exitCode = 1;
    });
}
