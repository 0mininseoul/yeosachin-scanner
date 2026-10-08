import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    analysisResultPageV1Schema, preflightStatusV1Schema, progressReadV1Schema,
} from '@/lib/contracts/analysis-v2';
import { ANALYSIS_PLAN_CATALOG, PLAN_PRICING_VERSION, buildPlanSelectionCards } from '@/lib/domain/analysis/plan-catalog';
import * as storeModule from '@/lib/services/dev-ui/store';
import * as projectionModule from '@/lib/services/dev-ui/projection';

const spy = vi.hoisted(() => ({ deployment: vi.fn(), rpc: vi.fn(), client: vi.fn(), supabaseClient: vi.fn() }));
vi.mock('@/lib/services/dev-ui/deployment', () => ({ assertDevUiDeployment: spy.deployment }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: spy.rpc } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: spy.supabaseClient }));

const owner = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';
const preflightId = '123e4567-e89b-42d3-a456-426614174002';
const orderId = '123e4567-e89b-42d3-a456-426614174003';
const runId = '123e4567-e89b-42d3-a456-426614174004';
const createdAt = '2026-10-09T00:00:00.000Z';
const expiresAt = '2026-10-09T00:30:00.000Z';

function snapshots() {
    const catalog = { ...ANALYSIS_PLAN_CATALOG, plus: { ...ANALYSIS_PLAN_CATALOG.plus, launchStatus: 'disabled' as const } };
    return Object.fromEntries(buildPlanSelectionCards({ followers: 320, following: 300 }, { catalog }).map(card => [card.planId, {
        ...card, relationshipCapacity: catalog[card.planId].relationshipCapacity, detailedMutualLimit: catalog[card.planId].detailedMutualLimit,
        pricingVersion: PLAN_PRICING_VERSION, price: catalog[card.planId].price, remainingSlots: null,
    }]));
}

function preflightRow() {
    return { id: preflightId, user_id: owner, target_instagram_id: 'dev_synthetic', idempotency_key: 'synthetic-preflight-key-000',
        fixture_version: 'dev-ui-synthetic-v1', fixture_scenario: 'complete', duration_seconds: 45,
        pricing_version: PLAN_PRICING_VERSION, plan_snapshot: snapshots(), created_at: createdAt, expires_at: expiresAt, consumed_at: null };
}

function orderRow(status: 'pending' | 'success' | 'cancel' | 'failure' = 'pending') {
    return { id: orderId, user_id: owner, preflight_id: preflightId, target_instagram_id: 'dev_synthetic', plan_id: 'basic',
        pricing_version: PLAN_PRICING_VERSION, plan_snapshot: snapshots().basic,
        fixture_version: 'dev-ui-synthetic-v1', fixture_scenario: 'complete', duration_seconds: 45,
        disclosure_accepted_at: createdAt, created_at: createdAt, expires_at: expiresAt, status,
        completed_at: status === 'pending' ? null : createdAt, run_id: status === 'success' ? runId : null };
}

function runRow(scenario: 'complete' | 'partial' | 'failed' | 'empty' = 'complete') {
    return { id: runId, user_id: owner, order_id: orderId, preflight_id: preflightId, target_instagram_id: 'dev_synthetic', plan_id: 'basic',
        pricing_version: PLAN_PRICING_VERSION, plan_snapshot: snapshots().basic, fixture_version: 'dev-ui-synthetic-v1',
        fixture_scenario: scenario, duration_seconds: 45, created_at: createdAt, started_at: createdAt, expires_at: '2026-10-16T00:00:00.000Z' };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DEV_UI_TEST_USER_IDS', owner);
    vi.stubEnv('DEV_UI_ADMIN_USER_IDS', owner);
    spy.deployment.mockReturnValue({ vercelProjectId: 'prj_dev_ui_test', supabaseProjectRef: 'devuitestproject' });
    spy.client.mockReturnValue({ rpc: spy.rpc });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external fetch'); }));
    vi.setSystemTime(new Date(createdAt));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(spy.supabaseClient).not.toHaveBeenCalled();
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function store() {
    return storeModule.createDevUiStore({ getClient: spy.client });
}

describe('Dev UI server store boundary', () => {
    it('guards deployment and the private tester allowlist before every client access', async () => {
        const subject = store();
        spy.deployment.mockImplementation(() => { throw new Error('DEV_UI_DEPLOYMENT_REJECTED'); });
        await expect(subject.createOrReplayPreflight({ userId: owner, targetInstagramId: 'dev_synthetic', idempotencyKey: 'synthetic-preflight-key-000' }))
            .rejects.toThrow('DEV_UI_DEPLOYMENT_REJECTED');
        expect(spy.client).not.toHaveBeenCalled();
        spy.deployment.mockReturnValue({});
        await expect(subject.readRun({ userId: other, runId })).rejects.toThrow('DEV_UI_ACCESS_DENIED');
        expect(spy.client).not.toHaveBeenCalled();
        vi.stubEnv('DEV_UI_TEST_USER_IDS', `${owner},malformed-private-value`);
        await expect(subject.readRun({ userId: owner, runId })).rejects.toThrow('DEV_UI_ACCESS_DENIED');
        expect(spy.client).not.toHaveBeenCalled();
    });

    it('repeats guards on an already-created store and normalizes a target without enabling production demo mode', async () => {
        const subject = store();
        spy.rpc.mockResolvedValue({ data: { preflight: preflightRow(), created: true }, error: null });
        const result = await subject.createOrReplayPreflight({ userId: owner, targetInstagramId: 'DEV_SYNTHETIC', idempotencyKey: 'synthetic-preflight-key-000' });
        expect(result).toEqual({ preflightId, expiresAt, created: true });
        expect(spy.rpc).toHaveBeenLastCalledWith('dev_ui_create_preflight', { p_user_id: owner, p_target_instagram_id: 'dev_synthetic', p_idempotency_key: 'synthetic-preflight-key-000', p_fixture_scenario: 'complete' });
        spy.deployment.mockImplementation(() => { throw new Error('DEV_UI_DEPLOYMENT_REJECTED'); });
        await expect(subject.readPreflight({ userId: owner, preflightId })).rejects.toThrow('DEV_UI_DEPLOYMENT_REJECTED');
        expect(spy.client).toHaveBeenCalledTimes(1);
    });

    it('denies invalid input and rejects any returned foreign owner or conflicting payload', async () => {
        const subject = store();
        await expect(subject.createOrReplayCheckout({ userId: owner, preflightId, planId: 'plus', disclosureAccepted: true } as never)).rejects.toThrow('DEV_UI_INVALID_INPUT');
        expect(spy.rpc).not.toHaveBeenCalled();
        spy.rpc.mockResolvedValue({ data: { preflight: { ...preflightRow(), user_id: other }, created: true }, error: null });
        await expect(subject.createOrReplayPreflight({ userId: owner, targetInstagramId: 'dev_synthetic', idempotencyKey: 'synthetic-preflight-key-000' })).rejects.toThrow('DEV_UI_INVALID_ROW');
        spy.rpc.mockResolvedValue({ data: { preflight: { ...preflightRow(), fixture_scenario: 'empty' }, created: false }, error: null });
        await expect(subject.createOrReplayPreflight({ userId: owner, targetInstagramId: 'dev_synthetic', idempotencyKey: 'synthetic-preflight-key-000' })).rejects.toThrow('DEV_UI_INVALID_ROW');
    });

    it.each([
        { duration_seconds: 0 }, { fixture_version: 'operator-editable-fixture-v2' }, { started_at: null },
        { expires_at: 'malformed' }, { plan_id: 'standard' }, { user_id: other },
    ])('fails closed on a malformed run row (%j)', async mutation => {
        spy.rpc.mockResolvedValue({ data: { ...runRow(), ...mutation }, error: null });
        await expect(store().readRun({ userId: owner, runId })).rejects.toThrow('DEV_UI_INVALID_ROW');
    });

    it('returns the internal checkout path and completes only a matching linked run', async () => {
        const subject = store();
        spy.rpc.mockResolvedValue({ data: { order: orderRow(), replayed: false }, error: null });
        expect(await subject.createOrReplayCheckout({ userId: owner, preflightId, planId: 'basic', disclosureAccepted: true }))
            .toEqual({ orderId, nextUrl: `/dev-ui/checkout/${orderId}`, expiresAt });
        spy.rpc.mockResolvedValue({ data: { order: orderRow('success'), run: runRow(), replayed: true }, error: null });
        expect(await subject.completeCheckout({ userId: owner, orderId, outcome: 'success' })).toEqual({ orderId, runId, status: 'success', replayed: true });
        spy.rpc.mockResolvedValue({ data: { order: orderRow('success'), run: { ...runRow(), order_id: preflightId }, replayed: true }, error: null });
        await expect(subject.completeCheckout({ userId: owner, orderId, outcome: 'success' })).rejects.toThrow('DEV_UI_INVALID_ROW');
    });

    it('never forwards unknown RPC errors or raw private values', async () => {
        const subject = store();
        spy.rpc.mockResolvedValue({ data: null, error: { message: 'sensitive database row and private identifier' } });
        await expect(subject.readRun({ userId: owner, runId })).rejects.toThrow(/^DEV_UI_STORE_UNAVAILABLE$/);
        spy.rpc.mockResolvedValue({ data: null, error: { message: 'DEV_UI_EXPIRED' } });
        await expect(subject.completeCheckout({ userId: owner, orderId, outcome: 'success' })).rejects.toThrow(/^DEV_UI_EXPIRED$/);
    });

    it('exposes owner and administrator read DTOs with no user ID or idempotency key', async () => {
        const subject = store();
        const envelope = { order: orderRow('success'), run: runRow() };
        spy.rpc.mockResolvedValue({ data: envelope, error: null });
        const checkout = await subject.readCheckout({ userId: owner, orderId });
        expect(JSON.stringify(checkout)).not.toContain(owner);
        expect(JSON.stringify(checkout)).not.toContain('idempotency');
        expect(checkout).toMatchObject({ orderId, status: 'success', simulation: true, run: { runId, fixtureScenario: 'complete' } });
        spy.rpc.mockResolvedValue({ data: [envelope], error: null });
        expect(await subject.listOwnerOrders({ userId: owner })).toHaveLength(1);
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', other);
        await expect(subject.listAdminOrders({ adminUserId: owner })).rejects.toThrow('DEV_UI_ACCESS_DENIED');
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', owner);
        expect(await subject.listAdminOrders({ adminUserId: owner })).toHaveLength(1);
    });
});

describe('Dev UI deterministic presentation', () => {
    it('projects the existing ready contract with two eligible paid plans and no direct-result demo marker', async () => {
        spy.rpc.mockResolvedValue({ data: preflightRow(), error: null });
        const prepared = await store().readPreflight({ userId: owner, preflightId });
        expect(prepared?.snapshot?.status).toBe('ready');
        expect(preflightStatusV1Schema.safeParse(prepared?.snapshot).success).toBe(true);
        expect(prepared?.snapshot).not.toHaveProperty('demo');
        expect(JSON.stringify(prepared)).not.toContain(owner);
        vi.setSystemTime(new Date(expiresAt));
        const expired = await store().readPreflight({ userId: owner, preflightId });
        expect(expired?.status).toBe('expired');
        expect(expired?.snapshot).toBeNull();
    });

    it.each(['complete', 'partial', 'empty'] as const)('projects %s with safe local assets and the existing progress/result schemas', async scenario => {
        spy.rpc.mockResolvedValue({ data: runRow(scenario), error: null });
        const run = (await store().readRun({ userId: owner, runId }))!;
        const middle = projectionModule.projectDevUiProgress(run, { now: new Date('2026-10-09T00:00:10.000Z') });
        expect(progressReadV1Schema.safeParse(middle).success).toBe(true);
        expect(middle.snapshot.status).toBe('processing');
        expect(() => projectionModule.projectDevUiResult(run, { now: new Date(createdAt), femaleCursor: null, privateCursor: null, pageSize: 24 })).toThrow('DEV_UI_RESULT_NOT_READY');
        const completedAt = new Date('2026-10-09T00:00:45.000Z');
        const completed = projectionModule.projectDevUiProgress(run, { now: completedAt });
        expect(progressReadV1Schema.safeParse(completed).success).toBe(true);
        expect(completed.snapshot.status).toBe('completed');
        const page = projectionModule.projectDevUiResult(run, { now: completedAt, femaleCursor: null, privateCursor: null, pageSize: 24 });
        expect(analysisResultPageV1Schema.safeParse(page).success).toBe(true);
        expect(JSON.stringify(page)).not.toMatch(/https?:\/\/|www\./u);
        expect(page.summary.followers.exactCountMatch).toBe(scenario !== 'partial');
        if (scenario === 'empty') expect(page.femaleAccounts).toHaveLength(0);
        if (scenario === 'complete') {
            expect(page.femaleNextCursor).not.toBeNull();
            const next = projectionModule.projectDevUiResult(run, { now: completedAt, femaleCursor: page.femaleNextCursor, privateCursor: null, pageSize: 24 });
            expect(new Set([...page.femaleAccounts, ...next.femaleAccounts].map(account => account.instagramId)).size).toBe(48);
        }
    });

    it('keeps a failed run terminal and never returns a final result or completion event', async () => {
        spy.rpc.mockResolvedValue({ data: runRow('failed'), error: null });
        const run = (await store().readRun({ userId: owner, runId }))!;
        const first = projectionModule.projectDevUiProgress(run, { now: new Date('2026-10-09T00:01:00.000Z') });
        const later = projectionModule.projectDevUiProgress(run, { now: new Date('2026-10-09T01:00:00.000Z') });
        expect(first).toEqual(later);
        expect(progressReadV1Schema.safeParse(first).success).toBe(true);
        expect(first.snapshot.status).toBe('failed');
        expect(first.events.some(event => event.eventCode === 'ANALYSIS_COMPLETED')).toBe(false);
        expect(() => projectionModule.projectDevUiResult(run, { now: new Date('2026-10-09T00:01:00.000Z'), femaleCursor: null, privateCursor: null, pageSize: 24 })).toThrow('DEV_UI_RUN_FAILED');
    });
});
