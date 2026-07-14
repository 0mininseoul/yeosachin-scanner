import { describe, expect, it } from 'vitest';
import {
    PREFLIGHT_MINIMUM_FALLBACK_START_WINDOW_MS,
    PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS,
    assertPreflightRuntimePolicy,
    fallbackStartWindowMs,
    maximumSelfHostedProfileRuntimeMs,
} from './preflight-runtime-policy';

const identitySecret = Buffer.alloc(32, 19).toString('base64url');
const identityEnv = {
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: identitySecret,
};

describe('preflight runtime policy', () => {
    it('keeps the default self-hosted profile policy inside the worker budget', () => {
        expect(maximumSelfHostedProfileRuntimeMs(identityEnv))
            .toBeLessThanOrEqual(PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS);
        expect(fallbackStartWindowMs(identityEnv))
            .toBeGreaterThanOrEqual(PREFLIGHT_MINIMUM_FALLBACK_START_WINDOW_MS);
        expect(() => assertPreflightRuntimePolicy(identityEnv)).not.toThrow();
    });

    it('accepts the runtime boundary only when a positive fallback start window remains', () => {
        const env = {
            ...identityEnv,
            SELFHOSTED_PROFILE_TIMEOUT_MS: '60000',
            SELFHOSTED_PROFILE_RETRIES: '0',
            SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '20000',
        };

        expect(maximumSelfHostedProfileRuntimeMs(env)).toBe(
            PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS
        );
        expect(fallbackStartWindowMs(env)).toBe(
            PREFLIGHT_MINIMUM_FALLBACK_START_WINDOW_MS
        );
        expect(fallbackStartWindowMs(env)).toBeGreaterThan(0);
        expect(() => assertPreflightRuntimePolicy(env)).not.toThrow();
    });

    it('rejects a valid but unsafe global retry configuration before dispatch', () => {
        const env = {
            ...identityEnv,
            SELFHOSTED_PROFILE_TIMEOUT_MS: '60000',
            SELFHOSTED_PROFILE_RETRIES: '3',
            SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS: '30000',
            SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '60000',
            SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS: '300000',
        };

        expect(maximumSelfHostedProfileRuntimeMs(env))
            .toBeGreaterThan(PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS);
        expect(() => assertPreflightRuntimePolicy(env))
            .toThrow('preflight worker runtime budget');
    });
});
