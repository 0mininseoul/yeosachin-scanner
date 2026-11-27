export const ADMIN_CONSOLE_PATH = '/admin0min';
export const LEGACY_ADMIN_CONSOLE_PATH = '/admin/analysis-audit';
export const NAMCHIN_ADMIN_CONSOLE_PATH = `${ADMIN_CONSOLE_PATH}?workspace=namchin`;
export const CHERRY_THREADS_CONSOLE_PATH = `${NAMCHIN_ADMIN_CONSOLE_PATH}&view=threads`;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function adminConsolePath(requestId?: string | string[]): string {
    return typeof requestId === 'string' && REQUEST_ID.test(requestId)
        ? `${ADMIN_CONSOLE_PATH}?${new URLSearchParams({ requestId })}`
        : ADMIN_CONSOLE_PATH;
}

/** Retain only a supported workspace or detail target from an exact admin route. */
export function readAdminConsoleDestination(rawPath: string | null): string | null {
    if (!rawPath || rawPath.length > 2_048) return null;
    const pathname = rawPath.split(/[?#]/, 1)[0];
    if (pathname !== ADMIN_CONSOLE_PATH && pathname !== LEGACY_ADMIN_CONSOLE_PATH) return null;
    const url = new URL(rawPath, 'https://admin-console.invalid');
    const workspaces = url.searchParams.getAll('workspace');
    if (pathname === ADMIN_CONSOLE_PATH && workspaces.length === 1 && workspaces[0] === 'namchin') {
        const views = url.searchParams.getAll('view');
        if (views.length === 1 && views[0] === 'threads') return CHERRY_THREADS_CONSOLE_PATH;
        return NAMCHIN_ADMIN_CONSOLE_PATH;
    }
    const requestIds = url.searchParams.getAll('requestId');
    return adminConsolePath(requestIds.length === 1 ? requestIds[0] : undefined);
}
