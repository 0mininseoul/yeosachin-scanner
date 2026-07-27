import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));

import { captureExceptionSafely } from './sentry-capture';

describe('global error Sentry capture', () => {
    it('captures an exception without allowing telemetry failures to throw', () => {
        const error = new Error('safe test');
        captureExceptionSafely(error);
        expect(mocks.captureException).toHaveBeenCalledWith(error);
        mocks.captureException.mockImplementationOnce(() => { throw new Error('transport unavailable'); });
        expect(() => captureExceptionSafely(error)).not.toThrow();
    });
});
