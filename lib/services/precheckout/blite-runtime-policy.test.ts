import { describe, expect, it } from 'vitest';
import {
    BLITE_CHECKPOINT_DEADLINE_MS,
    BLITE_FALLBACK_LATCH_MS,
    BLITE_INFERENCE_DEADLINE_MS,
    BLITE_PROVIDER_DEADLINE_MS,
    BLITE_UX_DEADLINE_MS,
    bliteDeadlines,
    selectBliteCohort,
} from './blite-runtime-policy';

const PREFLIGHT_ID = '2b502f2a-6de3-4f5a-a8cd-6cb8c804cdf9';
const SUBMITTED_AT_MS = Date.UTC(2026, 7, 13, 3, 0, 0);

describe('B-lite runtime policy', () => {
    it('keeps the master gate disabled even when the rollout is otherwise eligible', () => {
        expect(selectBliteCohort(PREFLIGHT_ID, {
            PRECHECKOUT_BLITE_ENABLED: 'false',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
        })).toBe(false);
    });

    it('derives every phase deadline from the one submission timestamp', () => {
        expect(bliteDeadlines(SUBMITTED_AT_MS)).toEqual({
            provider: SUBMITTED_AT_MS + BLITE_PROVIDER_DEADLINE_MS,
            checkpoint: SUBMITTED_AT_MS + BLITE_CHECKPOINT_DEADLINE_MS,
            fallback: SUBMITTED_AT_MS + BLITE_FALLBACK_LATCH_MS,
            inference: SUBMITTED_AT_MS + BLITE_INFERENCE_DEADLINE_MS,
            ux: SUBMITTED_AT_MS + BLITE_UX_DEADLINE_MS,
        });
        expect({
            provider: BLITE_PROVIDER_DEADLINE_MS,
            checkpoint: BLITE_CHECKPOINT_DEADLINE_MS,
            fallback: BLITE_FALLBACK_LATCH_MS,
            inference: BLITE_INFERENCE_DEADLINE_MS,
            ux: BLITE_UX_DEADLINE_MS,
        }).toEqual({
            provider: 40_000,
            checkpoint: 43_000,
            fallback: 78_000,
            inference: 86_000,
            ux: 90_000,
        });
    });

    it('uses a deterministic UUID-only cohort decision at the rollout boundaries', () => {
        const enabled = { PRECHECKOUT_BLITE_ENABLED: 'true' };

        expect(selectBliteCohort(PREFLIGHT_ID, {
            ...enabled,
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
        })).toBe(false);
        expect(selectBliteCohort(PREFLIGHT_ID, {
            ...enabled,
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
        })).toBe(true);
        expect(selectBliteCohort(PREFLIGHT_ID, {
            ...enabled,
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '50',
        })).toBe(selectBliteCohort(PREFLIGHT_ID, {
            ...enabled,
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '50',
        }));
    });

    it('fails closed for malformed or out-of-range rollout configuration', () => {
        for (const rolloutPercent of ['-1', '2.5', '101', 'enabled']) {
            expect(selectBliteCohort(PREFLIGHT_ID, {
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: rolloutPercent,
            })).toBe(false);
        }
    });

    it('allows only a trusted caller to force an eligible signed test-entitlement cohort', () => {
        const disabled = {
            PRECHECKOUT_BLITE_ENABLED: 'false',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
        };
        const enabled = {
            PRECHECKOUT_BLITE_ENABLED: 'true',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
        };

        expect(selectBliteCohort(PREFLIGHT_ID, disabled, {
            signedTestEntitlement: true,
        })).toBe(false);
        expect(selectBliteCohort(PREFLIGHT_ID, enabled, {
            signedTestEntitlement: true,
        })).toBe(true);
    });
});
