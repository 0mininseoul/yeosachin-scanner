import { OAuth2Client } from 'google-auth-library';

const SERVICE_ACCOUNT_PATTERN =
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export interface AnalysisV2MaintenanceAuthConfig {
    oidcAudience: string;
    serviceAccountEmail: string;
}

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

export function getAnalysisV2MaintenanceAuthConfig(
    env: Record<string, string | undefined> = process.env
): AnalysisV2MaintenanceAuthConfig {
    const serviceAccountEmail = (
        env.ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL ?? ''
    ).trim().toLowerCase();
    if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) {
        throw new Error('ANALYSIS_V2_MAINTENANCE_CONFIG_ERROR: invalid service account.');
    }

    let audience: URL;
    try {
        audience = new URL(env.ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE ?? '');
    } catch {
        throw new Error('ANALYSIS_V2_MAINTENANCE_CONFIG_ERROR: invalid OIDC audience.');
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
        throw new Error('ANALYSIS_V2_MAINTENANCE_CONFIG_ERROR: invalid OIDC audience.');
    }

    return Object.freeze({
        oidcAudience: audience.origin,
        serviceAccountEmail,
    });
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
