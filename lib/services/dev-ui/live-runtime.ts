import 'server-only';

import registry from '@/config/dev-ui-deployment.json';
import { browserDeploymentEnvironment, type DeploymentEnvironment } from '@/lib/constants/dev-ui';
import { getPreflightTasksConfig, type PreflightTasksConfig } from '@/lib/services/analysis/preflight-tasks';
import { getAnalysisV2TasksConfig, type AnalysisV2TasksConfig } from '@/lib/services/analysis/v2-tasks';
import { isDevUiDeployment } from './deployment';
import { DEV_LIVE_OWNER_CAPS, devLiveOwnerStartEnabled, readDevLiveApproval, type DevLiveApproval } from './live-approval';

const LOCATION = 'asia-northeast3';
const ASCENTUM_PROJECT = 'gen-lang-client-0311522474';
const ASCENTUM_PROJECT_NUMBER = '919163272964';
const ERROR = 'DEV_LIVE_RUNTIME_REJECTED';
const WORKER_ROUTES = {
    preflight: '/api/analysis/preflight/worker',
    paid: '/api/analysis/v2/worker',
} as const;

type Role = keyof typeof WORKER_ROUTES;
type TaskConfig = PreflightTasksConfig | AnalysisV2TasksConfig;

interface DevLiveCloudIdentity {
    projectId: string;
    projectNumber: string;
    origins: Record<Role, string>;
}

function reject(): never {
    throw new Error(ERROR);
}

function serviceName(role: Role): string {
    return `dev-live-${role}`;
}

function cloudIdentity(env: DeploymentEnvironment): DevLiveCloudIdentity {
    const projectId = env.DEV_LIVE_GCP_PROJECT ?? '';
    const projectNumber = env.DEV_LIVE_GCP_PROJECT_NUMBER ?? '';
    const placement = env.DEV_LIVE_GCP_PLACEMENT ?? 'dedicated';
    const isExactAscentum = projectId === ASCENTUM_PROJECT && projectNumber === ASCENTUM_PROJECT_NUMBER;
    const containsAscentumIdentity = projectId === ASCENTUM_PROJECT || projectNumber === ASCENTUM_PROJECT_NUMBER;
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
        || !/^[1-9]\d{5,19}$/.test(projectNumber)
        || (placement !== 'dedicated' && placement !== 'ascentum_shared')
        || (placement === 'ascentum_shared' ? !isExactAscentum : containsAscentumIdentity)
        || env.GOOGLE_CLOUD_PROJECT !== projectId
        || (env.GCLOUD_PROJECT !== undefined && env.GCLOUD_PROJECT !== projectId)
        || (env.GOOGLE_CLOUD_QUOTA_PROJECT !== undefined && env.GOOGLE_CLOUD_QUOTA_PROJECT !== projectId)
        || env.GOOGLE_APPLICATION_CREDENTIALS !== undefined
        || env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 !== undefined) reject();

    // Cloud Run's deterministic URL binds both the service name and the Dev
    // project number. Do not accept an arbitrary HTTPS or *.run.app origin.
    const origins = {
        preflight: `https://${serviceName('preflight')}-${projectNumber}.${LOCATION}.run.app`,
        paid: `https://${serviceName('paid')}-${projectNumber}.${LOCATION}.run.app`,
    };
    if (env.DEV_LIVE_PREFLIGHT_ORIGIN !== origins.preflight
        || env.DEV_LIVE_PAID_ORIGIN !== origins.paid) reject();
    return { projectId, projectNumber, origins };
}

function serviceAccount(name: string, projectId: string): string {
    return `${name}@${projectId}.iam.gserviceaccount.com`;
}

function assertTaskConfig(
    config: TaskConfig | null,
    role: Role,
    identity: DevLiveCloudIdentity,
    callerMode: 'vercel-wif' | 'adc',
): void {
    const { projectId, projectNumber, origins } = identity;
    if (!config || config.workloadRole !== role
        || config.project !== projectId || config.location !== LOCATION
        || config.queue !== serviceName(role)
        || config.targetUrl !== `${origins[role]}${WORKER_ROUTES[role]}`
        || config.oidcAudience !== origins[role]
        || config.serviceAccountEmail !== serviceAccount(`${serviceName(role)}-invoker`, projectId)
        || config.callerAuth.mode !== callerMode || config.callerAuth.projectId !== projectId) reject();

    if (config.callerAuth.mode === 'vercel-wif' && (
        config.callerAuth.providerResource
            !== `projects/${projectNumber}/locations/global/workloadIdentityPools/dev-live-vercel/providers/dev-live-vercel`
        || config.callerAuth.enqueuerServiceAccountEmail
            !== serviceAccount('dev-live-vercel-enqueuer', projectId)
    )) reject();
}

function assertLiveFlags(env: DeploymentEnvironment): void {
    // The web API has explicit Dev-only entry points. Keep the old standalone
    // local worker, beta pool and automatic recovery out of this runtime.
    const off = [
        env.PREFLIGHT_LOCAL_AFTER_ENABLED,
        env.ANALYSIS_BETA_PREPARE_ENABLED,
        env.BETATEST_FREE_POOL_ENABLED,
        env.PREFLIGHT_TASKS_RECOVERY_ENABLED,
        env.ANALYSIS_V2_RECOVERY_ENABLED,
        env.ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED,
    ];
    if (off.some(value => value !== undefined && value !== 'false')) reject();
}

function assertLiveWebPolicy(env: DeploymentEnvironment): void {
    // Preflight creation records these policy versions for the downstream worker.
    const productionRollouts = [
        env.ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT,
        env.ANALYSIS_V2_NARRATIVE_V28_ROLLOUT,
        env.ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT,
        env.ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT,
        env.ANALYSIS_V2_AI_SCHEDULER_ROLLOUT,
    ];
    if (productionRollouts.some(value => value !== 'production')
        || env.ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT !== 'off'
        || env.ANALYSIS_V2_ADMISSION_ENABLED !== 'true'
        || (env.LANDING_LEAD_CAPTURE_SECRET?.trim().length ?? 0) < 32) reject();
}

function hasBoundedUsdBudget(value: string | undefined, maximumCents: number): boolean {
    if (!value || !/^\d+(?:\.\d{1,8})?$/.test(value)) return false;
    const usd = Number(value);
    return usd > 0 && usd <= maximumCents / 100;
}

function assertLiveWorkerPolicy(env: DeploymentEnvironment, role: Role, approval: Pick<DevLiveApproval, 'apifyMaxCents' | 'aiMaxCents'>): void {
    const aiCaps = [
        env.VERTEX_AI_PER_RUN_BUDGET_USD,
        env.VERTEX_AI_PER_ORDER_BUDGET_USD,
        env.VERTEX_AI_DAILY_BUDGET_USD,
    ];
    const actorCaps = [
        env.APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION,
        ...(role === 'paid' ? [
            env.APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION,
            env.APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION,
            env.APIFY_COMMENTS_MAX_ESTIMATED_COST_USD_PER_OPERATION,
        ] : []),
    ];
    if (env.ANALYSIS_PROVIDER_ADMISSION_ENABLED !== 'true'
        || env.ANALYSIS_V2_INSTAGRAM_ROUTE !== 'apify_v1'
        || env.VERTEX_AI_BUDGET_GUARD_ENABLED !== 'true'
        || env.VERTEX_AI_BUDGET_STORE !== 'supabase'
        || aiCaps.some(value => !hasBoundedUsdBudget(value, approval.aiMaxCents))
        || actorCaps.some(value => !hasBoundedUsdBudget(value, approval.apifyMaxCents))
        || (role === 'paid' && env.ANALYSIS_V2_WORKER_ENABLED !== 'true')) reject();
}

function assertStorage(env: DeploymentEnvironment, projectId: string, role: Role | 'web'): void {
    const artifactBucket = env.ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET;
    const resultBucket = env.ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET;
    if ((role === 'paid' || artifactBucket !== undefined) && artifactBucket !== `${projectId}-dev-live-media`) reject();
    if ((role !== 'preflight' || resultBucket !== undefined) && resultBucket !== `${projectId}-dev-live-results`) reject();
}

export function assertDevLiveImageRuntime(env: DeploymentEnvironment = process.env): void {
    if (!isDevUiDeployment(env) || env.VERCEL_ENV !== 'production'
        || (env.IMAGE_PROXY_SIGNING_SECRET?.trim().length ?? 0) < 32) reject();
    assertStorage(env, cloudIdentity(env).projectId, 'web');
}

/** Validates both queues before the Dev web runtime can admit real work. */
export function assertDevLiveWebRuntime(env: DeploymentEnvironment = process.env): void {
    try {
        if (!isDevUiDeployment(env) || env.VERCEL_ENV !== 'production'
            || env.K_SERVICE !== undefined || env.DEV_LIVE_WORKLOAD !== undefined
            || env.ANALYSIS_WORKLOAD_ROLE !== undefined) reject();
        const identity = cloudIdentity(env);
        assertLiveFlags(env);
        assertLiveWebPolicy(env);
        assertStorage(env, identity.projectId, 'web');
        if ((env.IMAGE_PROXY_SIGNING_SECRET?.trim().length ?? 0) < 32) reject();
        assertTaskConfig(getPreflightTasksConfig(env), 'preflight', identity, 'vercel-wif');
        assertTaskConfig(getAnalysisV2TasksConfig(env), 'paid', identity, 'vercel-wif');
    } catch {
        reject();
    }
}

function hasRegisteredDevWorkerDatabase(env: DeploymentEnvironment): boolean {
    const runtimeUrl = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
    const buildUrl = browserDeploymentEnvironment().NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
    return Boolean(runtimeUrl && runtimeUrl === buildUrl
        && registry.deployments.some(entry => runtimeUrl === `https://${entry.supabaseProjectRef}.supabase.co`));
}

type WorkerRequest = Pick<Request, 'url' | 'method'> & Partial<Pick<Request, 'headers'>>;

function matchesWorkerEndpoint(request: WorkerRequest, origin: string, path: string): boolean {
    // The provider budget guard checks the configured endpoint in process.
    if (!request.headers) return request.url === `${origin}${path}`;
    // Next's self-hosted Proxy URL uses the listener address. The original
    // Cloud Run host stays in Host. Require the exact HTTPS path, with no suffix or credentials.
    const url = new URL(request.url);
    return request.headers.get('host') === new URL(origin).host
        && url.protocol === 'https:'
        && request.url === `${url.origin}${path}`;
}

/** A matched request still goes through the ordinary worker's OIDC and job fences. */
export function devLiveWorkerRequestBoundary(
    request: WorkerRequest,
    env: DeploymentEnvironment = process.env,
): 'not-worker' | 'dev-worker' | 'invalid' {
    const role = env.DEV_LIVE_WORKLOAD;
    if (role === undefined && !env.K_SERVICE?.startsWith('dev-live-')) return 'not-worker';
    if ((role !== 'preflight' && role !== 'paid') || env.K_SERVICE !== serviceName(role)
        || env.ANALYSIS_WORKLOAD_ROLE !== role || env.VERCEL === '1' || env.VERCEL_ENV
        || env.VERCEL_PROJECT_ID || !hasRegisteredDevWorkerDatabase(env)
        || request.method !== 'POST') return 'invalid';

    try {
        const identity = cloudIdentity(env);
        const approval = devLiveOwnerStartEnabled(env) ? DEV_LIVE_OWNER_CAPS : readDevLiveApproval(env);
        if (!approval || !matchesWorkerEndpoint(request, identity.origins[role], WORKER_ROUTES[role])) return 'invalid';
        assertLiveFlags(env);
        assertLiveWorkerPolicy(env, role, approval);
        assertStorage(env, identity.projectId, role);
        if (role === 'preflight') {
            if (env.ANALYSIS_V2_TASKS_ENABLED !== undefined && env.ANALYSIS_V2_TASKS_ENABLED !== 'false') reject();
            assertTaskConfig(getPreflightTasksConfig(env), role, identity, 'adc');
        } else {
            if (env.PREFLIGHT_TASKS_ENABLED !== undefined && env.PREFLIGHT_TASKS_ENABLED !== 'false') reject();
            assertTaskConfig(getAnalysisV2TasksConfig(env), role, identity, 'adc');
        }
        return 'dev-worker';
    } catch {
        return 'invalid';
    }
}
