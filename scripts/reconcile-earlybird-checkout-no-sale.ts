import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase/admin';

const orderIdSchema = z.string().uuid().transform(value => value.toLowerCase());
const checkedAtSchema = z.string().datetime({ offset: true });
const reasonSchema = z.literal('provider_dashboard_no_sale');
const outputSchema = z.object({
    disposition: z.enum(['reconciled', 'already_reconciled']),
    status: z.literal('payment_failed'),
}).strict();

export interface EarlybirdCheckoutReconciliationCliInput {
    orderId: string;
    providerCheckedAt: string;
    reason: 'provider_dashboard_no_sale';
}

export interface EarlybirdCheckoutReconciliationCliDependencies {
    reconcile(input: EarlybirdCheckoutReconciliationCliInput): Promise<unknown>;
    writeStdout(value: string): void;
}

export function parseEarlybirdCheckoutReconciliationCliArgs(
    args: readonly string[]
): EarlybirdCheckoutReconciliationCliInput {
    let orderId: string | null = null;
    let providerCheckedAt: string | null = null;
    let reason: 'provider_dashboard_no_sale' | null = null;
    let confirmed = false;

    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--confirm-provider-dashboard-no-sale') {
            if (confirmed) {
                throw new Error(
                    '--confirm-provider-dashboard-no-sale must be provided exactly once'
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
            orderId = orderIdSchema.parse(value);
            index += 1;
            continue;
        }
        if (option === '--provider-checked-at') {
            if (providerCheckedAt !== null) {
                throw new Error('--provider-checked-at must be provided exactly once');
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--provider-checked-at requires an ISO timestamp');
            }
            providerCheckedAt = checkedAtSchema.parse(value);
            index += 1;
            continue;
        }
        if (option === '--reason') {
            if (reason !== null) {
                throw new Error('--reason must be provided exactly once');
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--reason requires provider_dashboard_no_sale');
            }
            reason = reasonSchema.parse(value);
            index += 1;
            continue;
        }
        throw new Error(`unknown argument: ${option}`);
    }

    if (!orderId || !providerCheckedAt || !reason || !confirmed) {
        throw new Error(
            '--order-id, --provider-checked-at, --reason, and --confirm-provider-dashboard-no-sale are required'
        );
    }
    return Object.freeze({ orderId, providerCheckedAt, reason });
}

function defaultDependencies(): EarlybirdCheckoutReconciliationCliDependencies {
    return {
        async reconcile(input) {
            const { data, error } = await supabaseAdmin.rpc(
                'reconcile_earlybird_checkout_no_sale',
                {
                    p_order_id: input.orderId,
                    p_provider_checked_at: input.providerCheckedAt,
                    p_reason: input.reason,
                    p_confirm_provider_dashboard_no_sale: true,
                }
            );
            if (error) throw new Error('EARLYBIRD_RECONCILIATION_FAILED');
            return data;
        },
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runEarlybirdCheckoutReconciliationCli(
    args: readonly string[],
    dependencies: EarlybirdCheckoutReconciliationCliDependencies = defaultDependencies()
) {
    const input = parseEarlybirdCheckoutReconciliationCliArgs(args);
    const result = await dependencies.reconcile(input);
    const parsed = outputSchema.parse(Array.isArray(result) ? result[0] : result);
    dependencies.writeStdout(`${JSON.stringify(parsed)}\n`);
    return Object.freeze(parsed);
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runEarlybirdCheckoutReconciliationCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            errorCode: 'EARLYBIRD_RECONCILIATION_FAILED',
        })}\n`);
        process.exitCode = 1;
    });
}
