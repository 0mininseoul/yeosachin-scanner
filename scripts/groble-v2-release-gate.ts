import { readFile } from 'node:fs/promises';
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

export type GrobleV2ApprovedLineageManifest = Readonly<{
    schemaVersion: 1;
    approvalId: string;
    reviewedAt: string;
    legacy: Readonly<Record<'basic' | 'standard', Readonly<{
        productId: string;
        paymentAddress: string;
    }>>>;
    v2: Readonly<Record<'basic' | 'standard', Readonly<{
        productId: string;
        paymentAddress: string;
    }>>>;
}>;

type HistoricalProductEvidence = Readonly<{
    source: 'order' | 'webhook';
    plan_id: 'basic' | 'standard' | null;
    product_id: string;
}>;

type DatabaseState = Readonly<{
    bindings: readonly Binding[];
    pendingOldLineageCount: number;
    historicalProductEvidence: readonly HistoricalProductEvidence[];
    unassignedCommercialWebhookCandidateCount: number;
}>;

export type GrobleV2ReleaseGateInput = Readonly<{
    phase: Phase;
    confirmCheckoutWritesPaused: boolean;
    approvedManifest?: GrobleV2ApprovedLineageManifest;
    env?: Readonly<Record<string, string | undefined>>;
    loadDatabaseState?: (
        config: GrobleProductLineageConfig
    ) => Promise<DatabaseState>;
}>;

function expectedBindings(
    manifest: GrobleV2ApprovedLineageManifest
): Binding[] {
    return [
        {
            plan_id: 'basic',
            pricing_version: 'earlybird-2026-07-v1',
            product_id: manifest.legacy.basic.productId,
            payment_address: manifest.legacy.basic.paymentAddress,
            expected_amount_krw: 14_900,
            checkout_active: false,
        },
        {
            plan_id: 'standard',
            pricing_version: 'earlybird-2026-07-v1',
            product_id: manifest.legacy.standard.productId,
            payment_address: manifest.legacy.standard.paymentAddress,
            expected_amount_krw: 19_900,
            checkout_active: false,
        },
        {
            plan_id: 'basic',
            pricing_version: 'earlybird-2026-07-v2',
            product_id: manifest.v2.basic.productId,
            payment_address: manifest.v2.basic.paymentAddress,
            expected_amount_krw: 6_900,
            checkout_active: true,
        },
        {
            plan_id: 'standard',
            pricing_version: 'earlybird-2026-07-v2',
            product_id: manifest.v2.standard.productId,
            payment_address: manifest.v2.standard.paymentAddress,
            expected_amount_krw: 9_900,
            checkout_active: true,
        },
    ];
}

function validateApprovedManifest(
    manifest: GrobleV2ApprovedLineageManifest | undefined,
    config: GrobleProductLineageConfig
): GrobleV2ApprovedLineageManifest {
    if (
        !manifest
        || manifest.schemaVersion !== 1
        || typeof manifest.approvalId !== 'string'
        || manifest.approvalId.trim().length === 0
        || typeof manifest.reviewedAt !== 'string'
        || !Number.isFinite(Date.parse(manifest.reviewedAt))
        || !manifest.legacy?.basic
        || !manifest.legacy?.standard
        || !manifest.v2?.basic
        || !manifest.v2?.standard
    ) {
        throw new Error('GROBLE_V2_APPROVED_MANIFEST_REQUIRED');
    }
    const manifestIdentifiers = [
        manifest.legacy.basic.productId,
        manifest.legacy.standard.productId,
        manifest.legacy.basic.paymentAddress,
        manifest.legacy.standard.paymentAddress,
        manifest.v2.basic.productId,
        manifest.v2.standard.productId,
        manifest.v2.basic.paymentAddress,
        manifest.v2.standard.paymentAddress,
    ];
    const configIdentifiers = [
        config.legacyProductIds.basic,
        config.legacyProductIds.standard,
        config.legacyPaymentAddresses.basic,
        config.legacyPaymentAddresses.standard,
        config.productIds.basic,
        config.productIds.standard,
        config.paymentAddresses.basic,
        config.paymentAddresses.standard,
    ];
    if (
        manifestIdentifiers.some(identifier => (
            typeof identifier !== 'string'
            || !/^[A-Za-z0-9_-]{1,128}$/.test(identifier)
        ))
        || new Set(manifestIdentifiers).size !== 8
        || JSON.stringify(manifestIdentifiers)
            !== JSON.stringify(configIdentifiers)
    ) {
        throw new Error('GROBLE_V2_APPROVED_MANIFEST_MISMATCH');
    }
    return manifest;
}

function canonicalBindings(bindings: readonly Binding[]): string {
    return JSON.stringify(
        [...bindings].sort((left, right) => (
            `${left.pricing_version}:${left.plan_id}`
                .localeCompare(`${right.pricing_version}:${right.plan_id}`)
        ))
    );
}

function validateHistoricalProductEvidence(
    evidence: readonly HistoricalProductEvidence[],
    manifest: GrobleV2ApprovedLineageManifest
): void {
    const plansByProduct = new Map<string, Set<string>>();
    for (const item of evidence) {
        if (item.plan_id === null) continue;
        const plans = plansByProduct.get(item.product_id) ?? new Set<string>();
        plans.add(item.plan_id);
        plansByProduct.set(item.product_id, plans);
    }
    if ([...plansByProduct.values()].some(plans => plans.size > 1)) {
        throw new Error(
            'GROBLE_V2_HISTORICAL_PRODUCT_EVIDENCE_AMBIGUOUS'
        );
    }

    const expectedByPlan = {
        basic: manifest.legacy.basic.productId,
        standard: manifest.legacy.standard.productId,
    };
    const knownLegacyProducts = new Set(Object.values(expectedByPlan));
    if (evidence.some(item => (
        item.plan_id === null
            ? !knownLegacyProducts.has(item.product_id)
            : item.product_id !== expectedByPlan[item.plan_id]
    ))) {
        throw new Error(
            'GROBLE_V2_HISTORICAL_PRODUCT_EVIDENCE_MISMATCH'
        );
    }
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

    const {
        data: historicalOrders,
        error: historicalOrdersError,
        count: historicalOrdersCount,
    } =
        await supabaseAdmin
            .from('earlybird_orders')
            .select(
                'id,plan_id,pricing_version,status,'
                + 'expected_groble_product_id,expected_amount_krw',
                { count: 'exact' }
            )
            .limit(10_000);
    if (
        historicalOrdersError
        || !historicalOrders
        || historicalOrdersCount === null
        || historicalOrders.length !== historicalOrdersCount
    ) {
        throw new Error('GROBLE_V2_HISTORICAL_ORDERS_READ_FAILED');
    }
    const orderRows = historicalOrders as unknown as Array<{
        id: string;
        plan_id: 'basic' | 'standard';
        pricing_version: string;
        status: string;
        expected_groble_product_id: string;
        expected_amount_krw: number;
    }>;
    const orderPlanById = new Map(
        orderRows.map(order => [order.id, order.plan_id])
    );

    const {
        data: webhookEvidence,
        error: webhookEvidenceError,
        count: webhookEvidenceCount,
    } =
        await supabaseAdmin
            .from('earlybird_webhook_events')
            .select(
                'event_id,event_type,payment_id,product_id,amount_krw,order_id',
                { count: 'exact' }
            )
            .limit(10_000);
    if (
        webhookEvidenceError
        || !webhookEvidence
        || webhookEvidenceCount === null
        || webhookEvidence.length !== webhookEvidenceCount
    ) {
        throw new Error('GROBLE_V2_HISTORICAL_WEBHOOKS_READ_FAILED');
    }
    const webhookRows = webhookEvidence as unknown as Array<{
        event_id: string;
        event_type: string;
        payment_id: string;
        product_id: string;
        amount_krw: number;
        order_id: string | null;
    }>;

    const {
        data: retirementEvidence,
        error: retirementEvidenceError,
        count: retirementEvidenceCount,
    } = await supabaseAdmin
        .from('earlybird_checkout_retirements')
        .select('legacy_order_id', { count: 'exact' })
        .limit(10_000);
    if (
        retirementEvidenceError
        || !retirementEvidence
        || retirementEvidenceCount === null
        || retirementEvidence.length !== retirementEvidenceCount
    ) {
        throw new Error('GROBLE_V2_RETIREMENT_EVIDENCE_READ_FAILED');
    }
    const retiredOrderIds = new Set(
        (retirementEvidence as unknown as Array<{
            legacy_order_id: string;
        }>).map(retirement => retirement.legacy_order_id)
    );
    const oldLineageOrders = orderRows.filter(order => (
        (
            order.pricing_version === 'earlybird-2026-07-v1'
            && (
                (order.plan_id === 'basic'
                    && order.expected_amount_krw === 14_900)
                || (order.plan_id === 'standard'
                    && order.expected_amount_krw === 19_900)
            )
        )
        || (
            order.pricing_version === 'earlybird-2026-07-v2'
            && (
                (order.plan_id === 'basic'
                    && order.expected_amount_krw === 6_900)
                || (order.plan_id === 'standard'
                    && order.expected_amount_krw === 9_900)
            )
        )
    ));
    const unassignedCommercialWebhookCandidateCount = webhookRows.filter(
        webhook => (
            webhook.order_id === null
            && webhook.event_type === 'payment.completed'
            && oldLineageOrders.some(order => (
                (
                    order.status === 'payment_pending'
                    || retiredOrderIds.has(order.id)
                )
                && order.expected_groble_product_id === webhook.product_id
                && webhook.amount_krw <= order.expected_amount_krw
            ))
        )
    ).length;

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
        unassignedCommercialWebhookCandidateCount,
        historicalProductEvidence: [
            ...orderRows.map(order => ({
                source: 'order' as const,
                plan_id: order.plan_id,
                product_id: order.expected_groble_product_id,
            })),
            ...webhookRows.map(webhook => ({
                source: 'webhook' as const,
                plan_id: webhook.order_id
                    ? orderPlanById.get(webhook.order_id) ?? null
                    : null,
                product_id: webhook.product_id,
            })),
        ],
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
    const approvedManifest = validateApprovedManifest(
        input.approvedManifest,
        config
    );
    if (input.phase === 'pre-migration') {
        return { phase: input.phase, status: 'passed' };
    }

    const state = await (
        input.loadDatabaseState ?? loadProductionDatabaseState
    )(config);
    if (
        canonicalBindings(state.bindings)
        !== canonicalBindings(expectedBindings(approvedManifest))
    ) {
        throw new Error('GROBLE_V2_DB_BINDINGS_MISMATCH');
    }
    validateHistoricalProductEvidence(
        state.historicalProductEvidence,
        approvedManifest
    );
    if (state.unassignedCommercialWebhookCandidateCount !== 0) {
        throw new Error(
            'GROBLE_V2_UNASSIGNED_COMMERCIAL_WEBHOOK_REMAINS'
        );
    }
    if (state.pendingOldLineageCount !== 0) {
        throw new Error('GROBLE_V2_PENDING_OLD_LINEAGE_REMAINS');
    }
    return { phase: input.phase, status: 'passed' };
}

function parseCliArguments(args: readonly string[]): {
    phase: Phase;
    confirmCheckoutWritesPaused: boolean;
    approvedManifestPath: string;
} {
    const phaseIndex = args.indexOf('--phase');
    const phase = args[phaseIndex + 1];
    if (phase !== 'pre-migration' && phase !== 'pre-deploy') {
        throw new Error('GROBLE_V2_GATE_PHASE_INVALID');
    }
    const approvedManifestIndex = args.indexOf('--approved-manifest');
    const approvedManifestPath = args[approvedManifestIndex + 1];
    if (
        approvedManifestIndex < 0
        || !approvedManifestPath
        || approvedManifestPath.startsWith('--')
    ) {
        throw new Error('GROBLE_V2_APPROVED_MANIFEST_REQUIRED');
    }
    return {
        phase,
        approvedManifestPath,
        confirmCheckoutWritesPaused:
            args.includes('--confirm-checkout-writes-paused'),
    };
}

async function main(): Promise<void> {
    const cli = parseCliArguments(process.argv.slice(2));
    const approvedManifest = JSON.parse(
        await readFile(cli.approvedManifestPath, 'utf8')
    ) as GrobleV2ApprovedLineageManifest;
    const result = await runGrobleV2ReleaseGate({
        phase: cli.phase,
        confirmCheckoutWritesPaused: cli.confirmCheckoutWritesPaused,
        approvedManifest,
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
