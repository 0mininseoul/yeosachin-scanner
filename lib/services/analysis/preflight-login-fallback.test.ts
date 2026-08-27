import { describe, expect, it } from 'vitest';
import { shouldOfferAnonymousPreflightLogin } from '@/hooks/useAnalysisV2Preflight';

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
