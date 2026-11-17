export const ADMIN_CONSOLE_PATH = '/admin0min';
export const LEGACY_ADMIN_CONSOLE_PATH = '/admin/analysis-audit';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function adminConsolePath(requestId?: string | string[]): string {
    return typeof requestId === 'string' && REQUEST_ID.test(requestId)
        ? `${ADMIN_CONSOLE_PATH}?${new URLSearchParams({ requestId })}`
        : ADMIN_CONSOLE_PATH;
}

/** Retain only a single supported detail target from an exact admin route. */
export function readAdminConsoleDestination(rawPath: string | null): string | null {
    if (!rawPath || rawPath.length > 2_048) return null;
    const pathname = rawPath.split(/[?#]/, 1)[0];
    if (pathname !== ADMIN_CONSOLE_PATH && pathname !== LEGACY_ADMIN_CONSOLE_PATH) return null;
    const url = new URL(rawPath, 'https://admin-console.invalid');
    const requestIds = url.searchParams.getAll('requestId');
    return adminConsolePath(requestIds.length === 1 ? requestIds[0] : undefined);
}
