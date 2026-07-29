import { createHash } from 'node:crypto';

const ENTITLEMENT_JTI_DOMAIN = 'analysis-test-entitlement-jti-v1';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Canonical, dependency-free JTI hash for both server consumption and isolated
 * operator credential issuance. Keep this module free of project path aliases.
 */
export function hashAnalysisTestEntitlementJti(nonce: string): string {
    if (!NONCE_PATTERN.test(nonce)) {
        throw new Error('ANALYSIS_V2_ENTITLEMENT_JTI_ERROR: invalid nonce.');
    }
    return createHash('sha256')
        .update(`${ENTITLEMENT_JTI_DOMAIN}\n${nonce}`, 'utf8')
        .digest('hex');
}
