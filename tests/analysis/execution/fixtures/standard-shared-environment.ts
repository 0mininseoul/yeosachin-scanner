import { vi } from 'vitest';
import { APIFY_CREDENTIAL_TOKEN_ENV, APIFY_FREE_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';

// The runner inherits no account, DB or cloud credentials. Never load local environment files.
export function configureSharedStandard() {
    const env: Record<string, string> = {
        NEXT_PUBLIC_APP_URL: 'https://fixture.invalid',
        VERTEX_AI_BUDGET_GUARD_ENABLED: 'true',
        VERTEX_AI_BUDGET_STORE: 'supabase',
        GOOGLE_CLOUD_PROJECT: 'fixture-project',
        ANALYSIS_V2_ADMISSION_ENABLED: 'true',
        ANALYSIS_V2_WORKER_ENABLED: 'true',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
        ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1',
        ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true',
        ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: 'test-fixture-assets',
        ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
        ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID: 'local-fixture',
        ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY: 'local-fixture',
        IMAGE_PROXY_SIGNING_SECRET: 'synthetic-signing-only-'.repeat(3),
        ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET: 'fixture-object-'.repeat(3),
        ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: Buffer.alloc(32, 41).toString('base64'),
        PREFLIGHT_PROFILE_PROVIDER: 'apify_pool',
        PREFLIGHT_APIFY_API_TOKEN_SLOTS: APIFY_FREE_CREDENTIAL_SLOTS.join(','),
        ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'secondary',
        PRECHECKOUT_BLITE_ENABLED: 'false',
        PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
        SCRAPER_FOLLOWERS: 'apify',
        SCRAPER_FOLLOWING: 'apify',
    };
    for (const name of Object.values(APIFY_CREDENTIAL_TOKEN_ENV)) env[name] = 'offline-fixture';
    for (const stage of ['GENDER_RESOLUTION', 'NARRATIVE_V28', 'AI_MICROBATCH_V29', 'GENDER_SUMMARY_QUALITY_V211', 'AI_SCHEDULER']) {
        env['ANALYSIS_V2_' + stage + '_ROLLOUT'] = 'production';
    }
    for (const [prefix, path] of [['PREFLIGHT', 'preflight'], ['ANALYSIS_V2', 'v2']]) {
        const settings = {
            CALLER_AUTH_MODE: 'adc', ENABLED: 'true', PROJECT: 'fixture-project', LOCATION: 'asia-northeast3',
            QUEUE: 'fixture-' + path, SERVICE_ACCOUNT_EMAIL: 'fixture@fixture-project.iam.gserviceaccount.com',
            TARGET_URL: 'https://fixture.invalid/api/analysis/' + path + '/worker', OIDC_AUDIENCE: 'https://fixture.invalid'
        };
        for (const [key, value] of Object.entries(settings)) env[prefix + '_TASKS_' + key] = value;
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}
