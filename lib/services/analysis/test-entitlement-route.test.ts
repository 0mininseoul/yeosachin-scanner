import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    AnalysisV2TaskEnqueueError: class extends Error {
        constructor(readonly disposition: 'terminal' | 'replayable') {
            super('ANALYSIS_V2_TASKS_ENQUEUE_ERROR: task creation failed.');
            this.name = 'AnalysisV2TaskEnqueueError';
        }
    },
    createServerClient: vi.fn(),
    dispatchAdmission: vi.fn(),
    dispatchJob: vi.fn(),
    from: vi.fn(),
    getPreflightTasksConfig: vi.fn(),
    getTasksConfig: vi.fn(),
    operationalEmit: vi.fn(),
    observeRoute: vi.fn(),
    rpc: vi.fn(),
    requireActiveE2eTestAccount: vi.fn(),
    requireActiveE2eTestRunner: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/services/analysis/v2-tasks', () => ({
    AnalysisV2TaskEnqueueError: mocks.AnalysisV2TaskEnqueueError,
    dispatchAnalysisV2Job: mocks.dispatchJob,
    enqueueAnalysisV2FreshAdmissionTask: mocks.dispatchAdmission,
    getAnalysisV2TasksConfig: mocks.getTasksConfig,
}));
vi.mock('@/lib/services/analysis/preflight-tasks', () => ({
    getPreflightTasksConfig: mocks.getPreflightTasksConfig,
}));
vi.mock('@/lib/observability/request', () => ({
    observeRoute: mocks.observeRoute,
}));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.operationalEmit },
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveE2eTestAccount: mocks.requireActiveE2eTestAccount,
    requireActiveE2eTestRunner: mocks.requireActiveE2eTestRunner,
}));

import { POST } from '@/app/api/analysis/preflight/[preflightId]/entitle/route';
import { ANALYSIS_V2_BOOTSTRAP_JOB_KEY } from './v2-coordinator';
import { createAnalysisTestEntitlement } from './test-entitlement';
import { hashAnalysisTestEntitlementJti } from './test-entitlement-consumption';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-b456-426614174001';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174002';
const ADMISSION_TOKEN = '123e4567-e89b-42d3-a456-426614174003';
const DISPATCH_TOKEN = '123e4567-e89b-42d3-a456-426614174004';
const DISPATCH_GENERATION = 3;
const ENTITLEMENT_SECRET = Buffer.alloc(32, 11).toString('base64url');
const PREFLIGHT_IDENTITY_SECRET = Buffer.alloc(32, 12).toString('base64url');
const AUTHORIZED_TEST_ENV_KEYS = [
    'ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED',
    'ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET',
    'ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID',
    'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT',
    'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT',
    'ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT',
    'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT',
    'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT',
    'ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT',
] as const;

const taskConfig = { queue: 'analysis-v2' };
const preflightTaskConfig = { queue: 'analysis-preflight' };
const pricing = {
    basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
    standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
    plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
} as const;

function planCards(required: 'basic' | 'standard' | 'plus' = 'standard') {
    const order = ['basic', 'standard', 'plus'] as const;
    const capacity = {
        basic: { followers: 400, following: 400 },
        standard: { followers: 800, following: 800 },
        plus: { followers: 1_200, following: 1_200 },
    };
    const limits = { basic: 300, standard: 600, plus: 900 };
    return Object.fromEntries(order.map((planId, index) => {
        const requiredIndex = order.indexOf(required);
        return [planId, {
            launchStatus: 'test_only',
            relationshipCapacity: capacity[planId],
            detailedMutualLimit: limits[planId],
            selectionState: index < requiredIndex
                ? 'unavailable'
                : index === requiredIndex ? 'required' : 'available_upgrade',
            unavailableReason: index < requiredIndex ? 'below_required_plan' : null,
        }];
    }));
}

function preflightRow(overrides: Record<string, unknown> = {}) {
    return {
        id: PREFLIGHT_ID,
        user_id: USER_ID,
        status: 'ready',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        target_instagram_id: 'target.account',
        target_followers_count: 600,
        target_following_count: 700,
        access_mode: 'test_entitlement',
        capacity_required_plan_id: 'standard',
        required_plan_id: 'standard',
        launch_status_snapshot: {
            basic: 'test_only',
            standard: 'test_only',
            plus: 'test_only',
        },
        plan_cards_snapshot: planCards(),
        exclusion_decision: 'skip',
        excluded_instagram_id: null,
        pricing_version: 'deferred',
        pricing_snapshot: pricing,
        consumed_request_id: null,
        ...overrides,
    };
}

function admissionRow(overrides: Record<string, unknown> = {}) {
    return {
        admission_status: 'ready',
        should_enqueue: false,
        admission_generation: 2,
        dispatch_generation: DISPATCH_GENERATION,
        dispatch_token: null,
        selected_plan_id: 'standard',
        selected_plan_allowed: true,
        admission_token: ADMISSION_TOKEN,
        admission_refreshed_at: new Date().toISOString(),
        target_followers_count: 620,
        target_following_count: 710,
        capacity_required_plan_id: 'standard',
        required_plan_id: 'standard',
        plan_cards_snapshot: planCards(),
        pricing_version: 'deferred',
        pricing_snapshot: pricing,
        admission_error_code: null,
        ...overrides,
    };
}

function consumedResult(overrides: Record<string, unknown> = {}) {
    return [{
        request_id: REQUEST_ID,
        created: true,
        initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
        request_status: 'pending',
        background_processing: false,
        ...overrides,
    }];
}

function installPreflightQuery(data: unknown = preflightRow()) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    mocks.from.mockReturnValue(query);
    return query;
}

function entitlementToken(planId: 'basic' | 'standard' | 'plus' = 'standard') {
    return createAnalysisTestEntitlement({
        preflightId: PREFLIGHT_ID,
        userId: USER_ID,
        planId,
        nonce: 'route_entitlement_nonce_01',
    }, { secret: ENTITLEMENT_SECRET });
}

function request(options: {
    body?: unknown;
    token?: string | null;
} = {}) {
    const token = options.token === undefined ? entitlementToken() : options.token;
    const headers = new Headers({ 'content-type': 'application/json' });
    if (token !== null) headers.set('x-analysis-test-entitlement', token);
    return new Request(
        `https://example.com/api/analysis/preflight/${PREFLIGHT_ID}/entitle`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify(options.body ?? { planId: 'standard' }),
        }
    );
}

function context(preflightId = PREFLIGHT_ID) {
    return { params: Promise.resolve({ preflightId }) };
}

describe('analysis V2 durable test-entitlement route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ANALYSIS_TEST_ENTITLEMENT_SECRET = ENTITLEMENT_SECRET;
        process.env.ANALYSIS_TEST_ENTITLEMENTS_ENABLED = 'true';
        process.env.ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET = PREFLIGHT_IDENTITY_SECRET;
        mocks.dispatchAdmission.mockResolvedValue('enqueued');
        mocks.dispatchJob.mockResolvedValue('enqueued');
        mocks.observeRoute.mockImplementation(async (
            _request: Request,
            _route: string,
            operation: (context: {
                request_id: string;
                trace_id: null;
                route: string;
                method: string;
            }) => Promise<Response>,
        ) => operation({
            request_id: '123e4567-e89b-42d3-a456-426614174099',
            trace_id: null,
            route: '/api/analysis/preflight/[preflightId]/entitle',
            method: 'POST',
        }));
        mocks.getPreflightTasksConfig.mockReturnValue(preflightTaskConfig);
        mocks.getTasksConfig.mockReturnValue(taskConfig);
        mocks.createServerClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: {
                        user: {
                            id: USER_ID,
                            app_metadata: {
                                provider: 'google',
                                analysis_test_runner_v1: 'standard',
                            },
                        },
                    },
                    error: null,
                }),
            },
        });
        mocks.requireActiveE2eTestAccount.mockResolvedValue({
            userId: USER_ID,
            accountClass: 'e2e_test',
            trafficClass: 'e2e_test',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
        mocks.requireActiveE2eTestRunner.mockResolvedValue({
            userId: USER_ID,
            accountClass: 'e2e_test',
            trafficClass: 'e2e_test',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
            runnerPlan: 'standard',
        });
        installPreflightQuery();
        let strictSettlementPrepareCalls = 0;
        mocks.rpc.mockImplementation(async (
            name: string,
            params: Record<string, unknown>
        ) => {
            if (name === 'reserve_analysis_v2_preflight_admission_dispatch_v2') {
                return {
                    data: [admissionRow({
                        selected_plan_id: params.p_selected_plan_id,
                        admission_token: params.p_admission_token,
                    })],
                    error: null,
                };
            }
            if (name === 'consume_analysis_v2_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                strictSettlementPrepareCalls += 1;
                return {
                    data: strictSettlementPrepareCalls === 1
                        ? { disposition: 'not_applicable' }
                        : { disposition: 'ready', admissionToken: ADMISSION_TOKEN },
                    error: null,
                };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                return {
                    data: { disposition: 'begun', created: true, replayed: false },
                    error: null,
                };
            }
            if (name === 'activate_analysis_revenue_dispatch_guard_v1') {
                return {
                    data: { disposition: 'active', created: true, replayed: false },
                    error: null,
                };
            }
            if (name === 'quarantine_analysis_revenue_dispatch_v1') {
                return {
                    data: { disposition: 'quarantined', created: true, replayed: false },
                    error: null,
                };
            }
            if (name === 'mark_analysis_v2_preflight_admission_dispatched_v2') {
                return { data: true, error: null };
            }
            if (name === 'release_analysis_v2_preflight_admission_dispatch') {
                return { data: true, error: null };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });
    });

    afterEach(() => {
        delete process.env.ANALYSIS_TEST_ENTITLEMENT_SECRET;
        delete process.env.ANALYSIS_TEST_ENTITLEMENTS_ENABLED;
        delete process.env.ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET;
        delete process.env.ANALYSIS_V2_ADMISSION_ENABLED;
        for (const key of AUTHORIZED_TEST_ENV_KEYS) delete process.env[key];
        vi.restoreAllMocks();
    });

    it('reserves and enqueues count refresh, returning bounded 202 without consumption', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: [{
                ...admissionRow(),
                admission_status: 'pending',
                should_enqueue: true,
                dispatch_token: DISPATCH_TOKEN,
                selected_plan_allowed: null,
                admission_token: null,
                admission_refreshed_at: null,
                target_followers_count: null,
                target_following_count: null,
                capacity_required_plan_id: null,
                required_plan_id: null,
                plan_cards_snapshot: null,
            }],
            error: null,
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(202);
        expect(response.headers.get('retry-after')).toBe('1');
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ID,
            status: 'admission_pending',
            backgroundProcessing: true,
            retryAfterMs: 1_000,
        });
        expect(mocks.dispatchAdmission).toHaveBeenCalledWith(
            {
                preflightId: PREFLIGHT_ID,
                generation: 2,
                dispatchGeneration: DISPATCH_GENERATION,
                dispatchToken: DISPATCH_TOKEN,
                workloadRole: 'paid',
            },
            { config: taskConfig }
        );
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'mark_analysis_v2_preflight_admission_dispatched_v2',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
        expect(mocks.operationalEmit).toHaveBeenCalledWith({
            event: 'analysis_v2.fresh_admission_enqueued',
            severity: 'info',
            fields: expect.objectContaining({
                request_id: '123e4567-e89b-42d3-a456-426614174099',
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                plan_id: 'standard',
                operation: 'fresh_admission',
                disposition: 'enqueued',
            }),
        });
        const freshAdmissionEvent = mocks.operationalEmit.mock.calls[0]?.[0];
        expect(freshAdmissionEvent?.fields).not.toHaveProperty('target_instagram_id');
        expect(JSON.stringify(freshAdmissionEvent)).not.toContain('target.account');
    });

    it('rejects a non-E2E or retired identity before it reads or consumes an entitlement', async () => {
        mocks.requireActiveE2eTestRunner.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await POST(request(), context());

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
            error: '이 계정은 현재 사용할 수 없습니다.',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
        expect(mocks.requireActiveE2eTestRunner).toHaveBeenCalledWith(
            expect.objectContaining({ id: USER_ID }),
            'standard',
        );
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('rejects a Basic runner attempting to consume a signed Standard entitlement before any read', async () => {
        mocks.requireActiveE2eTestRunner.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );
        mocks.createServerClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: {
                        user: {
                            id: USER_ID,
                            app_metadata: {
                                provider: 'google',
                                analysis_test_runner_v1: 'basic',
                            },
                        },
                    },
                    error: null,
                }),
            },
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
            error: '이 계정은 현재 사용할 수 없습니다.',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
        expect(mocks.requireActiveE2eTestRunner).toHaveBeenCalledWith(
            expect.objectContaining({
                id: USER_ID,
                app_metadata: {
                    provider: 'google',
                    analysis_test_runner_v1: 'basic',
                },
            }),
            'standard',
        );
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('polls a durable pending dispatch without issuing duplicate Cloud Tasks creates', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: [{
                ...admissionRow(),
                admission_status: 'pending',
                should_enqueue: false,
                dispatch_token: null,
                selected_plan_allowed: null,
                admission_token: null,
                admission_refreshed_at: null,
                target_followers_count: null,
                target_following_count: null,
                capacity_required_plan_id: null,
                required_plan_id: null,
                plan_cards_snapshot: null,
            }],
            error: null,
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(202);
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.rpc).toHaveBeenCalledOnce();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('consumes and dispatches only after Cloud Run committed an allowed latest snapshot', async () => {
        const response = await POST(request(), context());

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            requestId: REQUEST_ID,
            status: 'queued',
            backgroundProcessing: true,
        });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'consume_analysis_v2_test_entitlement',
        ]);
        const jtiHash = hashAnalysisTestEntitlementJti('route_entitlement_nonce_01');
        expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
            p_entitlement_jti_hash: jtiHash,
            p_selected_plan_id: 'standard',
        });
        expect(mocks.rpc.mock.calls[1][1]).toMatchObject({
            p_admission_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
            p_entitlement_jti_hash: jtiHash,
            p_selected_plan_id: 'standard',
        });
        expect(mocks.dispatchJob).toHaveBeenCalledWith(
            REQUEST_ID,
            ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        );
        expect(mocks.operationalEmit).toHaveBeenCalledWith({
            event: 'analysis_v2.request_queued',
            severity: 'info',
            fields: expect.objectContaining({
                request_id: '123e4567-e89b-42d3-a456-426614174099',
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                analysis_request_id: REQUEST_ID,
                job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                plan_id: 'standard',
                operation: 'entitlement',
                disposition: 'enqueued',
            }),
        });
        const queuedEvent = mocks.operationalEmit.mock.calls[0]?.[0];
        expect(queuedEvent?.fields).not.toHaveProperty('target_instagram_id');
        expect(JSON.stringify(queuedEvent)).not.toContain('target.account');
    });

    it('waits for strict preflight cost reconciliation before consuming the replayable entitlement', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        let reconciled = false;
        mocks.rpc.mockImplementation(async (name: string) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                return {
                    data: reconciled
                        ? { disposition: 'ready', admissionToken: ADMISSION_TOKEN }
                        : { disposition: 'pending' },
                    error: null,
                };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                return {
                    data: { disposition: 'begun', created: true, replayed: false },
                    error: null,
                };
            }
            if (name === 'activate_analysis_revenue_dispatch_guard_v1') {
                return {
                    data: { disposition: 'active', created: true, replayed: false },
                    error: null,
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });

        const pending = await POST(request(), context());

        expect(pending.status).toBe(202);
        expect(pending.headers.get('retry-after')).toBe('5');
        await expect(pending.json()).resolves.toEqual({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ID,
            status: 'admission_pending',
            backgroundProcessing: true,
            retryAfterMs: 5_000,
        });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
        ]);
        expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({
            p_server_target_input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();

        reconciled = true;
        const admitted = await POST(request(), context());

        expect(admitted.status).toBe(201);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
            'begin_analysis_revenue_cost_ledger_v1',
            'activate_analysis_revenue_dispatch_guard_v1',
        ]);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'consume_analysis_v2_authorized_test_entitlement'
        )).toHaveLength(1);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'begin_analysis_revenue_cost_ledger_v1'
        )).toHaveLength(1);
        expect(mocks.dispatchJob).toHaveBeenCalledOnce();
    });

    it('returns a stable fail-closed response when the strict settlement fence rejects target lineage', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE' },
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'TEST_ENTITLEMENTS_UNAVAILABLE',
        });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
        ]);
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('closes the ready-admission race between the first settlement gate and reservation', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        let settlementPrepareCalls = 0;
        mocks.rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                settlementPrepareCalls += 1;
                return {
                    data: settlementPrepareCalls === 1
                        ? { disposition: 'not_applicable' }
                        : settlementPrepareCalls === 2
                            ? { disposition: 'pending' }
                            : { disposition: 'ready', admissionToken: ADMISSION_TOKEN },
                    error: null,
                };
            }
            if (name === 'reserve_analysis_v2_preflight_admission_dispatch_v2') {
                return {
                    data: [admissionRow({ admission_token: params.p_admission_token })],
                    error: null,
                };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                return {
                    data: { disposition: 'begun', created: true, replayed: false },
                    error: null,
                };
            }
            if (name === 'activate_analysis_revenue_dispatch_guard_v1') {
                return {
                    data: { disposition: 'active', created: true, replayed: false },
                    error: null,
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });

        const raced = await POST(request(), context());

        expect(raced.status).toBe(202);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();

        const settled = await POST(request(), context());

        expect(settled.status).toBe(201);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
            'begin_analysis_revenue_cost_ledger_v1',
            'activate_analysis_revenue_dispatch_guard_v1',
        ]);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'consume_analysis_v2_authorized_test_entitlement'
        )).toHaveLength(1);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'begin_analysis_revenue_cost_ledger_v1'
        )).toHaveLength(1);
    });

    it('keeps a migration-first pending consume error on the bounded strict 202 contract', async () => {
        installPreflightQuery(preflightRow({ target_instagram_id: '0_min._.00' }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        let prepareCalls = 0;
        mocks.rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                prepareCalls += 1;
                return {
                    data: prepareCalls === 1
                        ? { disposition: 'not_applicable' }
                        : { disposition: 'ready', admissionToken: ADMISSION_TOKEN },
                    error: null,
                };
            }
            if (name === 'reserve_analysis_v2_preflight_admission_dispatch_v2') {
                return { data: [admissionRow({ admission_token: params.p_admission_token })], error: null };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return {
                    data: null,
                    error: { code: 'P0001', message: 'ANALYSIS_V2_REVENUE_SETTLEMENT_PENDING' },
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(202);
        expect(response.headers.get('retry-after')).toBe('5');
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            preflightId: PREFLIGHT_ID,
            status: 'admission_pending',
            backgroundProcessing: true,
            retryAfterMs: 5_000,
        });
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
        ]);
    });

    it('fails closed when reserve crosses the strict settlement fence after a g1 prepare is not applicable', async () => {
        installPreflightQuery(preflightRow({ target_instagram_id: '0_min._.00' }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        mocks.rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                expect(params).toEqual({
                    p_preflight_id: PREFLIGHT_ID,
                    p_user_id: USER_ID,
                    p_selected_plan_id: 'standard',
                    p_entitlement_jti_hash: hashAnalysisTestEntitlementJti('route_entitlement_nonce_01'),
                    p_server_target_input_hash: expect.any(String),
                });
                return { data: { disposition: 'not_applicable' }, error: null };
            }
            if (name === 'reserve_analysis_v2_preflight_admission_dispatch_v2') {
                return {
                    data: null,
                    error: {
                        code: 'P0001',
                        message: 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                    },
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            error: '분석 테스트 대상 확인을 사용할 수 없습니다.',
            code: 'TEST_ENTITLEMENTS_UNAVAILABLE',
        });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('replays idempotently when a concurrent consume makes the post-reserve prepare not applicable', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        let settlementPrepareCalls = 0;
        mocks.rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                settlementPrepareCalls += 1;
                return {
                    data: { disposition: 'not_applicable' },
                    error: null,
                };
            }
            if (name === 'reserve_analysis_v2_preflight_admission_dispatch_v2') {
                return {
                    data: [admissionRow({ admission_token: params.p_admission_token })],
                    error: null,
                };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return {
                    data: consumedResult({
                        created: false,
                        request_status: 'pending',
                        background_processing: true,
                    }),
                    error: null,
                };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                return {
                    data: { disposition: 'begun', created: false, replayed: true },
                    error: null,
                };
            }
            if (name === 'activate_analysis_revenue_dispatch_guard_v1') {
                return {
                    data: { disposition: 'active', created: false, replayed: true },
                    error: null,
                };
            }
            if (name === 'dispatch_analysis_v2_job') {
                return { data: 'already_dispatched', error: null };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            requestId: REQUEST_ID,
            status: 'queued',
            backgroundProcessing: true,
        });
        expect(settlementPrepareCalls).toBe(2);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
            'begin_analysis_revenue_cost_ledger_v1',
            'activate_analysis_revenue_dispatch_guard_v1',
        ]);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'consume_analysis_v2_authorized_test_entitlement'
        )).toHaveLength(1);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'begin_analysis_revenue_cost_ledger_v1'
        )).toHaveLength(1);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'activate_analysis_revenue_dispatch_guard_v1'
        )).toHaveLength(1);
        expect(mocks.dispatchJob).toHaveBeenCalledOnce();
    });

    it('replays directly when the first settlement prepare observes a concurrent consumed preflight', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        mocks.rpc.mockImplementation(async (name: string) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                return { data: { disposition: 'replayable' }, error: null };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return {
                    data: consumedResult({ created: false, background_processing: true }),
                    error: null,
                };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                return {
                    data: { disposition: 'begun', created: false, replayed: true },
                    error: null,
                };
            }
            if (name === 'activate_analysis_revenue_dispatch_guard_v1') {
                return {
                    data: { disposition: 'active', created: false, replayed: true },
                    error: null,
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(200);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
            'begin_analysis_revenue_cost_ledger_v1',
            'activate_analysis_revenue_dispatch_guard_v1',
        ]);
        expect(mocks.dispatchJob).toHaveBeenCalledOnce();
    });

    it('concurrently replays one strict entitlement with one consume, ledger, guard, and dispatch effect', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        let consumed = false;
        let ledgerBegun = false;
        let guardActivated = false;
        let dispatched = false;
        mocks.rpc.mockImplementation(async (name: string) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                return { data: { disposition: 'ready', admissionToken: ADMISSION_TOKEN }, error: null };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                const created = !consumed;
                consumed = true;
                return { data: consumedResult({ created }), error: null };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                const created = !ledgerBegun;
                ledgerBegun = true;
                return {
                    data: { disposition: 'begun', created, replayed: !created },
                    error: null,
                };
            }
            if (name === 'activate_analysis_revenue_dispatch_guard_v1') {
                const created = !guardActivated;
                guardActivated = true;
                return {
                    data: { disposition: 'active', created, replayed: !created },
                    error: null,
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });
        mocks.dispatchJob.mockImplementation(async () => {
            if (dispatched) return 'already_dispatched';
            dispatched = true;
            return 'enqueued';
        });

        const responses = await Promise.all([
            POST(request(), context()),
            POST(request(), context()),
        ]);

        expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
        expect(consumed).toBe(true);
        expect(ledgerBegun).toBe(true);
        expect(guardActivated).toBe(true);
        expect(dispatched).toBe(true);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'consume_analysis_v2_authorized_test_entitlement'
        )).toHaveLength(2);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'begin_analysis_revenue_cost_ledger_v1'
        )).toHaveLength(2);
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'activate_analysis_revenue_dispatch_guard_v1'
        )).toHaveLength(2);
        expect(mocks.dispatchJob).toHaveBeenCalledTimes(2);
    });

    it('does not dispatch a Basic or Standard request when durable revenue-ledger begin fails', async () => {
        installPreflightQuery(preflightRow({ target_instagram_id: '0_min._.00' }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        let strictSettlementPrepareCalls = 0;
        mocks.rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
            if (name === 'prepare_analysis_v2_authorized_revenue_settlement_admission') {
                strictSettlementPrepareCalls += 1;
                return {
                    data: strictSettlementPrepareCalls === 1
                        ? { disposition: 'not_applicable' }
                        : { disposition: 'ready', admissionToken: ADMISSION_TOKEN },
                    error: null,
                };
            }
            if (name === 'reserve_analysis_v2_preflight_admission_dispatch_v2') {
                return { data: [admissionRow({ admission_token: params.p_admission_token })], error: null };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'begin_analysis_revenue_cost_ledger_v1') {
                return { data: null, error: { code: 'P0001', message: 'REVENUE_COST_LEDGER_FENCE' } };
            }
            if (name === 'quarantine_analysis_revenue_dispatch_v1') {
                return {
                    data: { disposition: 'quarantined', created: true, replayed: false },
                    error: null,
                };
            }
            throw new Error(`unexpected RPC: ${name}`);
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await POST(request(), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ code: 'ANALYSIS_START_FAILED' });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
            'begin_analysis_revenue_cost_ledger_v1',
            'quarantine_analysis_revenue_dispatch_v1',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
    });

    it('atomically binds the exact authorized target policy before initial dispatch', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(201);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            'consume_analysis_v2_authorized_test_entitlement',
            'begin_analysis_revenue_cost_ledger_v1',
            'activate_analysis_revenue_dispatch_guard_v1',
        ]);
        expect(mocks.rpc.mock.calls[3][1]).toMatchObject({
            p_user_id: USER_ID,
            p_target_instagram_id: '0_min._.00',
            p_policy_version: 'authorized-free-e2e-v1',
            p_operation_slot_map: {
                'target-profile': 'tertiary',
                'relationship-followers': 'primary',
                'relationship-following': 'secondary',
                'profile-fallback': 'tertiary',
                'target-likers': 'quaternary',
                'target-comments': 'tertiary',
                'candidate-likers': 'quinary',
            },
        });
        expect(mocks.dispatchJob).toHaveBeenCalledWith(
            REQUEST_ID,
            ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        );
        // The strict fresh path receives a raw target only for authenticated
        // RPC input; its operational event must not retain it.
        expect(JSON.stringify(mocks.operationalEmit.mock.calls)).not.toContain('0_min._.00');
    });

    it('keeps ordinary targets on the original consumption RPC when test sharding is enabled', async () => {
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(201);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'consume_analysis_v2_test_entitlement',
        ]);
    });

    it('keeps an authorized Plus admission outside the strict settlement gate', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });

        const response = await POST(request({
            body: { planId: 'plus' },
            token: entitlementToken('plus'),
        }), context());

        expect(response.status).toBe(201);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'consume_analysis_v2_authorized_test_entitlement',
        ]);
        expect(mocks.rpc).not.toHaveBeenCalledWith(
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
            expect.anything(),
        );
        expect(mocks.rpc).not.toHaveBeenCalledWith(
            'begin_analysis_revenue_cost_ledger_v1',
            expect.anything(),
        );
    });

    it('replays a strict terminal/manual-review-equivalent request without begin, guard activation, or dispatch', async () => {
        mocks.getTasksConfig.mockReturnValue(null);
        mocks.getPreflightTasksConfig.mockReturnValue(null);
        installPreflightQuery(preflightRow({
            status: 'consumed',
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            consumed_request_id: REQUEST_ID,
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        mocks.rpc.mockResolvedValueOnce({
            data: consumedResult({
                created: false,
                request_status: 'failed',
                background_processing: false,
            }),
            error: null,
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            requestId: REQUEST_ID,
            status: 'failed',
            backgroundProcessing: false,
        });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'consume_analysis_v2_authorized_test_entitlement',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('keeps the exact target on the original RPC for a different signed-test owner', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID:
                '123e4567-e89b-42d3-a456-426614174099',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(201);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
            'consume_analysis_v2_test_entitlement',
        ]);
    });

    it('rejects an invalid exact-target policy before admission or provider work', async () => {
        installPreflightQuery(preflightRow({
            target_instagram_id: '0_min._.00',
        }));
        Object.assign(process.env, {
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
            ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
            ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: USER_ID,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'primary',
            ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
            ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
            ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await POST(request(), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'TEST_PROVIDER_POLICY_UNAVAILABLE',
        });
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'Authorized analysis test provider policy is invalid.'
        );
    });

    it('returns committed latest cards for a stale cheap plan with zero consume/dispatch', async () => {
        installPreflightQuery(preflightRow({
            target_followers_count: 300,
            target_following_count: 350,
            capacity_required_plan_id: 'basic',
            required_plan_id: 'basic',
            plan_cards_snapshot: planCards('basic'),
        }));
        mocks.rpc.mockImplementationOnce(async (_name, params) => ({
            data: [admissionRow({
                selected_plan_id: 'basic',
                selected_plan_allowed: false,
                admission_token: params.p_admission_token,
            })],
            error: null,
        }));

        const response = await POST(request({
            body: { planId: 'basic' },
            token: entitlementToken('basic'),
        }), context());

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            code: 'ANALYSIS_V2_PLAN_NOT_ALLOWED',
            latestPlan: {
                followersCount: 620,
                followingCount: 710,
                requiredPlanId: 'standard',
                selectedPlanId: 'basic',
                plans: [
                    { planId: 'basic', selectionState: 'unavailable' },
                    { planId: 'standard', selectionState: 'required' },
                    { planId: 'plus', selectionState: 'available_upgrade' },
                ],
            },
        });
        expect(mocks.rpc).toHaveBeenCalledOnce();
        expect(mocks.dispatchAdmission).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('returns a durable target block without consuming an entitlement', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: [admissionRow({
                admission_status: 'blocked',
                selected_plan_allowed: null,
                admission_token: null,
                target_followers_count: null,
                target_following_count: null,
                capacity_required_plan_id: null,
                required_plan_id: null,
                plan_cards_snapshot: null,
                admission_error_code: 'ANALYSIS_V2_TARGET_PRIVATE',
            })],
            error: null,
        });

        const response = await POST(request(), context());
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            code: 'ANALYSIS_V2_TARGET_PRIVATE',
        });
        expect(mocks.rpc).toHaveBeenCalledOnce();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('returns bounded 503 after the fresh profile retry budget is exhausted', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: [admissionRow({
                admission_status: 'blocked',
                selected_plan_allowed: null,
                admission_token: null,
                target_followers_count: null,
                target_following_count: null,
                capacity_required_plan_id: null,
                required_plan_id: null,
                plan_cards_snapshot: null,
                admission_error_code: 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
            })],
            error: null,
        });

        const response = await POST(request(), context());
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
        });
        expect(mocks.rpc).toHaveBeenCalledOnce();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('redrives a consumed request while new admission is disabled', async () => {
        mocks.getPreflightTasksConfig.mockReturnValue(null);
        installPreflightQuery(preflightRow({
            status: 'consumed',
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            consumed_request_id: REQUEST_ID,
        }));
        mocks.rpc.mockResolvedValueOnce({
            data: consumedResult({ created: false, request_status: 'processing' }),
            error: null,
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(200);
        expect(mocks.getPreflightTasksConfig).not.toHaveBeenCalled();
        expect(mocks.getTasksConfig).not.toHaveBeenCalled();
        expect(mocks.rpc).toHaveBeenCalledOnce();
        expect(mocks.rpc.mock.calls[0][1].p_admission_token).toBeNull();
        expect(mocks.dispatchJob).toHaveBeenCalledOnce();
    });

    it('replays a terminal consumed request without requiring either queue configuration', async () => {
        mocks.getTasksConfig.mockReturnValue(null);
        mocks.getPreflightTasksConfig.mockReturnValue(null);
        installPreflightQuery(preflightRow({
            status: 'consumed',
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            consumed_request_id: REQUEST_ID,
        }));
        mocks.rpc.mockResolvedValueOnce({
            data: consumedResult({
                created: false,
                request_status: 'completed',
                background_processing: false,
            }),
            error: null,
        });

        const response = await POST(request(), context());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            requestId: REQUEST_ID,
            status: 'completed',
            backgroundProcessing: false,
        });
        expect(mocks.getTasksConfig).not.toHaveBeenCalled();
        expect(mocks.getPreflightTasksConfig).not.toHaveBeenCalled();
        expect(mocks.rpc).toHaveBeenCalledOnce();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('allows a valid signed canary while public admission remains disabled', async () => {
        process.env.ANALYSIS_V2_ADMISSION_ENABLED = 'false';
        const response = await POST(request(), context());
        expect(response.status).toBe(201);
        expect(mocks.rpc).toHaveBeenCalledTimes(2);
        expect(mocks.dispatchJob).toHaveBeenCalledOnce();
    });

    it('fails closed before reservation when the paid queue is unavailable', async () => {
        mocks.getTasksConfig.mockReturnValueOnce(null);
        const response = await POST(request(), context());
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('keeps an ambiguous enqueue reservation replayable and never consumes or dispatches analysis', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: [{
                ...admissionRow(),
                admission_status: 'pending',
                should_enqueue: true,
                dispatch_token: DISPATCH_TOKEN,
                selected_plan_allowed: null,
                admission_token: null,
                admission_refreshed_at: null,
                target_followers_count: null,
                target_following_count: null,
                capacity_required_plan_id: null,
                required_plan_id: null,
                plan_cards_snapshot: null,
            }],
            error: null,
        });
        mocks.dispatchAdmission.mockRejectedValueOnce(new Error('private queue detail'));

        const response = await POST(request(), context());
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('retains a fresh admission fence after enqueue refusal for maintenance replay', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: [{
                ...admissionRow(),
                admission_status: 'pending',
                should_enqueue: true,
                dispatch_token: DISPATCH_TOKEN,
                selected_plan_allowed: null,
                admission_token: null,
                admission_refreshed_at: null,
                target_followers_count: null,
                target_following_count: null,
                capacity_required_plan_id: null,
                required_plan_id: null,
                plan_cards_snapshot: null,
            }],
            error: null,
        });
        mocks.dispatchAdmission.mockRejectedValueOnce(
            new mocks.AnalysisV2TaskEnqueueError('terminal'),
        );

        const response = await POST(request(), context());
        expect(response.status).toBe(503);
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission_dispatch_v2',
        ]);
    });

    it('rejects unauthenticated, malformed, cross-owner, and invalid-entitlement requests', async () => {
        mocks.createServerClient.mockResolvedValueOnce({
            auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
        });
        expect((await POST(request(), context())).status).toBe(401);
        expect((await POST(request({
            body: { planId: 'standard', extra: true },
        }), context())).status).toBe(400);
        expect((await POST(request(), context('not-a-uuid'))).status).toBe(400);

        installPreflightQuery(null);
        expect((await POST(request(), context())).status).toBe(404);
        installPreflightQuery();
        for (const token of [null, 'v1.invalid.invalid', entitlementToken('plus')]) {
            expect((await POST(request({ token }), context())).status).toBe(403);
        }
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('does not leak entitlement material on unexpected persistence failure', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'XX000', message: 'private database detail' },
        });
        const token = entitlementToken();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await POST(request({ token }), context());
        expect(response.status).toBe(500);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(token);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('route_entitlement_nonce_01');
    });
});
