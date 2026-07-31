import { describe, expect, it } from 'vitest';
import {
    PREFLIGHT_IDENTITY_HMAC_SECRET_ENV,
    analysisV2ProgressCandidateKey,
    assertPreflightIdentityHmacConfiguration,
    preflightTargetInputHash,
} from './preflight-identity';

const secret = Buffer.alloc(32, 17).toString('base64url');
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const otherRequestId = '223e4567-e89b-42d3-a456-426614174000';

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

describe('analysis V2 progress candidate identity HMAC', () => {
    it('is stable across stages for one request and canonical username', () => {
        const env = { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret };
        const profileFetch = analysisV2ProgressCandidateKey(
            requestId,
            ' Candidate.Name ',
            env
        );
        const profileAi = analysisV2ProgressCandidateKey(
            requestId,
            '@candidate.name',
            env
        );

        expect(profileFetch).toBe(profileAi);
        expect(profileFetch).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify({ candidateKey: profileFetch })).not.toContain('candidate.name');
    });

    it('separates the same candidate across analysis requests', () => {
        const env = { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret };
        expect(analysisV2ProgressCandidateKey(requestId, 'candidate.name', env)).not.toBe(
            analysisV2ProgressCandidateKey(otherRequestId, 'candidate.name', env)
        );
    });

    it.each(['', '@@candidate.name', 'bad handle']) (
        'rejects an invalid progress username safely: %s',
        username => {
            expect(() => analysisV2ProgressCandidateKey(requestId, username, {
                [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret,
            })).toThrow('invalid username');
        }
    );

    it('keeps distinct canonical usernames distinct within one request', () => {
        const env = { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret };
        expect(analysisV2ProgressCandidateKey(requestId, 'candidate.name', env)).not.toBe(
            analysisV2ProgressCandidateKey(requestId, 'candidate.other', env)
        );
    });

    it('uses a domain distinct from the preflight target identity hash', () => {
        const env = { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: secret };
        expect(analysisV2ProgressCandidateKey(requestId, 'candidate.name', env)).not.toBe(
            preflightTargetInputHash('candidate.name', env)
        );
    });

    it.each([
        ['missing', {}],
        ['weak', { [PREFLIGHT_IDENTITY_HMAC_SECRET_ENV]: Buffer.alloc(31).toString('base64url') }],
    ])('fails safely for a %s secret', (_label, env) => {
        expect(() => analysisV2ProgressCandidateKey(requestId, 'candidate.name', env)).toThrow(
            'PREFLIGHT_TASKS_CONFIG_ERROR'
        );
    });
});
