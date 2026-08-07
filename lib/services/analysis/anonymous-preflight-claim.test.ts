import { describe, expect, it } from 'vitest';
import {
    createAnonymousPreflightClaim,
    hashAnonymousPreflightClaim,
    readAnonymousPreflightClaim,
} from './anonymous-preflight-claim';

const env = {
    ANONYMOUS_PREFLIGHT_CLAIM_SECRET:
        'anonymous-preflight-test-secret-with-at-least-32-bytes',
};

describe('anonymous preflight claim tokens', () => {
    it('creates a short-lived signed token and a one-way digest', () => {
        const claim = createAnonymousPreflightClaim({
            nowMs: Date.parse('2026-08-05T00:00:00.000Z'),
            env,
            randomBytes: () => Buffer.from('0123456789abcdefghijklmnop'),
        });

        expect(claim.expiresAt).toBe('2026-08-05T00:30:00.000Z');
        expect(claim.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(claim.token).not.toContain('instagram');
        expect(claim.tokenHash).toBe(hashAnonymousPreflightClaim(claim.token));
        expect(readAnonymousPreflightClaim(claim.token, {
            nowMs: Date.parse('2026-08-05T00:29:59.000Z'),
            env,
        })).toEqual({ expiresAt: claim.expiresAt });
    });

    it('rejects tampering and expiry without exposing the payload', () => {
        const claim = createAnonymousPreflightClaim({
            nowMs: Date.parse('2026-08-05T00:00:00.000Z'),
            env,
            randomBytes: () => Buffer.from('0123456789abcdefghijklmnop'),
        });

        expect(readAnonymousPreflightClaim(`${claim.token}x`, { env })).toBeNull();
        expect(readAnonymousPreflightClaim(claim.token, {
            nowMs: Date.parse('2026-08-05T00:30:00.000Z'),
            env,
        })).toBeNull();
        expect(readAnonymousPreflightClaim(claim.token, {
            nowMs: Date.parse('2026-08-04T23:59:59.000Z'),
            env: { ANONYMOUS_PREFLIGHT_CLAIM_SECRET: 'different-secret-with-at-least-32-bytes' },
        })).toBeNull();
    });
});
