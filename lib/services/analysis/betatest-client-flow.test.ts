import { describe, expect, it } from 'vitest';
import {
    betaAdmissionFailureMessage,
    getAnalysisV2PreflightFlowConfig,
    isBetaAdmissionPending,
} from '@/hooks/useAnalysisV2Preflight';

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
