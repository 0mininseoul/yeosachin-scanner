import { describe, expect, it, vi } from 'vitest';
import {
    createVercelWifAuthClient,
    createVercelWifGoogleAuth,
    getCloudTasksCallerAuthConfig,
    type VercelWifConfig,
} from './vercel-wif';

const projectId = 'example-project';
const providerResource =
    'projects/123456789012/locations/global/workloadIdentityPools/'
    + 'vercel-production/providers/ai-baram-detector';
const enqueuerEmail =
    'analysis-v2-enqueuer@example-project.iam.gserviceaccount.com';

function resolve(
    env: Record<string, string | undefined>
) {
    return getCloudTasksCallerAuthConfig({
        env,
        projectId,
        modeKey: 'ANALYSIS_V2_TASKS_CALLER_AUTH_MODE',
        enqueuerServiceAccountEmailKey:
            'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
        errorPrefix: 'TEST_CONFIG_ERROR',
    });
}

function wifEnv(): Record<string, string> {
    return {
        ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'vercel-wif',
        ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: enqueuerEmail,
        GCP_VERCEL_WIF_PROVIDER_RESOURCE: providerResource,
    };
}

describe('Vercel to Google Cloud workload identity federation', () => {
    it('requires an explicit caller mode and returns bounded ADC configuration', () => {
        expect(() => resolve({})).toThrow(
            'ANALYSIS_V2_TASKS_CALLER_AUTH_MODE must be adc or vercel-wif'
        );
        expect(resolve({
            ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'adc',
        })).toEqual({ mode: 'adc', projectId });
    });

    it('builds distinct canonical audiences from one provider resource', () => {
        expect(resolve(wifEnv())).toEqual({
            mode: 'vercel-wif',
            projectId,
            providerResource,
            stsAudience: `//iam.googleapis.com/${providerResource}`,
            oidcTokenAudience: `https://iam.googleapis.com/${providerResource}`,
            enqueuerServiceAccountEmail: enqueuerEmail,
            serviceAccountImpersonationUrl:
                'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
                + `${enqueuerEmail}:generateAccessToken`,
        });
        expect(() => resolve({
            ...wifEnv(),
            GCP_VERCEL_WIF_PROVIDER_RESOURCE:
                `https://iam.googleapis.com/${providerResource}`,
        })).toThrow('canonical provider resource');
    });

    it('keeps the enqueuer in the configured task project', () => {
        expect(() => resolve({
            ...wifEnv(),
            ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL:
                'analysis-v2-enqueuer@other-project.iam.gserviceaccount.com',
        })).toThrow('must belong to the task project');
    });

    it('enforces Vercel WIF and Cloud Run attached ADC placement', () => {
        expect(() => resolve({
            ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'adc',
            VERCEL: '1',
            VERCEL_ENV: 'production',
        })).toThrow('Vercel must use vercel-wif');
        expect(() => resolve({
            ...wifEnv(),
            K_SERVICE: 'analysis-worker',
        })).toThrow('Cloud Run must use attached ADC');
        expect(resolve({
            ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'adc',
            K_SERVICE: 'analysis-worker',
        })).toEqual({ mode: 'adc', projectId });
    });

    it('retrieves the custom-audience token lazily and never substitutes STS audience', async () => {
        const config = resolve(wifEnv()) as VercelWifConfig;
        const tokenProvider = vi.fn(async () => 'header.payload.signature');
        const authClient = createVercelWifAuthClient(config, tokenProvider);

        expect(tokenProvider).not.toHaveBeenCalled();
        expect(authClient.getServiceAccountEmail()).toBe(enqueuerEmail);
        await expect(authClient.retrieveSubjectToken())
            .resolves.toBe('header.payload.signature');
        expect(tokenProvider).toHaveBeenCalledOnce();
        expect(tokenProvider).toHaveBeenCalledWith({
            audience: `https://iam.googleapis.com/${providerResource}`,
        });
    });

    it('rejects a malformed token without exposing it and wraps the client for google-gax', async () => {
        const config = resolve(wifEnv()) as VercelWifConfig;
        const invalidProvider = vi.fn(async () => 'not-a-jwt');
        const authClient = createVercelWifAuthClient(config, invalidProvider);
        await expect(authClient.retrieveSubjectToken()).rejects.toThrow(
            'Vercel returned an invalid OIDC token'
        );

        const auth = createVercelWifGoogleAuth(
            config,
            vi.fn(async () => 'header.payload.signature')
        );
        expect(auth.cachedCredential).toBeTruthy();
        expect(auth.cachedCredential).toMatchObject({
            getServiceAccountEmail: expect.any(Function),
        });
        expect(
            (auth.cachedCredential as ReturnType<typeof createVercelWifAuthClient>)
                .getServiceAccountEmail()
        ).toBe(enqueuerEmail);
    });

    it('reuses a valid Google access token without repeating the OIDC exchange', async () => {
        const config = resolve(wifEnv()) as VercelWifConfig;
        const tokenProvider = vi.fn(async () => 'header.payload.signature');
        const authClient = createVercelWifAuthClient(config, tokenProvider);
        authClient.setCredentials({
            access_token: 'cached-google-access-token',
            expiry_date: Date.now() + 60 * 60 * 1_000,
        });

        await expect(authClient.getAccessToken()).resolves.toMatchObject({
            token: 'cached-google-access-token',
        });
        await expect(authClient.getAccessToken()).resolves.toMatchObject({
            token: 'cached-google-access-token',
        });
        expect(tokenProvider).not.toHaveBeenCalled();
    });
});
