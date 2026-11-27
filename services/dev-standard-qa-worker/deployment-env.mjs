import { pathToFileURL } from 'node:url';

const project = 'gen-lang-client-0311522474';
const projectNumber = '919163272964';
const location = 'asia-northeast3';

// References only, pinned to current Dev revisions. Resolving their payload is
// entirely the Cloud Run runtime's job. The preflight worker needs only two.
const commonRefs = {
    SUPABASE_SERVICE_ROLE_KEY: 'dev-live-supabase-service-role:1',
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: 'dev-live-preflight-identity-hmac:1',
};
const paidRefs = {
    ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET: 'dev-live-gender-routing-hmac:1',
    IMAGE_PROXY_SIGNING_SECRET: 'dev-live-image-proxy-signing:1',
    ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET: 'dev-live-image-object-hmac:1',
    ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID: 'dev-live-r2-writer-access-key-id:1',
    ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY: 'dev-live-r2-writer-secret-access-key:1',
};

export function qaWorkerDeployment(role, wave) {
    if (!['paid', 'preflight'].includes(role) || typeof wave !== 'string' || !/^[a-f0-9]{64}$/.test(wave))
        throw new Error('Expected a QA worker role and 64-character lowercase wave digest.');
    const paid = role === 'paid';
    const name = 'dev-standard-qa-' + role;
    const origin = 'https://' + name + '-' + projectNumber + '.' + location + '.run.app';
    const invoker = 'dev-live-' + role + '-invoker@' + project + '.iam.gserviceaccount.com';
    const p = paid ? 'ANALYSIS_V2_TASKS_' : 'PREFLIGHT_TASKS_';
    const environment = {
        GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: 'global',
        DEV_STANDARD_QA_PROJECT_NUMBER: projectNumber, DEV_STANDARD_QA_WAVE: wave, ANALYSIS_WORKLOAD_ROLE: role,
        NEXT_PUBLIC_SUPABASE_URL: 'https://bgamojfpkxnnumfvkron.supabase.co', NEXT_PUBLIC_APP_URL: 'https://dev.yeosachin.com',
        ANALYSIS_V2_ADMISSION_ENABLED: 'true', PREFLIGHT_ACCESS_MODE: 'production',
        ANALYSIS_V2_WORKER_ENABLED: String(paid), ANALYSIS_V2_TASKS_ENABLED: String(paid), PREFLIGHT_TASKS_ENABLED: String(!paid),
        PREFLIGHT_LOCAL_AFTER_ENABLED: 'false', PREFLIGHT_TASKS_RECOVERY_ENABLED: 'false', ANALYSIS_V2_RECOVERY_ENABLED: 'false',
        ANALYSIS_BETA_PREPARE_ENABLED: 'false', BETATEST_FREE_POOL_ENABLED: 'false',
        // The six-owner comparison explicitly disables optional precheckout B-lite.
        // Leave PREFLIGHT_PROFILE_PROVIDER unset to use the scoped synthetic profile
        // with the real preflight worker, without reserving shared Apify free credits.
        PRECHECKOUT_BLITE_ENABLED: 'false', PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
        ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1', SELFHOSTED_AUTH_ENABLED: 'false',
        SCRAPER_PROFILE: 'apify', SCRAPER_PROFILES_BATCH: 'apify', SCRAPER_FOLLOWERS: 'apify',
        SCRAPER_FOLLOWING: 'apify', SCRAPER_LIKERS: 'apify', SCRAPER_COMMENTS: 'apify', SCRAPER_FALLBACK: 'false',
        ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'secondary',
        PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', VERTEX_AI_BUDGET_GUARD_ENABLED: 'true', VERTEX_AI_BUDGET_STORE: 'supabase',
        // Current Dev ceilings. Never increase these to make an observation pass.
        VERTEX_AI_PER_RUN_BUDGET_USD: '2', VERTEX_AI_PER_ORDER_BUDGET_USD: '2', VERTEX_AI_DAILY_BUDGET_USD: '2',
        APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION: '1.50', APIFY_COMMENTS_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.30',
        APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION: '2.00', APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION: '2.00',
        APIFY_RELATIONSHIP_BUILD: '0.0.96', APIFY_COMMENTS_BUILD: '0.0.682',
        ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: project + '-dev-live-media',
        ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: project + '-dev-live-results',
        ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: 'https://2865ea5814615cc946f579ba9d5d0580.r2.cloudflarestorage.com',
        ANALYSIS_V2_RESULT_IMAGES_ENABLED: String(paid), ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'false',
        ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT: 'off', ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT: 'production',
        ANALYSIS_V2_NARRATIVE_V28_ROLLOUT: 'production', ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT: 'production',
        ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT: 'production', ANALYSIS_V2_AI_SCHEDULER_ROLLOUT: 'production',
        [p + 'PROJECT']: project, [p + 'LOCATION']: location, [p + 'QUEUE']: name,
        [p + 'SERVICE_ACCOUNT_EMAIL']: invoker, [p + 'CALLER_AUTH_MODE']: 'adc', [p + 'OIDC_AUDIENCE']: origin,
        [p + 'TARGET_URL']: origin + '/api/analysis/' + (paid ? 'v2' : 'preflight') + '/worker',
        ...(paid ? { PAID_STANDARD_PROCESS_FEATURE_SLOTS: '4', PAID_STANDARD_VERTEX_CAPACITY_MODE: 'expanded128' } : {}),
    };
    return { environment, secretRefs: { ...commonRefs, ...(paid ? paidRefs : {}) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [role, section] = process.argv.slice(2);
    if (process.argv.length !== 4 || !['environment', 'secretRefs'].includes(section))
        throw new Error('Usage: deployment-env.mjs paid|preflight environment|secretRefs');
    console.log(JSON.stringify(qaWorkerDeployment(role, process.env.DEV_STANDARD_QA_WAVE)[section], null, 2));
}
