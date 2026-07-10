import { hasValidAdminAuthorization } from '@/lib/services/instagram/admin-selection';

export type LegacyRunAccess = 'disabled' | 'forbidden' | 'allowed';

export function getLegacyRunAccess(
    authorization: string | null,
    env: Record<string, string | undefined> = process.env
): LegacyRunAccess {
    if (env.ENABLE_LEGACY_ANALYSIS_RUN !== 'true') return 'disabled';
    return hasValidAdminAuthorization(authorization, env) ? 'allowed' : 'forbidden';
}
