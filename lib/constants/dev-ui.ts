import deploymentRegistry from '../../config/dev-ui-deployment.json';

export const DEV_UI_APP_ORIGIN = 'https://dev.yeosachin.com';
export const DEV_UI_DEPLOYMENT_REJECTED = 'DEV_UI_DEPLOYMENT_REJECTED';
export const DEV_UI_ROBOTS_HEADER = 'noindex, nofollow, noarchive';

export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

export interface DevUiDeploymentIdentity {
    vercelProjectId: string;
    supabaseProjectRef: string;
}

export interface DevUiDeploymentRegistry {
    version: 1;
    deployments: readonly DevUiDeploymentIdentity[];
}

// Read dynamic keys, as the lazy admin client does. DefinePlugin also follows
// simple process.env aliases, so a static property access is insufficient.
export function deploymentEnvironment(): DeploymentEnvironment {
    const names = [
        'DEPLOYMENT_ROLE', 'NEXT_PUBLIC_DEPLOYMENT_ROLE', 'VERCEL_PROJECT_ID',
        'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_APP_URL', 'NODE_ENV',
    ];
    return Object.fromEntries(names.map(name => [name, process.env[name]]));
}

// Public build values support browser presentation/OAuth links. They cannot
// supply the private deployment role or the actual server project identity.
export function browserDeploymentEnvironment(): DeploymentEnvironment {
    return {
        NEXT_PUBLIC_DEPLOYMENT_ROLE: process.env.NEXT_PUBLIC_DEPLOYMENT_ROLE,
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    };
}

function registeredDeployments(): readonly DevUiDeploymentIdentity[] {
    const registry = deploymentRegistry as unknown as DevUiDeploymentRegistry;
    if (!registry || registry.version !== 1 || !Array.isArray(registry.deployments)) return [];
    return registry.deployments.filter(entry => (
        typeof entry?.vercelProjectId === 'string'
        && /^prj_[A-Za-z0-9_]+$/.test(entry.vercelProjectId)
        && typeof entry.supabaseProjectRef === 'string'
        && /^[a-z0-9]+$/.test(entry.supabaseProjectRef)
    ));
}

function supabaseOrigin(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:' || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
}

/** A pure policy shared by link construction and the server-only request guard. */
export function registeredDevUiDeployment(
    environment: DeploymentEnvironment = deploymentEnvironment(),
): DevUiDeploymentIdentity | null {
    if (environment.DEPLOYMENT_ROLE !== 'dev') return null;
    const databaseOrigin = supabaseOrigin(environment.NEXT_PUBLIC_SUPABASE_URL);
    return registeredDeployments().find(entry => (
        environment.VERCEL_PROJECT_ID === entry.vercelProjectId
        && databaseOrigin === `https://${entry.supabaseProjectRef}.supabase.co`
    )) ?? null;
}

/** A mistaken/missing role must not make a registered Dev project act as production. */
export function isDevUiDeploymentContext(
    environment: DeploymentEnvironment = deploymentEnvironment(),
): boolean {
    return environment.DEPLOYMENT_ROLE === 'dev'
        || environment.NEXT_PUBLIC_DEPLOYMENT_ROLE === 'dev'
        || registeredDeployments().some(entry => (
            environment.VERCEL_PROJECT_ID === entry.vercelProjectId
            || supabaseOrigin(environment.NEXT_PUBLIC_SUPABASE_URL) === `https://${entry.supabaseProjectRef}.supabase.co`
        ));
}

export function isDevUiPresentation(): boolean {
    return process.env.NEXT_PUBLIC_DEPLOYMENT_ROLE === 'dev';
}

export function isDevUiTelemetryDisabled(
    environment: DeploymentEnvironment = typeof window === 'undefined'
        ? deploymentEnvironment()
        : browserDeploymentEnvironment(),
): boolean {
    return isDevUiDeploymentContext(environment)
        || (typeof window !== 'undefined' && window.location?.origin === DEV_UI_APP_ORIGIN);
}

export function isDevUiRequestOrigin(requestUrl: string): boolean {
    try {
        const url = new URL(requestUrl);
        return url.origin === DEV_UI_APP_ORIGIN && !url.username && !url.password;
    } catch {
        return false;
    }
}
