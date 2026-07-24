import { pathToFileURL } from 'node:url';
import {
    readGrobleProductLineageConfig,
    type GrobleProductLineageConfig,
} from '../lib/services/groble/config';

type Phase = 'pre-migration' | 'pre-deploy';

type Binding = Readonly<{
    plan_id: string;
    pricing_version: string;
    product_id: string;
    payment_address: string;
    expected_amount_krw: number;
    checkout_active: boolean;
}>;

type DatabaseState = Readonly<{
    bindings: readonly Binding[];
    pendingOldLineageCount: number;
}>;

export type GrobleV2ReleaseGateInput = Readonly<{
    phase: Phase;
    confirmCheckoutWritesPaused: boolean;
    env?: Readonly<Record<string, string | undefined>>;
    loadDatabaseState?: (
        config: GrobleProductLineageConfig
    ) => Promise<DatabaseState>;
}>;

function expectedBindings(config: GrobleProductLineageConfig): Binding[] {
    return [
        {
            plan_id: 'basic',
            pricing_version: 'earlybird-2026-07-v1',
            product_id: config.legacyProductIds.basic,
            payment_address: config.legacyPaymentAddresses.basic,
            expected_amount_krw: 14_900,
            checkout_active: false,
        },
        {
            plan_id: 'standard',
            pricing_version: 'earlybird-2026-07-v1',
            product_id: config.legacyProductIds.standard,
            payment_address: config.legacyPaymentAddresses.standard,
            expected_amount_krw: 19_900,
            checkout_active: false,
        },
        {
            plan_id: 'basic',
            pricing_version: 'earlybird-2026-07-v2',
            product_id: config.productIds.basic,
            payment_address: config.paymentAddresses.basic,
            expected_amount_krw: 6_900,
            checkout_active: true,
        },
        {
            plan_id: 'standard',
            pricing_version: 'earlybird-2026-07-v2',
            product_id: config.productIds.standard,
            payment_address: config.paymentAddresses.standard,
            expected_amount_krw: 9_900,
            checkout_active: true,
        },
    ];
}

function canonicalBindings(bindings: readonly Binding[]): string {
    return JSON.stringify(
        [...bindings].sort((left, right) => (
            `${left.pricing_version}:${left.plan_id}`
                .localeCompare(`${right.pricing_version}:${right.plan_id}`)
        ))
    );
}

async function loadProductionDatabaseState(
    config: GrobleProductLineageConfig
): Promise<DatabaseState> {
    const { supabaseAdmin } = await import('../lib/supabase/admin');
    const { data: bindings, error: bindingError } = await supabaseAdmin
        .from('earlybird_groble_product_versions')
        .select(
            'plan_id,pricing_version,product_id,payment_address,'
            + 'expected_amount_krw,checkout_active'
        );
    if (bindingError || !bindings) {
        throw new Error('GROBLE_V2_DB_BINDINGS_READ_FAILED');
    }

    const { count, error: pendingError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'payment_pending')
        .in('expected_groble_product_id', [
            config.legacyProductIds.basic,
            config.legacyProductIds.standard,
        ]);
    if (pendingError || count === null) {
        throw new Error('GROBLE_V2_PENDING_OLD_LINEAGE_READ_FAILED');
    }

    return {
        bindings: bindings as unknown as Binding[],
        pendingOldLineageCount: count,
    };
}

export async function runGrobleV2ReleaseGate(
    input: GrobleV2ReleaseGateInput
): Promise<{
    phase: Phase;
    status: 'passed';
}> {
    if (!input.confirmCheckoutWritesPaused) {
        throw new Error('GROBLE_V2_MAINTENANCE_CONFIRMATION_REQUIRED');
    }
    if (input.phase !== 'pre-migration' && input.phase !== 'pre-deploy') {
        throw new Error('GROBLE_V2_GATE_PHASE_INVALID');
    }
    const config = readGrobleProductLineageConfig(input.env ?? process.env);
    if (input.phase === 'pre-migration') {
        return { phase: input.phase, status: 'passed' };
    }

    const state = await (
        input.loadDatabaseState ?? loadProductionDatabaseState
    )(config);
    if (
        canonicalBindings(state.bindings)
        !== canonicalBindings(expectedBindings(config))
    ) {
        throw new Error('GROBLE_V2_DB_BINDINGS_MISMATCH');
    }
    if (state.pendingOldLineageCount !== 0) {
        throw new Error('GROBLE_V2_PENDING_OLD_LINEAGE_REMAINS');
    }
    return { phase: input.phase, status: 'passed' };
}

function parseCliArguments(args: readonly string[]): {
    phase: Phase;
    confirmCheckoutWritesPaused: boolean;
} {
    const phaseIndex = args.indexOf('--phase');
    const phase = args[phaseIndex + 1];
    if (phase !== 'pre-migration' && phase !== 'pre-deploy') {
        throw new Error('GROBLE_V2_GATE_PHASE_INVALID');
    }
    return {
        phase,
        confirmCheckoutWritesPaused:
            args.includes('--confirm-checkout-writes-paused'),
    };
}

async function main(): Promise<void> {
    const result = await runGrobleV2ReleaseGate({
        ...parseCliArguments(process.argv.slice(2)),
        env: process.env,
    });
    console.log(JSON.stringify(result));
}

if (
    process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main().catch((error: unknown) => {
        const message = error instanceof Error
            ? error.message
            : 'GROBLE_V2_GATE_FAILED';
        console.error(message);
        process.exitCode = 1;
    });
}
