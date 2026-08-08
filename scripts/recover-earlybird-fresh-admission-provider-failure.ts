import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    recoverAndAdvanceEarlybirdFreshAdmissionProviderFailure,
} from '../lib/services/earlybird/fulfillment-store';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const outputSchema = z.object({
    status: z.enum([
        'admission_pending',
        'analysis_in_progress',
        'completed',
        'retryable_failure',
        'manual_review',
    ]),
    nextAction: z.enum([
        'wait_for_fresh_admission',
        'monitor_analysis',
        'completed',
        'manual_review',
    ]),
}).strict();
const recoveryResultSchema = outputSchema.extend({
    orderId: uuidSchema,
    requestId: uuidSchema.nullable(),
}).strict();

export interface EarlybirdFreshAdmissionProviderRecoveryCliDependencies {
    recover(orderId: string): Promise<unknown>;
    writeStdout(value: string): void;
}

export function parseEarlybirdFreshAdmissionProviderRecoveryCliArgs(
    args: readonly string[]
): { orderId: string } {
    let orderId: string | null = null;
    let confirmed = false;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--confirm-fresh-admission-provider-recovery') {
            if (confirmed) {
                throw new Error(
                    '--confirm-fresh-admission-provider-recovery must be provided exactly once'
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
            '--order-id and --confirm-fresh-admission-provider-recovery are required'
        );
    }
    return Object.freeze({ orderId });
}

function defaultDependencies(): EarlybirdFreshAdmissionProviderRecoveryCliDependencies {
    return {
        recover: orderId => (
            recoverAndAdvanceEarlybirdFreshAdmissionProviderFailure(orderId)
        ),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runEarlybirdFreshAdmissionProviderRecoveryCli(
    args: readonly string[],
    dependencies: EarlybirdFreshAdmissionProviderRecoveryCliDependencies =
        defaultDependencies()
) {
    const { orderId } = parseEarlybirdFreshAdmissionProviderRecoveryCliArgs(args);
    const recovered = recoveryResultSchema.parse(
        await dependencies.recover(orderId)
    );
    if (recovered.orderId !== orderId) {
        throw new Error('recovery result order mismatch');
    }
    const result = outputSchema.parse({
        status: recovered.status,
        nextAction: recovered.nextAction,
    });
    dependencies.writeStdout(`${JSON.stringify(result)}\n`);
    return Object.freeze(result);
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runEarlybirdFreshAdmissionProviderRecoveryCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            errorCode: 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_FAILED',
        })}\n`);
        process.exitCode = 1;
    });
}
