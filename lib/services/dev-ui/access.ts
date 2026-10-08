import 'server-only';

import { assertDevUiDeployment } from './deployment';
import { DevUiStoreError } from './contracts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function matchesPrivateAllowlist(userId: string, name: 'DEV_UI_TEST_USER_IDS' | 'DEV_UI_ADMIN_USER_IDS'): boolean {
    if (typeof userId !== 'string' || !uuidPattern.test(userId)) return false;
    const entries = (process.env[name] ?? '').split(',').map(value => value.trim());
    // A partly malformed or empty configuration fails closed as a whole.
    if (!entries.length || entries.length > 100 || entries.some(value => !uuidPattern.test(value))) return false;
    return entries.some(value => value.toLowerCase() === userId.toLowerCase());
}

/** userId must come from server-verified Dev Auth, never a request body. */
export function assertDevUiTester(userId: string, request?: Pick<Request, 'url'>): void {
    assertDevUiDeployment(request);
    if (!matchesPrivateAllowlist(userId, 'DEV_UI_TEST_USER_IDS')) throw new DevUiStoreError('DEV_UI_ACCESS_DENIED');
}

/** Dev administrator reads additionally require the private Dev admin list. */
export function assertDevUiAdministrator(userId: string, request?: Pick<Request, 'url'>): void {
    assertDevUiTester(userId, request);
    if (!matchesPrivateAllowlist(userId, 'DEV_UI_ADMIN_USER_IDS')) throw new DevUiStoreError('DEV_UI_ACCESS_DENIED');
}
