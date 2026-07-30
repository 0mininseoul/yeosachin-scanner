import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashAnalysisTestEntitlementJti } from './test-entitlement-jti';

describe('analysis test entitlement JTI hash', () => {
    it('uses the stable domain-separated hash rather than a raw nonce digest', () => {
        const nonce = 'canonical_nonce_123456';
        expect(hashAnalysisTestEntitlementJti(nonce)).toBe(
            createHash('sha256')
                .update(`analysis-test-entitlement-jti-v1\n${nonce}`, 'utf8')
                .digest('hex')
        );
        expect(hashAnalysisTestEntitlementJti(nonce)).not.toBe(
            createHash('sha256').update(nonce, 'utf8').digest('hex')
        );
    });

    it('rejects malformed nonce values', () => {
        expect(() => hashAnalysisTestEntitlementJti('short')).toThrow(
            'ANALYSIS_V2_ENTITLEMENT_JTI_ERROR'
        );
    });
});
