import { describe, expect, it, vi } from 'vitest';
import {
    preflightFailureReason,
    recordPreflightFailure,
} from './preflight-failure-ledger';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174001';

describe('preflight failure ledger', () => {
    it('keeps the failure vocabulary bounded and PII-free', () => {
        expect(preflightFailureReason('TARGET_PRIVATE')).toBe('TARGET_PRIVATE');
        expect(preflightFailureReason('OVER_PLUS_CAPACITY')).toBe('PLAN_CAPACITY_EXCEEDED');
        expect(preflightFailureReason('INVALID_EXCLUSION')).toBe('EXCLUSION_RULE_VIOLATION');
        expect(preflightFailureReason('PROVIDER_ERROR')).toBe('PROVIDER_TEMPORARY_FAILURE');
    });

    it('writes only UUID ownership, stage, and reason', async () => {
        const insert = vi.fn().mockResolvedValue({ error: null });
        await expect(recordPreflightFailure({
            userId: USER_ID,
            preflightId: PREFLIGHT_ID,
            stage: 'profile',
            errorCode: 'TARGET_PRIVATE',
        }, { client: { from: () => ({ insert }) } })).resolves.toBe(true);
        expect(insert).toHaveBeenCalledWith({
            user_id: USER_ID,
            preflight_id: PREFLIGHT_ID,
            stage: 'profile',
            error_code: 'TARGET_PRIVATE',
        });
        expect(JSON.stringify(insert.mock.calls)).not.toMatch(/instagram|username|target|message|token/);
    });
});
