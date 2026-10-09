import { z } from 'zod';
import { planQuoteV1Schema, type PlanQuoteV1, type PreflightStatusV1 } from '@/lib/contracts/analysis-v2';
import { ANALYSIS_PLAN_CATALOG, PLAN_IDS, PLAN_PRICING_VERSION, buildPlanSelectionCards } from '@/lib/domain/analysis/plan-catalog';

export const DEV_UI_FIXTURE_VERSION = 'dev-ui-synthetic-v1' as const;
export const DEV_UI_DURATION_SECONDS = 45;
export const DEV_UI_UNPAID_TTL_MS = 30 * 60_000;
export const DEV_UI_RUN_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEV_UI_RELATIONSHIP_COUNTS = Object.freeze({ followers: 320, following: 300 });
export const DEV_UI_FIXTURE_SCENARIOS = ['complete', 'partial', 'failed', 'empty'] as const;

export type DevFixtureScenario = typeof DEV_UI_FIXTURE_SCENARIOS[number];
export type DevPlanId = 'basic' | 'standard';
export type DevCheckoutOutcome = 'success' | 'cancel' | 'failure';
export type DevCheckoutCompletion =
    | { status: 'success'; orderId: string; runId: string; replayed: boolean }
    | { status: 'cancel' | 'failure'; orderId: string; runId: null; replayed: boolean };

export const DEV_UI_ERROR_CODES = [
    'DEV_UI_ACCESS_DENIED', 'DEV_UI_INVALID_INPUT', 'DEV_UI_INVALID_ROW', 'DEV_UI_STORE_UNAVAILABLE',
    'DEV_UI_NOT_FOUND', 'DEV_UI_IDEMPOTENCY_CONFLICT', 'DEV_UI_PLAN_CONFLICT', 'DEV_UI_COMPLETION_CONFLICT',
    'DEV_UI_EXPIRED', 'DEV_UI_RUN_EXPIRED', 'DEV_UI_SNAPSHOT_MISMATCH', 'DEV_UI_RESULT_NOT_READY', 'DEV_UI_RUN_FAILED',
] as const;
export type DevUiErrorCode = typeof DEV_UI_ERROR_CODES[number];

/** Only a fixed code leaves this boundary, never the DB message or row. */
export class DevUiStoreError extends Error {
    constructor(readonly code: DevUiErrorCode) {
        super(code);
        this.name = 'DevUiStoreError';
    }
}

export function buildDevUiPlanSnapshot(): Record<'basic' | 'standard' | 'plus', PlanQuoteV1> {
    const catalog = { ...ANALYSIS_PLAN_CATALOG, plus: { ...ANALYSIS_PLAN_CATALOG.plus, launchStatus: 'disabled' as const } };
    return Object.fromEntries(buildPlanSelectionCards(DEV_UI_RELATIONSHIP_COUNTS, { catalog }).map(card => [card.planId, {
        ...card,
        relationshipCapacity: catalog[card.planId].relationshipCapacity,
        detailedMutualLimit: catalog[card.planId].detailedMutualLimit,
        pricingVersion: PLAN_PRICING_VERSION,
        price: catalog[card.planId].price,
        remainingSlots: null,
    }])) as Record<'basic' | 'standard' | 'plus', PlanQuoteV1>;
}

const expectedPlans = buildDevUiPlanSnapshot();
function sameQuote(actual: PlanQuoteV1, expected: PlanQuoteV1): boolean {
    // Parsing canonicalizes key order, including JSONB's reordered price keys.
    return JSON.stringify(actual) === JSON.stringify(planQuoteV1Schema.parse(expected));
}

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const timestamp = z.string().datetime({ offset: true });
export const devUiTargetSchema = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._]+$/).transform(value => value.toLowerCase());
const scenario = z.enum(DEV_UI_FIXTURE_SCENARIOS);
const plan = z.enum(['basic', 'standard']);
const selectedPlanSnapshot = planQuoteV1Schema.refine(quote => (
    (quote.planId === 'basic' || quote.planId === 'standard') && sameQuote(quote, expectedPlans[quote.planId])
));
const allPlanSnapshots = z.object({ basic: planQuoteV1Schema, standard: planQuoteV1Schema, plus: planQuoteV1Schema }).strict()
    .refine(snapshot => PLAN_IDS.every(id => sameQuote(snapshot[id], expectedPlans[id])));
const fixtureFields = {
    fixture_version: z.literal(DEV_UI_FIXTURE_VERSION),
    fixture_scenario: scenario,
    duration_seconds: z.literal(DEV_UI_DURATION_SECONDS),
};
const identityFields = { id: uuid, user_id: uuid, target_instagram_id: devUiTargetSchema, created_at: timestamp, expires_at: timestamp };

// DB records stay server-side. The projection module constructs DTOs explicitly
// and never spreads these records into a response.
export const devUiPreflightRowSchema = z.object({
    ...identityFields, ...fixtureFields,
    idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    pricing_version: z.literal(PLAN_PRICING_VERSION), plan_snapshot: allPlanSnapshots,
    consumed_at: timestamp.nullable(),
    request_id: uuid.nullable().optional(),
}).refine(row => Date.parse(row.expires_at) > Date.parse(row.created_at));
export const devUiOrderRowSchema = z.object({
    ...identityFields, ...fixtureFields,
    preflight_id: uuid, plan_id: plan,
    pricing_version: z.literal(PLAN_PRICING_VERSION), plan_snapshot: selectedPlanSnapshot,
    disclosure_accepted_at: timestamp,
    status: z.enum(['pending', 'success', 'cancel', 'failure']),
    completed_at: timestamp.nullable(), run_id: uuid.nullable(),
}).refine(row => row.plan_id === row.plan_snapshot.planId
    && Date.parse(row.expires_at) >= Date.parse(row.created_at)
    && (row.status === 'pending'
        ? row.completed_at === null && row.run_id === null
        : row.completed_at !== null && Date.parse(row.completed_at) >= Date.parse(row.created_at)
            && (row.status === 'success' ? row.run_id !== null : row.run_id === null)));
export const devUiRunRowSchema = z.object({
    ...identityFields, ...fixtureFields,
    order_id: uuid, preflight_id: uuid, plan_id: plan,
    pricing_version: z.literal(PLAN_PRICING_VERSION), plan_snapshot: selectedPlanSnapshot,
    started_at: timestamp,
}).refine(row => row.plan_id === row.plan_snapshot.planId
    && Date.parse(row.started_at) === Date.parse(row.created_at)
    && Date.parse(row.expires_at) - Date.parse(row.started_at) === DEV_UI_RUN_RETENTION_MS);

export type DevUiPreflightRow = z.infer<typeof devUiPreflightRowSchema>;
export type DevUiOrderRow = z.infer<typeof devUiOrderRowSchema>;
export type DevUiRunRow = z.infer<typeof devUiRunRowSchema>;

export const devUiCreatePreflightInputSchema = z.object({
    userId: uuid, targetInstagramId: devUiTargetSchema, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    fixtureScenario: scenario.default('complete'),
}).strict();
export const devUiCreateCheckoutInputSchema = z.object({
    userId: uuid, preflightId: uuid, planId: plan, disclosureAccepted: z.literal(true),
}).strict();
export const devUiCompleteCheckoutInputSchema = z.object({ userId: uuid, orderId: uuid, outcome: z.enum(['success', 'cancel', 'failure']) }).strict();
export const devUiReadPreflightInputSchema = z.object({ userId: uuid, preflightId: uuid }).strict();
export const devUiReadCheckoutInputSchema = z.object({ userId: uuid, orderId: uuid }).strict();
export const devUiReadRunInputSchema = z.object({ userId: uuid, runId: uuid }).strict();
export const devUiListOwnerInputSchema = z.object({ userId: uuid, limit: z.number().int().min(1).max(100).default(100) }).strict();
export const devUiListAdminInputSchema = z.object({ adminUserId: uuid, limit: z.number().int().min(1).max(100).default(100) }).strict();
export const devUiReadAdminInputSchema = z.object({ adminUserId: uuid, orderId: uuid }).strict();

export interface DevUiPreflight {
    preflightId: string;
    targetInstagramId: string;
    fixtureVersion: typeof DEV_UI_FIXTURE_VERSION;
    fixtureScenario: DevFixtureScenario;
    createdAt: string;
    expiresAt: string;
    status: 'ready' | 'expired' | 'consumed';
    runId: string | null;
    snapshot: PreflightStatusV1 | null;
    simulation: true;
}

export interface DevUiRun {
    runId: string;
    orderId: string;
    preflightId: string;
    targetInstagramId: string;
    planId: DevPlanId;
    pricingVersion: string;
    planSnapshot: PlanQuoteV1;
    fixtureVersion: typeof DEV_UI_FIXTURE_VERSION;
    fixtureScenario: DevFixtureScenario;
    durationSeconds: number;
    createdAt: string;
    startedAt: string;
    expiresAt: string;
    simulation: true;
}

export interface DevUiOrder {
    orderId: string;
    preflightId: string;
    targetInstagramId: string;
    planId: DevPlanId;
    pricingVersion: string;
    price: PlanQuoteV1['price'];
    fixtureVersion: typeof DEV_UI_FIXTURE_VERSION;
    fixtureScenario: DevFixtureScenario;
    status: 'pending' | 'expired' | DevCheckoutOutcome;
    createdAt: string;
    expiresAt: string;
    completedAt: string | null;
    run: DevUiRun | null;
    runStatus: 'processing' | 'completed' | 'failed' | 'expired' | null;
    nextUrl: string;
    simulation: true;
}

export interface DevUiStore {
    createOrReplayPreflight(input: { userId: string; targetInstagramId: string; idempotencyKey: string; fixtureScenario?: DevFixtureScenario }):
        Promise<{ preflightId: string; expiresAt: string; created: boolean }>;
    createOrReplayCheckout(input: { userId: string; preflightId: string; planId: DevPlanId; disclosureAccepted: true }):
        Promise<{ orderId: string; nextUrl: string; expiresAt: string }>;
    completeCheckout(input: { userId: string; orderId: string; outcome: DevCheckoutOutcome }): Promise<DevCheckoutCompletion>;
    readPreflight(input: { userId: string; preflightId: string }): Promise<DevUiPreflight | null>;
    readCheckout(input: { userId: string; orderId: string }): Promise<DevUiOrder | null>;
    readRun(input: { userId: string; runId: string }): Promise<DevUiRun | null>;
    listOwnerOrders(input: { userId: string; limit?: number }): Promise<DevUiOrder[]>;
    listAdminOrders(input: { adminUserId: string; limit?: number }): Promise<DevUiOrder[]>;
    readAdminOrder(input: { adminUserId: string; orderId: string }): Promise<DevUiOrder | null>;
}
