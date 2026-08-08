import { describe, expect, it } from 'vitest';
import {
    AUTO_CHECKOUT_QUERY_PARAM,
    checkoutContinuationKey,
    checkoutContinuationPlan,
    hasCheckoutContinuationIntent,
    isCheckoutContinuationRequested,
    shouldAutoSubmitEarlybirdAction,
} from './post-login-checkout';

const PREFLIGHT_ID = '223e4567-e89b-42d3-a456-426614174000';

describe('post-login earlybird checkout continuation', () => {
    it('detects a complete browser continuation before the preflight snapshot is restored', () => {
        expect(hasCheckoutContinuationIntent(new URLSearchParams({
            preflight: PREFLIGHT_ID,
            [AUTO_CHECKOUT_QUERY_PARAM]: '1',
            plan: 'standard',
        }))).toBe(true);
        expect(hasCheckoutContinuationIntent(new URLSearchParams({
            [AUTO_CHECKOUT_QUERY_PARAM]: '1',
            plan: 'standard',
        }))).toBe(false);
        expect(hasCheckoutContinuationIntent(new URLSearchParams({
            preflight: PREFLIGHT_ID,
            [AUTO_CHECKOUT_QUERY_PARAM]: '1',
        }))).toBe(false);
    });

    it('recognizes the OAuth return intent and submits once the ready plan can be acted on', () => {
        const params = new URLSearchParams({
            [AUTO_CHECKOUT_QUERY_PARAM]: '1',
            plan: 'standard',
        });

        expect(isCheckoutContinuationRequested(params)).toBe(true);
        expect(checkoutContinuationPlan(params)).toBe('standard');
        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: true,
            ready: true,
            preflightId: PREFLIGHT_ID,
            requestedPreflightId: PREFLIGHT_ID,
            requestedPlanId: 'standard',
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
            requestedPreflightId: PREFLIGHT_ID,
            requestedPlanId: 'standard',
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
            requestedPreflightId: PREFLIGHT_ID,
            requestedPlanId: 'standard',
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
            requestedPreflightId: PREFLIGHT_ID,
            requestedPlanId: 'standard',
            planId: 'standard',
            exclusionDecided: true,
            planAvailable: true,
            submitting: false,
            attemptedKey: key,
        })).toBe(false);
        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: true,
            ready: true,
            preflightId: PREFLIGHT_ID,
            requestedPreflightId: PREFLIGHT_ID,
            requestedPlanId: 'standard',
            planId: 'basic',
            exclusionDecided: true,
            planAvailable: true,
            submitting: false,
            attemptedKey: null,
        })).toBe(false);
        expect(shouldAutoSubmitEarlybirdAction({
            requested: true,
            authenticated: true,
            ready: true,
            preflightId: '323e4567-e89b-42d3-a456-426614174000',
            requestedPreflightId: PREFLIGHT_ID,
            requestedPlanId: 'standard',
            planId: 'standard',
            exclusionDecided: true,
            planAvailable: true,
            submitting: false,
            attemptedKey: null,
        })).toBe(false);
    });
});
