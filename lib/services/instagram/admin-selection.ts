import { timingSafeEqual } from 'node:crypto';

/** Provider overrides are an operations control and are never authorized by end-user auth alone. */
export function hasValidAdminAuthorization(
    authorization: string | null,
    env: Record<string, string | undefined> = process.env
): boolean {
    const key = env.ADMIN_API_KEY;
    if (!key || !authorization) return false;
    const expected = Buffer.from(`Bearer ${key}`);
    const actual = Buffer.from(authorization);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Backward-compatible name for the scraper-selection call site. */
export const hasValidScraperAdminAuthorization = hasValidAdminAuthorization;
