import { dbOrigin, number, origin, project, region, service, taskPath, type QaRole } from './scope';
import { APIFY_CREDENTIAL_TOKEN_ENV } from '@/lib/services/instagram/providers/types';

export const placeholder = 'synthetic-dev-cloud-six';
export function qaWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
    const fail = (): never => { throw new Error('DEV_STANDARD_QA_WORKER_CONFIG_REJECTED'); };
    const role = env.ANALYSIS_WORKLOAD_ROLE;
    if (role !== 'paid' && role !== 'preflight') return fail();
    if (env.K_SERVICE !== service(role) || !env.K_REVISION?.startsWith(service(role) + '-') || env.NODE_ENV !== 'production'
        || env.GOOGLE_CLOUD_PROJECT !== project || env.DEV_STANDARD_QA_PROJECT_NUMBER !== number || env.CLOUD_RUN_JOB
        || env.VERCEL_PROJECT_ID || env.DEV_LIVE_WORKLOAD || env.DEPLOYMENT_ROLE === 'production'
        || env.NEXT_PUBLIC_SUPABASE_URL !== dbOrigin || (env.GOOGLE_CLOUD_QUOTA_PROJECT && env.GOOGLE_CLOUD_QUOTA_PROJECT !== project)
        || env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64
        || !/^[a-f0-9]{64}$/.test(env.DEV_STANDARD_QA_WAVE ?? '')) return fail();
    const envFlags: Record<string, string> = {
        [role === 'paid' ? 'ANALYSIS_V2_TASKS_ENABLED' : 'PREFLIGHT_TASKS_ENABLED']: 'true',
        ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1', SCRAPER_PROFILE: 'apify', SCRAPER_PROFILES_BATCH: 'apify',
        SCRAPER_FOLLOWERS: 'apify', SCRAPER_FOLLOWING: 'apify', SCRAPER_FALLBACK: 'false',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', VERTEX_AI_BUDGET_GUARD_ENABLED: 'true', VERTEX_AI_BUDGET_STORE: 'supabase',
        ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: project + '-dev-live-media',
        ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: project + '-dev-live-results',
    };
    if (role === 'paid') Object.assign(envFlags, {
        PAID_STANDARD_VERTEX_CAPACITY_MODE: 'expanded128', PAID_STANDARD_PROCESS_FEATURE_SLOTS: '4',
        ANALYSIS_V2_WORKER_ENABLED: 'true', ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true',
    });
    for (const r of ['preflight', 'paid'] as const) {
        const p = r === 'paid' ? 'ANALYSIS_V2_TASKS_' : 'PREFLIGHT_TASKS_';
        if (r !== role && env[p + 'ENABLED'] !== 'true') continue;
        for (const [key, value] of Object.entries({
            PROJECT: project, LOCATION: region, QUEUE: service(r), SERVICE_ACCOUNT_EMAIL: 'dev-live-' + r + '-invoker@' + project + '.iam.gserviceaccount.com',
            CALLER_AUTH_MODE: 'adc', TARGET_URL: origin(r) + taskPath(r), OIDC_AUDIENCE: origin(r),
        })) envFlags[p + key] = value;
    }
    if (Object.entries(envFlags).some(([name, value]) => env[name] !== value)) return fail();
    const endpoint = env.ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT;
    if (!endpoint || !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint)) return fail();
    if (Object.keys(env).some(key => /^(?:STABLE_RAPIDAPI_KEY|RAPIDAPI_KEY|FLASHAPI_RAPIDAPI_KEY|IG_SESSIONS|RESEND_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|HTTPS?_PROXY|ALL_PROXY)$/i.test(key)
        && env[key])) return fail();
    for (const key of [...Object.values(APIFY_CREDENTIAL_TOKEN_ENV), 'APIFY_API_TOKEN'])
        if (env[key] !== undefined && env[key] !== placeholder) return fail();
    return { role: role as QaRole, wave: env.DEV_STANDARD_QA_WAVE!, r2Host: new URL(endpoint).hostname };
}

/** Check current Cloud Run metadata; only project and machine identity are read. */
export async function assertQaCloudIdentity(role: QaRole, transport = fetch) {
    const check = async (path: string, expected: string) => {
        const response = await transport('http://metadata.google.internal/computeMetadata/v1/' + path, {
            headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000), redirect: 'error',
        });
        if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google' || (await response.text()).trim() !== expected)
            throw new Error('DEV_STANDARD_QA_CLOUD_IDENTITY_REJECTED');
    };
    await Promise.all([
        check('project/project-id', project), check('project/numeric-project-id', number),
        check('instance/service-accounts/default/email', 'dev-live-' + role + '@' + project + '.iam.gserviceaccount.com'),
    ]);
}
