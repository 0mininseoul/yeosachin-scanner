import { getVercelOidcToken } from '@vercel/oidc';
import { GoogleAuth, googleAuthLibrary } from 'google-gax';
import type {
    ExternalAccountSupplierContext,
    SubjectTokenSupplier,
} from 'google-auth-library';

const { IdentityPoolClient } = googleAuthLibrary;
type GaxIdentityPoolClient = InstanceType<typeof IdentityPoolClient>;

export const GOOGLE_CLOUD_PLATFORM_SCOPE =
    'https://www.googleapis.com/auth/cloud-platform';
export const GOOGLE_EXTERNAL_ACCOUNT_JWT_TYPE =
    'urn:ietf:params:oauth:token-type:jwt';

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SERVICE_ACCOUNT_PATTERN =
    /^[a-z0-9-]{1,63}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const PROVIDER_RESOURCE_PATTERN =
    /^projects\/(\d{6,20})\/locations\/global\/workloadIdentityPools\/([a-z](?:[a-z0-9-]{2,30}[a-z0-9]))\/providers\/([a-z](?:[a-z0-9-]{2,30}[a-z0-9]))$/;

export type CloudTasksCallerAuthMode = 'adc' | 'vercel-wif';

export type CloudTasksCallerAuthConfig =
    | Readonly<{
        mode: 'adc';
        projectId: string;
    }>
    | VercelWifConfig;

export interface VercelWifConfig {
    readonly mode: 'vercel-wif';
    readonly projectId: string;
    readonly providerResource: string;
    readonly stsAudience: string;
    readonly oidcTokenAudience: string;
    readonly enqueuerServiceAccountEmail: string;
    readonly serviceAccountImpersonationUrl: string;
}

type CallerAuthConfigOptions = {
    env: Record<string, string | undefined>;
    projectId: string;
    modeKey: string;
    enqueuerServiceAccountEmailKey: string;
    errorPrefix: string;
};

export type VercelOidcTokenProvider = (
    options: { audience: string }
) => Promise<string>;

function configError(prefix: string, message: string): never {
    throw new Error(`${prefix}: ${message}`);
}

function validateRuntimePlacement(
    mode: CloudTasksCallerAuthMode,
    env: Record<string, string | undefined>,
    errorPrefix: string
): void {
    const isVercel = env.VERCEL === '1' || Boolean(env.VERCEL_ENV);
    const isCloudRun = Boolean(env.K_SERVICE);
    if (isVercel && isCloudRun) {
        configError(errorPrefix, 'Vercel and Cloud Run runtime markers conflict.');
    }
    if (isVercel && mode !== 'vercel-wif') {
        configError(errorPrefix, 'Vercel must use vercel-wif caller authentication.');
    }
    if (isCloudRun && mode !== 'adc') {
        configError(errorPrefix, 'Cloud Run must use attached ADC caller authentication.');
    }
}

/**
 * Resolves an explicit Cloud Tasks caller identity without touching process-wide ADC.
 */
export function getCloudTasksCallerAuthConfig({
    env,
    projectId,
    modeKey,
    enqueuerServiceAccountEmailKey,
    errorPrefix,
}: CallerAuthConfigOptions): CloudTasksCallerAuthConfig {
    if (!PROJECT_PATTERN.test(projectId)) {
        configError(errorPrefix, 'invalid Google Cloud project ID.');
    }

    const mode = env[modeKey]?.trim().toLowerCase();
    if (mode !== 'adc' && mode !== 'vercel-wif') {
        configError(errorPrefix, `${modeKey} must be adc or vercel-wif.`);
    }
    validateRuntimePlacement(mode, env, errorPrefix);

    if (mode === 'adc') {
        return Object.freeze({ mode, projectId });
    }

    const providerResource = (
        env.GCP_VERCEL_WIF_PROVIDER_RESOURCE ?? ''
    ).trim();
    if (!PROVIDER_RESOURCE_PATTERN.test(providerResource)) {
        configError(
            errorPrefix,
            'GCP_VERCEL_WIF_PROVIDER_RESOURCE must be a canonical provider resource.'
        );
    }

    const enqueuerServiceAccountEmail = (
        env[enqueuerServiceAccountEmailKey] ?? ''
    ).trim().toLowerCase();
    if (!SERVICE_ACCOUNT_PATTERN.test(enqueuerServiceAccountEmail)) {
        configError(
            errorPrefix,
            `${enqueuerServiceAccountEmailKey} must be a valid service account email.`
        );
    }
    const enqueuerProject = enqueuerServiceAccountEmail
        .split('@')[1]
        ?.replace(/\.iam\.gserviceaccount\.com$/, '');
    if (enqueuerProject !== projectId) {
        configError(errorPrefix, 'the WIF enqueuer must belong to the task project.');
    }

    const stsAudience = `//iam.googleapis.com/${providerResource}`;
    const oidcTokenAudience = `https://iam.googleapis.com/${providerResource}`;
    const serviceAccountImpersonationUrl =
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
        + `${enqueuerServiceAccountEmail}:generateAccessToken`;

    return Object.freeze({
        mode,
        projectId,
        providerResource,
        stsAudience,
        oidcTokenAudience,
        enqueuerServiceAccountEmail,
        serviceAccountImpersonationUrl,
    });
}

class VercelOidcSubjectTokenSupplier implements SubjectTokenSupplier {
    constructor(
        private readonly config: VercelWifConfig,
        private readonly tokenProvider: VercelOidcTokenProvider
    ) {}

    async getSubjectToken(context: ExternalAccountSupplierContext): Promise<string> {
        if (
            context.audience !== this.config.stsAudience
            || context.subjectTokenType !== GOOGLE_EXTERNAL_ACCOUNT_JWT_TYPE
        ) {
            throw new Error('VERCEL_WIF_TOKEN_ERROR: external account context mismatch.');
        }
        const token = await this.tokenProvider({
            audience: this.config.oidcTokenAudience,
        });
        if (!token || token.split('.').length !== 3) {
            throw new Error('VERCEL_WIF_TOKEN_ERROR: Vercel returned an invalid OIDC token.');
        }
        return token;
    }
}

/** Constructs the external account client without retrieving an OIDC token. */
export function createVercelWifAuthClient(
    config: VercelWifConfig,
    tokenProvider: VercelOidcTokenProvider = getVercelOidcToken
): GaxIdentityPoolClient {
    return new IdentityPoolClient({
        type: 'external_account',
        audience: config.stsAudience,
        subject_token_type: GOOGLE_EXTERNAL_ACCOUNT_JWT_TYPE,
        token_url: 'https://sts.googleapis.com/v1/token',
        service_account_impersonation_url: config.serviceAccountImpersonationUrl,
        scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
        subject_token_supplier: new VercelOidcSubjectTokenSupplier(
            config,
            tokenProvider
        ),
    });
}

/** Wraps the federated auth client in the GoogleAuth shape expected by google-gax. */
export function createVercelWifGoogleAuth(
    config: VercelWifConfig,
    tokenProvider: VercelOidcTokenProvider = getVercelOidcToken
): GoogleAuth {
    const authClient = createVercelWifAuthClient(config, tokenProvider);
    return new GoogleAuth({
        authClient,
        projectId: config.projectId,
        scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
    });
}
