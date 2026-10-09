import {
    DEV_UI_APP_ORIGIN,
    DEV_UI_DEPLOYMENT_REJECTED,
    browserDeploymentEnvironment,
    deploymentEnvironment,
    isDevUiDeploymentContext,
    isDevUiRequestOrigin,
    registeredDevUiDeployment,
    type DeploymentEnvironment,
} from './dev-ui';

export const CANONICAL_APP_ORIGIN = 'https://yeosachin.com';
export const DEFAULT_APP_REDIRECT_PATH = '/analyze';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const UNSAFE_REDIRECT_CHARACTERS = /[\\\u0000-\u001f\u007f]/;
const MAX_REDIRECT_DECODE_ROUNDS = 4;

function requestDeploymentEnvironment(): DeploymentEnvironment {
    return typeof window === 'undefined' ? deploymentEnvironment() : browserDeploymentEnvironment();
}

function loopbackOrigin(rawUrl: string): string | null {
    try {
        const url = new URL(rawUrl);
        if (
            !LOOPBACK_HOSTNAMES.has(url.hostname)
            || (url.protocol !== 'http:' && url.protocol !== 'https:')
            || url.username
            || url.password
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}

export function appOriginForRequest(
    requestUrl: string,
    environment: DeploymentEnvironment = requestDeploymentEnvironment(),
): string {
    if (typeof window !== 'undefined' && environment.NEXT_PUBLIC_DEPLOYMENT_ROLE === 'dev') {
        if (!isDevUiRequestOrigin(requestUrl)) throw new Error(DEV_UI_DEPLOYMENT_REJECTED);
        return DEV_UI_APP_ORIGIN;
    }
    if (isDevUiDeploymentContext(environment)) {
        if (!registeredDevUiDeployment(environment) || !isDevUiRequestOrigin(requestUrl)) {
            throw new Error(DEV_UI_DEPLOYMENT_REJECTED);
        }
        return DEV_UI_APP_ORIGIN;
    }
    return loopbackOrigin(requestUrl) ?? CANONICAL_APP_ORIGIN;
}

function hasUnsafeRedirectSyntax(rawPath: string): boolean {
    let decoded = rawPath;

    for (let round = 0; round < MAX_REDIRECT_DECODE_ROUNDS; round += 1) {
        if (
            !decoded.startsWith('/')
            || decoded.startsWith('//')
            || UNSAFE_REDIRECT_CHARACTERS.test(decoded)
        ) {
            return true;
        }

        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) return false;
            decoded = next;
        } catch {
            return true;
        }
    }

    // Nested encodings that still change after several passes are ambiguous.
    return true;
}

export function appRedirectUrlForRequest(
    requestUrl: string,
    rawPath: string | null | undefined,
    environment: DeploymentEnvironment = requestDeploymentEnvironment(),
): URL {
    const appOrigin = appOriginForRequest(requestUrl, environment);
    const fallbackUrl = new URL(DEFAULT_APP_REDIRECT_PATH, appOrigin);
    if (!rawPath || hasUnsafeRedirectSyntax(rawPath)) return fallbackUrl;

    try {
        const redirectUrl = new URL(rawPath, appOrigin);
        return redirectUrl.origin === appOrigin ? redirectUrl : fallbackUrl;
    } catch {
        return fallbackUrl;
    }
}

export function appOriginForServer(
    env: DeploymentEnvironment = deploymentEnvironment(),
): string {
    if (isDevUiDeploymentContext(env)) {
        if (!registeredDevUiDeployment(env)) throw new Error(DEV_UI_DEPLOYMENT_REJECTED);
        return DEV_UI_APP_ORIGIN;
    }
    if (env.NODE_ENV !== 'production') {
        const localOrigin = loopbackOrigin(env.NEXT_PUBLIC_APP_URL ?? '');
        if (localOrigin) return localOrigin;
    }
    return CANONICAL_APP_ORIGIN;
}
