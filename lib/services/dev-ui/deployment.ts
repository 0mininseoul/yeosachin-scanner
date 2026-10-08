import 'server-only';

import {
    DEV_UI_APP_ORIGIN,
    DEV_UI_DEPLOYMENT_REJECTED,
    browserDeploymentEnvironment,
    deploymentEnvironment,
    isDevUiDeploymentContext,
    isDevUiRequestOrigin,
    registeredDevUiDeployment,
    type DeploymentEnvironment,
    type DevUiDeploymentIdentity,
} from '@/lib/constants/dev-ui';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const DEV_API_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
    { method: 'POST', path: /^\/api\/analysis\/preflight$/ },
    { method: 'GET', path: /^\/api\/analysis\/preflight$/ },
    { method: 'GET', path: new RegExp(`^/api/analysis/preflight/${UUID}$`, 'i') },
    { method: 'POST', path: /^\/api\/earlybird\/checkout$/ },
    { method: 'GET', path: new RegExp(`^/api/analysis/v2/progress/${UUID}$`, 'i') },
    { method: 'GET', path: new RegExp(`^/api/analysis/v2/result/${UUID}$`, 'i') },
    { method: 'GET', path: new RegExp(`^/api/dev-ui/checkout/${UUID}$`, 'i') },
    { method: 'POST', path: new RegExp(`^/api/dev-ui/checkout/${UUID}$`, 'i') },
    { method: 'GET', path: /^\/api\/dev-ui\/orders$/ },
    { method: 'GET', path: /^\/api\/user\/me$/ },
    { method: 'POST', path: /^\/api\/auth\/signout$/ },
    { method: 'GET', path: /^\/api\/admin\/analysis-audit$/ },
    { method: 'GET', path: /^\/api\/admin\/order-audit$/ },
    { method: 'GET', path: new RegExp(`^/api/admin/order-audit/${UUID}$`, 'i') },
];

export class DevUiDeploymentError extends Error {
    readonly code = DEV_UI_DEPLOYMENT_REJECTED;

    constructor() {
        super(DEV_UI_DEPLOYMENT_REJECTED);
        this.name = 'DevUiDeploymentError';
    }
}

function canonicalDevUiPathname(pathname: string): boolean {
    // Next's production filesystem resolver also tries decodeURIComponent.
    // Dev routes are ASCII contracts: reject encoded/doubled separators or
    // names instead of letting a later router reinterpret the allowlist.
    return pathname.startsWith('/') && !/[%\\\u0000-\u001f\u007f]/.test(pathname) && !pathname.includes('//');
}

function matchesServerClientBuild(environment: DeploymentEnvironment): boolean {
    // SSR Auth clients use the compiled public URL while admin reads runtime
    // env. Both must target the same approved project before either can run.
    const builtUrl = browserDeploymentEnvironment().NEXT_PUBLIC_SUPABASE_URL;
    const runtimeUrl = environment.NEXT_PUBLIC_SUPABASE_URL;
    return Boolean(builtUrl && runtimeUrl && builtUrl.replace(/\/$/, '') === runtimeUrl.replace(/\/$/, ''));
}

export function isDevUiDeployment(
    environment: DeploymentEnvironment = deploymentEnvironment(),
): boolean {
    return registeredDevUiDeployment(environment) !== null && matchesServerClientBuild(environment);
}

export function assertDevUiDeployment(
    request?: Pick<Request, 'url'>,
    environment: DeploymentEnvironment = deploymentEnvironment(),
): DevUiDeploymentIdentity {
    const identity = registeredDevUiDeployment(environment);
    if (!identity || !matchesServerClientBuild(environment)
        || (request && (!isDevUiRequestOrigin(request.url) || !canonicalDevUiPathname(new URL(request.url).pathname)))) {
        throw new DevUiDeploymentError();
    }
    return identity;
}

export type DevUiRequestBoundary = 'production' | 'dev' | 'invalid' | 'forbidden';

/** Run before auth/provider/DB clients; handlers repeat assertDevUiDeployment. */
export function devUiRequestBoundary(
    request: Pick<Request, 'url' | 'method'>,
    environment: DeploymentEnvironment = deploymentEnvironment(),
): DevUiRequestBoundary {
    const url = new URL(request.url);
    const isDevHost = url.hostname === new URL(DEV_UI_APP_ORIGIN).hostname;
    if (!isDevUiDeploymentContext(environment) && !isDevHost) return 'production';
    if (!isDevUiDeployment(environment) || !isDevUiRequestOrigin(request.url)) return 'invalid';
    if (!canonicalDevUiPathname(url.pathname)) return 'forbidden';
    if (url.pathname.startsWith('/api')) {
        return DEV_API_ROUTES.some(route => route.method === request.method && route.path.test(url.pathname))
            ? 'dev'
            : 'forbidden';
    }
    if (url.pathname.startsWith('/auth')
        && (url.pathname !== '/auth/callback' || request.method !== 'GET')) return 'forbidden';
    return 'dev';
}
