import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import registry from '@/config/dev-ui-deployment.json';
import { assertDevLiveWebRuntime, devLiveWorkerRequestBoundary } from '@/lib/services/dev-ui/live-runtime';

const registered = registry.deployments[0];
const project = 'yeosachin-isolated-test';
const number = '101234567890';
const location = 'asia-northeast3';
const devDatabase = `https://${registered.supabaseProjectRef}.supabase.co`;
const preflightOrigin = `https://dev-live-preflight-${number}.${location}.run.app`;
const paidOrigin = `https://dev-live-paid-${number}.${location}.run.app`;
const preflightEndpoint = `${preflightOrigin}/api/analysis/preflight/worker`;
const paidEndpoint = `${paidOrigin}/api/analysis/v2/worker`;
const env = {
    DEV_LIVE_GCP_PROJECT: project,
    DEV_LIVE_GCP_PROJECT_NUMBER: number,
    GOOGLE_CLOUD_PROJECT: project,
    DEV_LIVE_PREFLIGHT_ORIGIN: preflightOrigin,
    DEV_LIVE_PAID_ORIGIN: paidOrigin,
    NEXT_PUBLIC_SUPABASE_URL: devDatabase,
};
const preflight = {
    PREFLIGHT_TASKS_ENABLED: 'true',
    PREFLIGHT_TASKS_PROJECT: project,
    PREFLIGHT_TASKS_LOCATION: location,
    PREFLIGHT_TASKS_QUEUE: 'dev-live-preflight',
    PREFLIGHT_TASKS_TARGET_URL: preflightEndpoint,
    PREFLIGHT_TASKS_OIDC_AUDIENCE: preflightOrigin,
    PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: `dev-live-preflight-invoker@${project}.iam.gserviceaccount.com`,
    PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: `dev-live-vercel-enqueuer@${project}.iam.gserviceaccount.com`,
};
const paid = {
    ANALYSIS_V2_TASKS_ENABLED: 'true',
    ANALYSIS_V2_TASKS_PROJECT: project,
    ANALYSIS_V2_TASKS_LOCATION: location,
    ANALYSIS_V2_TASKS_QUEUE: 'dev-live-paid',
    ANALYSIS_V2_TASKS_TARGET_URL: paidEndpoint,
    ANALYSIS_V2_TASKS_OIDC_AUDIENCE: paidOrigin,
    ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: `dev-live-paid-invoker@${project}.iam.gserviceaccount.com`,
    ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: `dev-live-vercel-enqueuer@${project}.iam.gserviceaccount.com`,
};
const webEnv = {
    ...env, ...preflight, ...paid,
    DEPLOYMENT_ROLE: 'dev',
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_ID: registered.vercelProjectId,
    ANALYSIS_V2_ADMISSION_ENABLED: 'true',
    ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT: 'production',
    ANALYSIS_V2_NARRATIVE_V28_ROLLOUT: 'production',
    ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT: 'production',
    ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT: 'production',
    ANALYSIS_V2_AI_SCHEDULER_ROLLOUT: 'production',
    ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT: 'off',
    LANDING_LEAD_CAPTURE_SECRET: 'synthetic-test-key-not-a-production-secret',
    IMAGE_PROXY_SIGNING_SECRET: 'synthetic-test-only-image-signing-key',
    ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: `${project}-dev-live-results`,
    PREFLIGHT_TASKS_CALLER_AUTH_MODE: 'vercel-wif',
    ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'vercel-wif',
    GCP_VERCEL_WIF_PROVIDER_RESOURCE: `projects/${number}/locations/global/workloadIdentityPools/dev-live-vercel/providers/dev-live-vercel`,
};
const approval = {
    DEV_LIVE_ANALYSIS_ARMED: 'true',
    // Synthetic operator approval. No provider client is constructed by these tests.
    DEV_LIVE_ANALYSIS_APPROVAL: JSON.stringify({
        id: '950251c5-e958-4c59-86a4-6f61d529037b',
        targetInstagramId: 'dev_test_profile',
        approvedAt: '2026-11-18T06:00:00Z',
        expiresAt: '2026-11-18T06:30:00Z',
        apifyMaxCents: 100,
        aiMaxCents: 25,
    }),
};
const workerEffects = {
    ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
    ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1',
    VERTEX_AI_BUDGET_GUARD_ENABLED: 'true',
    VERTEX_AI_BUDGET_STORE: 'supabase',
    VERTEX_AI_PER_RUN_BUDGET_USD: '0.25',
    VERTEX_AI_PER_ORDER_BUDGET_USD: '0.25',
    VERTEX_AI_DAILY_BUDGET_USD: '0.25',
    APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.50',
};
const preflightWorker = {
    ...env, ...preflight, ...approval, ...workerEffects,
    K_SERVICE: 'dev-live-preflight',
    DEV_LIVE_WORKLOAD: 'preflight',
    ANALYSIS_WORKLOAD_ROLE: 'preflight',
    PREFLIGHT_TASKS_CALLER_AUTH_MODE: 'adc',
};
const paidWorker = {
    ...env, ...paid, ...approval, ...workerEffects,
    K_SERVICE: 'dev-live-paid',
    DEV_LIVE_WORKLOAD: 'paid',
    ANALYSIS_WORKLOAD_ROLE: 'paid',
    ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'adc',
    ANALYSIS_V2_WORKER_ENABLED: 'true',
    APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION: '1.00',
    APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.50',
    APIFY_COMMENTS_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.50',
    ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: `${project}-dev-live-media`,
    ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: `${project}-dev-live-results`,
};

function request(url: string, method = 'POST', headers: HeadersInit = { host: new URL(url).host }):
    Pick<Request, 'url' | 'method' | 'headers'> {
    return { url, method, headers: new Headers(headers) };
}

beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', devDatabase);
    vi.setSystemTime(new Date('2026-11-18T06:10:00Z'));
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('Dev live analysis runtime placement', () => {
    it('validates both Dev queues without requiring an active approval to inspect configuration', () => {
        expect(() => assertDevLiveWebRuntime(webEnv)).not.toThrow();
        expect(devLiveWorkerRequestBoundary(request(preflightEndpoint), webEnv)).toBe('not-worker');
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), { K_SERVICE: 'analysis-paid-worker' })).toBe('not-worker');
    });

    it.each([
        ['unregistered Vercel project', { VERCEL_PROJECT_ID: 'prj_other' }],
        ['preview project slot', { VERCEL_ENV: 'preview' }],
        ['unregistered database', { NEXT_PUBLIC_SUPABASE_URL: 'https://production.supabase.co' }],
        ['production GCP project', { DEV_LIVE_GCP_PROJECT: 'gen-lang-client-0311522474', GOOGLE_CLOUD_PROJECT: 'gen-lang-client-0311522474' }],
        ['production project number', { DEV_LIVE_GCP_PROJECT_NUMBER: '919163272964' }],
        ['production queue', { ANALYSIS_V2_TASKS_QUEUE: 'analysis-paid' }],
        ['other Cloud Run origin', { DEV_LIVE_PAID_ORIGIN: 'https://example.run.app' }],
        ['preflight OIDC audience mismatch', { PREFLIGHT_TASKS_OIDC_AUDIENCE: paidOrigin }],
        ['incorrect queue caller identity', { ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: `other@${project}.iam.gserviceaccount.com` }],
        ['incorrect WIF resource', { GCP_VERCEL_WIF_PROVIDER_RESOURCE: 'projects/919163272964/locations/global/workloadIdentityPools/dev-live-vercel/providers/dev-live-vercel' }],
        ['anonymous fallback execution', { PREFLIGHT_LOCAL_AFTER_ENABLED: 'true' }],
        ['preflight recovery consumer', { PREFLIGHT_TASKS_RECOVERY_ENABLED: 'true' }],
        ['automatic recovery consumer', { ANALYSIS_V2_RECOVERY_ENABLED: 'true' }],
        ['experimental AI policy', { ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT: 'production' }],
        ['missing exclusion signing key', { LANDING_LEAD_CAPTURE_SECRET: undefined }],
        ['missing Dev image signing key', { IMAGE_PROXY_SIGNING_SECRET: undefined }],
        ['production result storage', { ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: 'production-results' }],
    ])('fails closed for %s', (_name, changed) => {
        expect(() => assertDevLiveWebRuntime({ ...webEnv, ...changed })).toThrow('DEV_LIVE_RUNTIME_REJECTED');
    });

    it('permits Ascentum only with an explicit placement and fully namespaced resources', () => {
        const shared = Object.fromEntries(Object.entries(webEnv).map(([key, value]) => [
            key, value.replaceAll(project, 'gen-lang-client-0311522474').replaceAll(number, '919163272964'),
        ]));
        expect(() => assertDevLiveWebRuntime(shared)).toThrow('DEV_LIVE_RUNTIME_REJECTED');
        expect(() => assertDevLiveWebRuntime({ ...shared, DEV_LIVE_GCP_PLACEMENT: 'ascentum_shared' })).not.toThrow();
        expect(() => assertDevLiveWebRuntime({
            ...shared, DEV_LIVE_GCP_PLACEMENT: 'ascentum_shared', ANALYSIS_V2_TASKS_QUEUE: 'analysis-paid',
        })).toThrow('DEV_LIVE_RUNTIME_REJECTED');
        expect(() => assertDevLiveWebRuntime({
            ...shared, DEV_LIVE_GCP_PLACEMENT: 'ascentum_shared', DEV_LIVE_GCP_PROJECT_NUMBER: number,
        })).toThrow('DEV_LIVE_RUNTIME_REJECTED');
        expect(() => assertDevLiveWebRuntime({ ...webEnv, DEV_LIVE_GCP_PLACEMENT: 'ascentum_shared' }))
            .toThrow('DEV_LIVE_RUNTIME_REJECTED');
    });

    it('recognizes only matching active preflight and paid Cloud Run endpoints', () => {
        expect(devLiveWorkerRequestBoundary(request(preflightEndpoint), preflightWorker)).toBe('dev-worker');
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), paidWorker)).toBe('dev-worker');
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), preflightWorker)).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(preflightEndpoint, 'GET'), preflightWorker)).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(`${preflightEndpoint}?run=1`), preflightWorker)).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(`${paidOrigin}/api/analysis/v2/recover`), paidWorker)).toBe('invalid');
    });

    it('opens paid recovery only for the dedicated Dev Standard maintenance identity', () => {
        const endpoint = `${paidOrigin}/api/analysis/v2/recover`;
        const maintenance = {
            ...paidWorker,
            DEV_LIVE_ANALYSIS_MODE: 'owner_start',
            DEV_LIVE_STANDARD_RECOVERY_ENABLED: 'true',
            ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE: paidOrigin,
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: `dev-live-paid-maintenance@${project}.iam.gserviceaccount.com`,
        };
        expect(devLiveWorkerRequestBoundary(request(endpoint), maintenance)).toBe('dev-worker');
        expect(devLiveWorkerRequestBoundary(request(endpoint), {
            ...maintenance, ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: paid.ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL,
        })).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(endpoint), {
            ...maintenance, ANALYSIS_V2_RECOVERY_ENABLED: 'true',
        })).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(`${endpoint}?scope=other`), maintenance)).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(endpoint, 'GET'), maintenance)).toBe('invalid');
    });

    it('matches the Cloud Run host when self-hosted Next uses its listener address in the proxy URL', () => {
        for (const [endpoint, worker] of [
            [preflightEndpoint, preflightWorker],
            [paidEndpoint, paidWorker],
        ] as const) {
            const { pathname, host } = new URL(endpoint);
            expect(devLiveWorkerRequestBoundary(
                request(`https://localhost:8080${pathname}`, 'POST', { host }),
                worker,
            )).toBe('dev-worker');
        }
    });

    it('rejects proxy requests without the exact Cloud Run host and worker URL path', () => {
        const { pathname, host } = new URL(preflightEndpoint);
        const listenerUrl = `https://localhost:8080${pathname}`;
        const invalid = [
            request(preflightEndpoint, 'POST', {}),
            request(preflightEndpoint, 'POST', { host: 'another.run.app' }),
            request(listenerUrl, 'POST', { 'x-forwarded-host': host }),
            request(listenerUrl, 'POST', { host: 'another.run.app', 'x-forwarded-host': host }),
            request(listenerUrl, 'POST', { host: new URL(paidOrigin).host }),
            request(listenerUrl, 'POST', { host: `${host}:8080` }),
            request(listenerUrl.replace('https:', 'http:'), 'POST', { host }),
            request(listenerUrl.replace('https://', 'https://user:password@'), 'POST', { host }),
            request(`${listenerUrl}?run=1`, 'POST', { host }),
            request(`${listenerUrl}?`, 'POST', { host }),
            request(`${listenerUrl}#fragment`, 'POST', { host }),
            request(`${listenerUrl}/`, 'POST', { host }),
            request(listenerUrl, 'GET', { host }),
        ];
        for (const invalidRequest of invalid) {
            expect(devLiveWorkerRequestBoundary(invalidRequest, preflightWorker)).toBe('invalid');
        }
    });

    it('requires the canonical URL for the in-process provider budget check', () => {
        expect(devLiveWorkerRequestBoundary({ url: paidEndpoint, method: 'POST' }, paidWorker)).toBe('dev-worker');
        expect(devLiveWorkerRequestBoundary({
            url: 'https://localhost:8080/api/analysis/v2/worker',
            method: 'POST',
        }, paidWorker)).toBe('invalid');
    });

    it.each([
        ['absent marker', { DEV_LIVE_WORKLOAD: undefined }],
        ['mismatched workload role', { ANALYSIS_WORKLOAD_ROLE: 'preflight' }],
        ['disabled approval', { DEV_LIVE_ANALYSIS_ARMED: 'false' }],
        ['missing approval', { DEV_LIVE_ANALYSIS_APPROVAL: undefined }],
        ['wrong target database', { NEXT_PUBLIC_SUPABASE_URL: 'https://production.supabase.co' }],
        ['static ADC credentials', { GOOGLE_APPLICATION_CREDENTIALS: '/secret/adc.json' }],
        ['inline static Google key', { GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: 'synthetic-test-value' }],
        ['other artifact storage', { ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'production-media' }],
        ['second queue', { PREFLIGHT_TASKS_ENABLED: 'true' }],
        ['provider admission disabled', { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'false' }],
        ['alternate test routing enabled', { ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true' }],
        ['per-process AI budget', { VERTEX_AI_BUDGET_STORE: 'memory' }],
        ['unbounded provider cap', { APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION: undefined }],
        ['provider cap over the approval', { APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION: '1.01' }],
        ['AI cap over the approval', { VERTEX_AI_PER_ORDER_BUDGET_USD: '0.26' }],
    ])('rejects a paid worker with %s', (_name, changed) => {
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), { ...paidWorker, ...changed })).toBe('invalid');
    });

    it('checks owner-start worker infrastructure without a shared approval in the environment', () => {
        const ownerStart = { ...paidWorker, DEV_LIVE_ANALYSIS_MODE: 'owner_start',
            DEV_LIVE_ANALYSIS_APPROVAL: undefined };
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), ownerStart)).toBe('dev-worker');
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), {
            ...ownerStart, DEV_LIVE_ANALYSIS_ARMED: 'false',
        })).toBe('invalid');
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), {
            ...ownerStart, VERTEX_AI_DAILY_BUDGET_USD: '2.01',
        })).toBe('invalid');
    });

    it('stops accepting workers after the approval expires', () => {
        vi.setSystemTime(new Date('2026-11-18T06:31:00Z'));
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), paidWorker)).toBe('invalid');
    });

    it('denies web and worker mode when the compiled database URL differs', () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://production.supabase.co');
        expect(() => assertDevLiveWebRuntime(webEnv)).toThrow('DEV_LIVE_RUNTIME_REJECTED');
        expect(devLiveWorkerRequestBoundary(request(paidEndpoint), paidWorker)).toBe('invalid');
    });
});
