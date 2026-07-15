import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    dispatchAdmission: vi.fn(),
    dispatchJob: vi.fn(),
    from: vi.fn(),
    getPreflightTasksConfig: vi.fn(),
    getTasksConfig: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/services/analysis/v2-tasks', () => ({
    dispatchAnalysisV2Job: mocks.dispatchJob,
    getAnalysisV2TasksConfig: mocks.getTasksConfig,
}));
vi.mock('@/lib/services/analysis/preflight-tasks', () => ({
    enqueueFreshAdmissionTask: mocks.dispatchAdmission,
    getPreflightTasksConfig: mocks.getPreflightTasksConfig,
}));

import { POST } from '@/app/api/analysis/preflight/[preflightId]/entitle/route';
import { ANALYSIS_V2_BOOTSTRAP_JOB_KEY } from './v2-coordinator';
import { createAnalysisTestEntitlement } from './test-entitlement';
import { hashAnalysisTestEntitlementJti } from './test-entitlement-consumption';

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-b456-426614174001';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174002';
const ADMISSION_TOKEN = '123e4567-e89b-42d3-a456-426614174003';
const DISPATCH_TOKEN = '123e4567-e89b-42d3-a456-426614174004';
const DISPATCH_GENERATION = 3;
const ENTITLEMENT_SECRET = Buffer.alloc(32, 11).toString('base64url');
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
        mocks.dispatchAdmission.mockResolvedValue('enqueued');
        mocks.dispatchJob.mockResolvedValue('enqueued');
        mocks.getPreflightTasksConfig.mockReturnValue(preflightTaskConfig);
        mocks.getTasksConfig.mockReturnValue(taskConfig);
        mocks.createServerClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: { user: { id: USER_ID } },
                    error: null,
                }),
            },
        });
        installPreflightQuery();
        mocks.rpc.mockImplementation(async (
            name: string,
            params: Record<string, unknown>
        ) => {
            if (name === 'reserve_analysis_v2_preflight_admission') {
                return {
                    data: [admissionRow({ admission_token: params.p_admission_token })],
                    error: null,
                };
            }
            if (name === 'consume_analysis_v2_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'consume_analysis_v2_authorized_test_entitlement') {
                return { data: consumedResult(), error: null };
            }
            if (name === 'mark_analysis_v2_preflight_admission_dispatched') {
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
            PREFLIGHT_ID,
            2,
            DISPATCH_GENERATION,
            DISPATCH_TOKEN,
            { config: preflightTaskConfig }
        );
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'reserve_analysis_v2_preflight_admission',
            'mark_analysis_v2_preflight_admission_dispatched',
        ]);
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
            'reserve_analysis_v2_preflight_admission',
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
            'reserve_analysis_v2_preflight_admission',
            'consume_analysis_v2_authorized_test_entitlement',
        ]);
        expect(mocks.rpc.mock.calls[1][1]).toMatchObject({
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
            'reserve_analysis_v2_preflight_admission',
            'consume_analysis_v2_test_entitlement',
        ]);
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
            'reserve_analysis_v2_preflight_admission',
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

    it('fails closed before reservation when either durable queue is unavailable', async () => {
        for (const unavailable of ['analysis', 'preflight'] as const) {
            if (unavailable === 'analysis') mocks.getTasksConfig.mockReturnValueOnce(null);
            else mocks.getPreflightTasksConfig.mockReturnValueOnce(null);

            const response = await POST(request(), context());
            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
            expect(mocks.rpc).not.toHaveBeenCalled();
            mocks.getTasksConfig.mockReturnValue(taskConfig);
            mocks.getPreflightTasksConfig.mockReturnValue(preflightTaskConfig);
        }
    });

    it('keeps a failed enqueue replayable and never consumes or dispatches analysis', async () => {
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
            'reserve_analysis_v2_preflight_admission',
            'release_analysis_v2_preflight_admission_dispatch',
        ]);
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
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
