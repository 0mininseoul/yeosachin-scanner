import { describe, expect, it } from "vitest";
import { createAnonymousPreflightClaim, hashAnonymousPreflightClaim, readAnonymousPreflightClaim } from "../../../lib/services/analysis/anonymous-preflight-claim";
import { PREFLIGHT_IDENTITY_HMAC_SECRET_ENV, analysisV2ProgressCandidateKey, assertPreflightIdentityHmacConfiguration, preflightTargetInputHash } from "../../../lib/services/analysis/preflight-identity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrecheckoutDelayedStatus, PreflightPendingStatus, preflightPendingStage } from "@/components/preflight-pending-status";
import { shouldOfferAnonymousPreflightLogin, betaAdmissionFailureMessage, getAnalysisV2PreflightFlowConfig, isBetaAdmissionPending } from "@/hooks/useAnalysisV2Preflight";
import { betaTestFreePoolEnabled, ensureBetaTestAccess, hasBetaTestAccess } from "../../../lib/services/analysis/betatest-access";
import { PREFLIGHT_MINIMUM_FALLBACK_START_WINDOW_MS, PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS, assertPreflightRuntimePolicy, fallbackStartWindowMs, maximumSelfHostedProfileRuntimeMs } from "../../../lib/services/analysis/preflight-runtime-policy";

describe("anonymous-preflight-claim", () => {
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
});

describe("preflight-identity", () => {
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
});

describe("preflight-pending-status", () => {
    describe('preflight pending status', () => {
        it('advances at the 15 second and 45 second boundaries', () => {
            expect(preflightPendingStage(0)).toBe('initial');
            expect(preflightPendingStage(14_999)).toBe('initial');
            expect(preflightPendingStage(15_000)).toBe('later');
            expect(preflightPendingStage(44_999)).toBe('later');
            expect(preflightPendingStage(45_000)).toBe('delayed');
        });

        it.each([
            [5_000, '프로필과 계정 규모를 확인하고 있습니다.'],
            [20_000, '조금만 더 확인하고 있어요.'],
            [50_000, '평소보다 확인이 오래 걸리고 있습니다.'],
        ])('shows trustworthy copy after %i ms', (elapsedMs, expectedCopy) => {
            const startedAt = 1_000;
            const markup = renderToStaticMarkup(createElement(PreflightPendingStatus, {
                targetInstagramId: 'private_target',
                startedAt,
                now: () => startedAt + elapsedMs,
            }));

            expect(markup).toContain(expectedCopy);
            expect(markup).toContain('anim-indeterminate');
            expect(markup).toContain('data-amp-block');
            expect(markup).not.toMatch(/\d+%|초 남/);
        });

        it('renders the post-graph delayed state as static copy without a spinner or CTA', () => {
            const markup = renderToStaticMarkup(createElement(PrecheckoutDelayedStatus, {
                targetInstagramId: 'private_target',
                parentState: 'pending',
            }));

            expect(markup).toContain('확인이 조금 더 필요해요');
            expect(markup).toContain('data-precheckout-delayed-state="parent_pending"');
            expect(markup).not.toContain('anim-indeterminate');
            expect(markup).not.toContain('button');
        });
    });
});

describe("preflight-login-fallback", () => {
    describe('anonymous preflight login fallback', () => {
        it('offers login for the bounded anonymous rate-limit response', () => {
            expect(shouldOfferAnonymousPreflightLogin(
                { code: 'PREFLIGHT_RATE_LIMITED' },
                429,
            )).toBe(true);
        });

        it('offers login when anonymous preflight is unavailable', () => {
            expect(shouldOfferAnonymousPreflightLogin(
                { code: 'ANONYMOUS_PREFLIGHT_UNAVAILABLE' },
                503,
            )).toBe(true);
        });

        it('offers login for the reserved demo target without exposing operator details', () => {
            expect(shouldOfferAnonymousPreflightLogin(
                { code: 'DEMO_LOGIN_REQUIRED' },
                401,
            )).toBe(true);
        });

        it('does not turn beta-test failures into a paid-flow login fallback', () => {
            expect(shouldOfferAnonymousPreflightLogin(
                { code: 'PREFLIGHT_RATE_LIMITED' },
                429,
                'betatest',
            )).toBe(false);
        });

        it('ignores unrelated errors and malformed payloads', () => {
            expect(shouldOfferAnonymousPreflightLogin({ code: 'TARGET_NOT_FOUND' }, 404)).toBe(false);
            expect(shouldOfferAnonymousPreflightLogin(null, 503)).toBe(false);
            expect(shouldOfferAnonymousPreflightLogin({ code: 'PREFLIGHT_RATE_LIMITED' }, 200)).toBe(false);
        });
    });
});

describe("betatest-client-flow", () => {
    describe('beta-test preflight client flow', () => {
        it('uses dedicated create and admission routes without test-entitlement credentials', () => {
            const beta = getAnalysisV2PreflightFlowConfig('betatest');

            expect(beta.createEndpoint).toBe('/api/analysis/betatest/preflight');
            expect(beta.statusEndpoint('preflight-id')).toBe('/api/analysis/preflight/preflight-id');
            expect(beta.admitEndpoint?.('preflight-id')).toBe(
                '/api/analysis/betatest/preflight/preflight-id/admit'
            );
            expect(beta.acceptsTestCredentials).toBe(false);
        });

        it('keeps beta capacity exhaustion retryable on the same preflight', () => {
            expect(betaAdmissionFailureMessage({ code: 'BETA_CAPACITY_UNAVAILABLE' }))
                .toBe('현재 무료 판독 가능 인원이 모두 찼습니다. 잠시 후 다시 시도해주세요.');
        });

        it('does not turn an admission replay response into a checkout requirement', () => {
            expect(betaAdmissionFailureMessage({ code: 'BETA_ADMISSION_PENDING' }))
                .toBe('판독 배정을 확인하고 있습니다. 잠시 후 다시 시도해주세요.');
        });

        it('leaves a pending admission retryable on the same preflight instead of treating it as a malformed success', () => {
            expect(isBetaAdmissionPending({
                code: 'BETA_ADMISSION_PENDING',
                status: 'admission_pending',
                retryAfterMs: 1_000,
            })).toBe(true);
            expect(isBetaAdmissionPending({ status: 'queued' })).toBe(false);
        });

        it('retains the standard route and credential behavior by default', () => {
            const standard = getAnalysisV2PreflightFlowConfig();

            expect(standard.createEndpoint).toBe('/api/analysis/preflight');
            expect(standard.admitEndpoint).toBeUndefined();
            expect(standard.acceptsTestCredentials).toBe(true);
        });
    });
});

describe("betatest-access", () => {
    describe('betatest access boundary', () => {
        it('fails closed unless the dedicated pool flag is exactly enabled', () => {
            expect(betaTestFreePoolEnabled({})).toBe(false);
            expect(betaTestFreePoolEnabled({ BETATEST_FREE_POOL_ENABLED: 'false' })).toBe(false);
            expect(betaTestFreePoolEnabled({ BETATEST_FREE_POOL_ENABLED: '1' })).toBe(false);
            expect(betaTestFreePoolEnabled({ BETATEST_FREE_POOL_ENABLED: 'true' })).toBe(true);
        });

        it('uses only the non-enumerable self-check and fails closed on malformed results', async () => {
            const calls: Array<{ name: string; params?: unknown }> = [];
            const allowed = await hasBetaTestAccess({
                rpc: async (name, params) => {
                    calls.push({ name, params });
                    return { data: true, error: null };
                },
            });

            expect(allowed).toBe(true);
            expect(calls).toEqual([{ name: 'analysis_beta_has_access', params: undefined }]);
            await expect(hasBetaTestAccess({
                rpc: async () => ({ data: { allowed: true }, error: null }),
            })).resolves.toBe(false);
            await expect(hasBetaTestAccess({
                rpc: async () => ({ data: false, error: null }),
            })).resolves.toBe(false);
            await expect(hasBetaTestAccess({
                rpc: async () => ({ data: null, error: { message: 'db' } }),
            })).resolves.toBe(false);
        });

        it('uses the service-only enrollment boundary with the server-authenticated user id', async () => {
            const userId = '223e4567-e89b-42d3-a456-426614174000';
            const calls: Array<{ name: string; params?: unknown }> = [];
            await expect(ensureBetaTestAccess({
                rpc: async (name, params) => {
                    calls.push({ name, params });
                    return { data: true, error: null };
                },
            }, userId)).resolves.toBe(true);
            expect(calls).toEqual([
                { name: 'enroll_analysis_beta_user', params: { p_user_id: userId } },
            ]);

            await expect(ensureBetaTestAccess({
                rpc: async () => ({ data: false, error: null }),
            }, userId)).resolves.toBe(false);
            await expect(ensureBetaTestAccess({
                rpc: async () => ({ data: { allowed: true }, error: null }),
            }, userId)).resolves.toBe(false);
            await expect(ensureBetaTestAccess({
                rpc: async () => { throw new Error('transport'); },
            }, userId)).resolves.toBe(false);
        });
    });
});

describe("preflight-runtime-policy", () => {
    const identitySecret = Buffer.alloc(32, 19).toString('base64url');
    const identityEnv = {
        ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: identitySecret,
    };

    describe('preflight runtime policy', () => {
        it('preserves the prior local-only runtime when the global gate is disabled', () => {
            expect(maximumSelfHostedProfileRuntimeMs(identityEnv)).toBe(76_600);
            expect(maximumSelfHostedProfileRuntimeMs({
                ...identityEnv,
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false',
            })).toBe(76_600);
            expect(maximumSelfHostedProfileRuntimeMs(identityEnv))
                .toBeLessThanOrEqual(PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS);
            expect(fallbackStartWindowMs(identityEnv))
                .toBeGreaterThanOrEqual(PREFLIGHT_MINIMUM_FALLBACK_START_WINDOW_MS);
            expect(() => assertPreflightRuntimePolicy(identityEnv)).not.toThrow();
        });

        it('includes the admission reservation budget in enabled production defaults', () => {
            const env = { ...identityEnv, NODE_ENV: 'production' };

            expect(maximumSelfHostedProfileRuntimeMs(env)).toBe(79_100);
            expect(() => assertPreflightRuntimePolicy(env)).not.toThrow();
        });

        it('charges the larger response guard when it exceeds the RPC timeout', () => {
            const env = {
                ...identityEnv,
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
                SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS: '1000',
                SELFHOSTED_PROFILE_GLOBAL_RPC_TIMEOUT_MS: '100',
            };

            expect(maximumSelfHostedProfileRuntimeMs(env)).toBe(79_600);
        });

        it('accepts the runtime boundary only when a positive fallback start window remains', () => {
            const env = {
                ...identityEnv,
                SELFHOSTED_PROFILE_TIMEOUT_MS: '60000',
                SELFHOSTED_PROFILE_RETRIES: '0',
                SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '20000',
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false',
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

        it('accepts the enabled runtime boundary after charging one admission gate attempt', () => {
            const env = {
                ...identityEnv,
                SELFHOSTED_PROFILE_TIMEOUT_MS: '60000',
                SELFHOSTED_PROFILE_RETRIES: '0',
                SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '18750',
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
            };

            expect(maximumSelfHostedProfileRuntimeMs(env)).toBe(
                PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS
            );
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
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
            };

            expect(maximumSelfHostedProfileRuntimeMs(env))
                .toBeGreaterThan(PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS);
            expect(() => assertPreflightRuntimePolicy(env))
                .toThrow('preflight worker runtime budget');
        });
    });
});
