import { OAuth2Client } from 'google-auth-library';

const SERVICE_ACCOUNT_PATTERN =
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export interface AnalysisV2MaintenanceAuthConfig {
    oidcAudience: string;
    serviceAccountEmail: string;
}

type MaintenanceAuthEnvironment =
    | 'ANALYSIS_V2'
    | 'PREFLIGHT_TASKS';

interface IdTokenTicketLike {
    getPayload(): {
        email?: string;
        email_verified?: boolean;
    } | undefined;
}

interface IdTokenVerifierLike {
    verifyIdToken(options: {
        idToken: string;
        audience: string;
    }): PromiseLike<IdTokenTicketLike>;
}

let sharedVerifier: OAuth2Client | undefined;

function getMaintenanceAuthConfig(
    env: Record<string, string | undefined>,
    environment: MaintenanceAuthEnvironment,
): AnalysisV2MaintenanceAuthConfig {
    const prefix = environment === 'ANALYSIS_V2'
        ? 'ANALYSIS_V2_MAINTENANCE'
        : 'PREFLIGHT_TASKS_MAINTENANCE';
    const serviceAccountEmail = (
        env[`${prefix}_SERVICE_ACCOUNT_EMAIL`] ?? ''
    ).trim().toLowerCase();
    if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) {
        throw new Error(`${environment}_MAINTENANCE_CONFIG_ERROR: invalid service account.`);
    }

    let audience: URL;
    try {
        audience = new URL(env[`${prefix}_OIDC_AUDIENCE`] ?? '');
    } catch {
        throw new Error(`${environment}_MAINTENANCE_CONFIG_ERROR: invalid OIDC audience.`);
    }
    if (
        audience.protocol !== 'https:'
        || audience.username
        || audience.password
        || audience.port
        || audience.pathname !== '/'
        || audience.search
        || audience.hash
    ) {
        throw new Error(`${environment}_MAINTENANCE_CONFIG_ERROR: invalid OIDC audience.`);
    }

    return Object.freeze({
        oidcAudience: audience.origin,
        serviceAccountEmail,
    });
}

export function getAnalysisV2MaintenanceAuthConfig(
    env: Record<string, string | undefined> = process.env
): AnalysisV2MaintenanceAuthConfig {
    return getMaintenanceAuthConfig(env, 'ANALYSIS_V2');
}

export function getPreflightMaintenanceAuthConfig(
    env: Record<string, string | undefined> = process.env
): AnalysisV2MaintenanceAuthConfig {
    return getMaintenanceAuthConfig(env, 'PREFLIGHT_TASKS');
}

export async function verifyAnalysisV2MaintenanceAuthorization(
    authorization: string | null,
    options: {
        config?: AnalysisV2MaintenanceAuthConfig;
        verifier?: IdTokenVerifierLike;
    } = {}
): Promise<boolean> {
    if (!authorization?.startsWith('Bearer ')) return false;
    const idToken = authorization.slice('Bearer '.length).trim();
    if (!idToken) return false;

    const config = options.config ?? getAnalysisV2MaintenanceAuthConfig();
    const verifier = options.verifier ?? (sharedVerifier ??= new OAuth2Client());
    try {
        const ticket = await verifier.verifyIdToken({
            idToken,
            audience: config.oidcAudience,
        });
        const payload = ticket.getPayload();
        return payload?.email_verified === true
            && payload.email?.toLowerCase() === config.serviceAccountEmail;
    } catch {
        return false;
    }
}
