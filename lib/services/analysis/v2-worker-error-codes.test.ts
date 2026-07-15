import { describe, expect, it, vi } from 'vitest';
import { isAnalysisV2WorkerErrorCode } from './v2-worker-error-codes';
import { classifyAnalysisV2JobFailure } from './v2-worker';
import {
    APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES,
} from '@/lib/services/instagram/providers/apify-relationship';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const PROVIDER_LIFECYCLE_PERSISTENCE_CODES = [
    'ANALYSIS_V2_PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR',
    'ANALYSIS_V2_PROVIDER_RUN_COST_START_PERSISTENCE_ERROR',
    'ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR',
] as const;

describe('analysis V2 worker error codes', () => {
    it('accepts every immutable Apify provider callback code', () => {
        expect(Array.isArray(APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES)).toBe(true);
        expect(Object.isFrozen(APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES)).toBe(true);
        for (const code of APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES) {
            expect(isAnalysisV2WorkerErrorCode(code), code).toBe(true);
        }
    });

    it.each(PROVIDER_LIFECYCLE_PERSISTENCE_CODES)(
        'allows the provider lifecycle phase code %s',
        (code) => {
            expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        }
    );

    it.each(PROVIDER_LIFECYCLE_PERSISTENCE_CODES)(
        'classifies the provider lifecycle phase code %s as transient',
        (code) => {
            expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
                code,
                disposition: 'transient',
                retryable: true,
            });
        }
    );

    it('preserves an authorized test credential-policy mismatch as permanent', () => {
        const code = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH';
        expect(APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES).toContain(code);
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });
});
