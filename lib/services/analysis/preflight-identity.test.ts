import { describe, expect, it } from 'vitest';
import {
    PREFLIGHT_IDENTITY_HMAC_SECRET_ENV,
    assertPreflightIdentityHmacConfiguration,
    preflightTargetInputHash,
} from './preflight-identity';

const secret = Buffer.alloc(32, 17).toString('base64url');

describe('preflight target identity HMAC', () => {
    it('is stable across retries and canonical username casing', () => {
        const env = { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret };
        expect(preflightTargetInputHash('Target.Name', env)).toBe(
            preflightTargetInputHash('target.name', env)
        );
        expect(preflightTargetInputHash('target.name', env)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is domain-keyed and changes when the dedicated deployment secret changes', () => {
        const first = preflightTargetInputHash('target.name', {
            [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret,
        });
        const second = preflightTargetInputHash('target.name', {
            [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: Buffer.alloc(32, 18).toString('base64url'),
        });
        expect(second).not.toBe(first);
    });

    it.each([
        ['missing', {}],
        ['weak', { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: Buffer.alloc(31).toString('base64url') }],
        ['malformed', { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: 'not base64!' }],
    ])('fails closed for a %s secret', (_label, env) => {
        expect(() => assertPreflightIdentityHmacConfiguration(env)).toThrow(
            'PREFLIGHT_TASKS_CONFIG_ERROR'
        );
        expect(() => preflightTargetInputHash('target.name', env)).toThrow(
            'PREFLIGHT_TASKS_CONFIG_ERROR'
        );
    });
});
