import { describe, expect, it } from 'vitest';
import {
    AUTO_CHECKOUT_QUERY_PARAM,
    checkoutContinuationKey,
    isCheckoutContinuationRequested,
    shouldAutoSubmitEarlybirdAction,
} from './post-login-checkout';

const PREFLIGHT_ID = '223e4567-e89b-42d3-a456-426614174000';

describe('post-login earlybird checkout continuation', () => {
    it('recognizes the OAuth return intent and submits once the ready plan can be acted on', () => {
        const params = new URLSearchParams({
            [AUTO_CHECKOUT_QUERY_PARAM]: '1',
        });

        expect(isCheckoutContinuationRequested(params)).toBe(true);
        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: true,
            ready: true,
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            exclusionDecided: true,
            planAvailable: true,
            submitting: false,
            attemptedKey: null,
        })).toBe(true);
    });

    it('waits for auth, the exclusion decision, and a usable snapshot, then deduplicates the continuation', () => {
        const key = checkoutContinuationKey(PREFLIGHT_ID, 'standard');

        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: false,
            ready: true,
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            exclusionDecided: true,
            planAvailable: true,
            submitting: false,
            attemptedKey: null,
        })).toBe(false);
        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: true,
            ready: true,
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            exclusionDecided: false,
            planAvailable: true,
            submitting: false,
            attemptedKey: null,
        })).toBe(false);
        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: true,
            ready: true,
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            exclusionDecided: true,
            planAvailable: true,
            submitting: false,
            attemptedKey: key,
        })).toBe(false);
    });
});
