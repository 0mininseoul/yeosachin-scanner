import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    admitAndAdvanceEarlybirdFulfillment,
    earlybirdFulfillmentDiagnostic,
    supabaseEarlybirdFulfillmentOperator,
    type EarlybirdFulfillmentDiagnostic,
} from '../lib/services/earlybird/fulfillment-store';
import { APIFY_CREDENTIAL_SLOTS, type ApifyCredentialSlot } from '../lib/services/instagram/providers/types';

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
    bindCredentialSlot?(orderId: string, slot: ApifyCredentialSlot): Promise<void>;
    writeStdout(value: string): void;
}

export type EarlybirdFulfillmentCliFailure = Readonly<{
    status: 'failed';
    errorCode: string;
    stage?: EarlybirdFulfillmentDiagnostic['stage'];
    category?: EarlybirdFulfillmentDiagnostic['category'];
}>;

export function formatEarlybirdFulfillmentCliFailure(
    error: unknown
): EarlybirdFulfillmentCliFailure {
    const diagnostic = earlybirdFulfillmentDiagnostic(error);
    if (!diagnostic) {
        return Object.freeze({
            status: 'failed',
            errorCode: 'EARLYBIRD_FULFILLMENT_FAILED',
        });
    }
    return Object.freeze({
        status: 'failed',
        ...diagnostic,
    });
}

export function parseEarlybirdFulfillmentCliArgs(
    args: readonly string[]
): { orderId: string; credentialSlot: ApifyCredentialSlot | null } {
    let orderId: string | null = null;
    let credentialSlot: ApifyCredentialSlot | null = null;
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
        if (option === '--credential-slot') {
            if (credentialSlot !== null) throw new Error('--credential-slot must be provided exactly once');
            const value = args[index + 1];
            if (!value || value.startsWith('--')) throw new Error('--credential-slot requires an allowlisted slot');
            if (!APIFY_CREDENTIAL_SLOTS.includes(
                value.trim().toLowerCase() as typeof APIFY_CREDENTIAL_SLOTS[number]
            )) {
                throw new Error('--credential-slot requires an allowlisted slot');
            }
            credentialSlot = value.trim().toLowerCase() as ApifyCredentialSlot;
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
    return Object.freeze({ orderId, credentialSlot });
}

function defaultDependencies(): EarlybirdFulfillmentCliDependencies {
    return {
        fulfill: orderId => admitAndAdvanceEarlybirdFulfillment(orderId),
        bindCredentialSlot: (orderId, slot) => supabaseEarlybirdFulfillmentOperator.bindCredentialSlot(orderId, slot),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runEarlybirdFulfillmentCli(
    args: readonly string[],
    dependencies: EarlybirdFulfillmentCliDependencies = defaultDependencies()
) {
    const { orderId, credentialSlot } = parseEarlybirdFulfillmentCliArgs(args);
    if (credentialSlot !== null) {
        if (!dependencies.bindCredentialSlot) {
            throw new Error('EARLYBIRD_ORDER_CREDENTIAL_SLOT_BIND_UNAVAILABLE');
        }
        await dependencies.bindCredentialSlot(orderId, credentialSlot);
    }
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
    runEarlybirdFulfillmentCli(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${JSON.stringify(
            formatEarlybirdFulfillmentCliFailure(error)
        )}\n`);
        process.exitCode = 1;
    });
}
