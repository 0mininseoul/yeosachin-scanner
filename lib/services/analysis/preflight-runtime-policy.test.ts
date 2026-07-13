import { describe, expect, it } from 'vitest';
import {
    PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS,
    assertPreflightRuntimePolicy,
    maximumSelfHostedProfileRuntimeMs,
} from './preflight-runtime-policy';

describe('preflight runtime policy', () => {
    it('keeps the default self-hosted profile policy inside the worker budget', () => {
        expect(maximumSelfHostedProfileRuntimeMs({}))
            .toBeLessThanOrEqual(PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS);
        expect(() => assertPreflightRuntimePolicy({})).not.toThrow();
    });

    it('rejects a valid but unsafe global retry configuration before dispatch', () => {
        const env = {
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
