import { describe, expect, it, vi } from 'vitest';
import {
    analysisTestEntitlementsEnabled,
    assertAnalysisTestEntitlementConfiguration,
    createAnalysisTestEntitlement,
    verifyAnalysisTestEntitlement,
} from './test-entitlement';

const SECRET = Buffer.alloc(32, 7).toString('base64url');
const NOW_MS = Date.UTC(2026, 6, 13, 5, 0, 0);
const input = {
    preflightId: '123e4567-e89b-42d3-a456-426614174000',
    userId: '123e4567-e89b-42d3-b456-426614174001',
    planId: 'standard' as const,
    nonce: 'abcdefghijklmnop',
};

describe('analysis test entitlement', () => {
    it('parses the operational feature flag strictly and fails closed by default', () => {
        expect(analysisTestEntitlementsEnabled({})).toBe(false);
        expect(analysisTestEntitlementsEnabled({
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'true',
        })).toBe(true);
        expect(() => analysisTestEntitlementsEnabled({
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'sometimes',
        })).toThrow('must be a boolean');
        expect(() => assertAnalysisTestEntitlementConfiguration({
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'true',
            ANALYSIS_TEST_ENTITLEMENT_SECRET:
                'replace-with-a-canonical-base64url-32-byte-secret',
        })).toThrow('canonical base64url');
        expect(() => assertAnalysisTestEntitlementConfiguration({
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'true',
            ANALYSIS_TEST_ENTITLEMENT_SECRET: SECRET,
        })).not.toThrow();
    });

    it('binds a short-lived signed token to one preflight, user, and plan', () => {
        const token = createAnalysisTestEntitlement(input, {
            nowMs: NOW_MS,
            secret: SECRET,
        });

        expect(verifyAnalysisTestEntitlement(token, input, {
            nowMs: NOW_MS + 9 * 60_000,
            secret: SECRET,
        })).toMatchObject({
            version: 1,
            preflightId: input.preflightId,
            userId: input.userId,
            planId: input.planId,
            nonce: input.nonce,
        });
        expect(verifyAnalysisTestEntitlement(token, {
            ...input,
            planId: 'plus',
        }, { nowMs: NOW_MS, secret: SECRET })).toBeNull();
        expect(verifyAnalysisTestEntitlement(token, {
            ...input,
            userId: '123e4567-e89b-42d3-b456-426614174099',
        }, { nowMs: NOW_MS, secret: SECRET })).toBeNull();
        expect(verifyAnalysisTestEntitlement(token, {
            ...input,
            preflightId: '123e4567-e89b-42d3-a456-426614174099',
        }, { nowMs: NOW_MS, secret: SECRET })).toBeNull();
    });

    it('rejects tampering, expiry, noncanonical payloads, and excessive lifetime', () => {
        const token = createAnalysisTestEntitlement(input, {
            nowMs: NOW_MS,
            secret: SECRET,
        });
        const parts = token.split('.');
        const tampered = `${parts[0]}.${parts[1].slice(0, -1)}A.${parts[2]}`;
        expect(verifyAnalysisTestEntitlement(tampered, input, {
            nowMs: NOW_MS,
            secret: SECRET,
        })).toBeNull();
        expect(verifyAnalysisTestEntitlement(token, input, {
            nowMs: NOW_MS + 11 * 60_000,
            secret: SECRET,
        })).toBeNull();
        expect(() => createAnalysisTestEntitlement({
            ...input,
            ttlSeconds: 901,
        }, { nowMs: NOW_MS, secret: SECRET })).toThrow(RangeError);

        const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const noncanonicalPayload = Buffer.from(JSON.stringify({
            p: parsed.p,
            v: parsed.v,
            u: parsed.u,
            plan: parsed.plan,
            exp: parsed.exp,
            n: parsed.n,
        }), 'utf8').toString('base64url');
        const forgedShape = `v1.${noncanonicalPayload}.${parts[2]}`;
        expect(verifyAnalysisTestEntitlement(forgedShape, input, {
            nowMs: NOW_MS,
            secret: SECRET,
        })).toBeNull();
    });

    it('requires a dedicated strong secret and never accepts another application secret', () => {
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENT_SECRET', '');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET);
        expect(() => createAnalysisTestEntitlement(input, { nowMs: NOW_MS }))
            .toThrow('ANALYSIS_TEST_ENTITLEMENT_SECRET');
        expect(verifyAnalysisTestEntitlement('v1.invalid.invalid', input, {
            nowMs: NOW_MS,
        })).toBeNull();
        vi.unstubAllEnvs();
    });

    it('rejects the public environment-example placeholder', () => {
        expect(() => createAnalysisTestEntitlement(input, {
            nowMs: NOW_MS,
            secret: 'replace-with-a-dedicated-32-byte-random-secret',
        })).toThrow('canonical base64url');
    });

    it('rejects malformed identifiers and weak nonces before signing', () => {
        expect(() => createAnalysisTestEntitlement({
            ...input,
            preflightId: 'not-a-uuid',
        }, { nowMs: NOW_MS, secret: SECRET })).toThrow('preflightId');
        expect(() => createAnalysisTestEntitlement({
            ...input,
            nonce: 'short',
        }, { nowMs: NOW_MS, secret: SECRET })).toThrow('nonce');
    });
});
