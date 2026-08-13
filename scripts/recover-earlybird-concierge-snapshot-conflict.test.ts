import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    parseConciergeSnapshotConflictRecoveryArgs,
    recoverWithServiceRole,
    runConciergeSnapshotConflictRecovery,
} from './recover-earlybird-concierge-snapshot-conflict';

const ORDER_ID = randomUUID();
const PREFLIGHT_ID = randomUUID();
const MANUAL_REVIEW_AT = '2026-08-13T19:00:00.000Z';
const ADMISSION_REFRESHED_AT = '2026-08-13T18:59:00.000Z';

const args = [
    '--order-id', ORDER_ID,
    '--preflight-id', PREFLIGHT_ID,
    '--expected-manual-review-at', MANUAL_REVIEW_AT,
    '--expected-admission-refreshed-at', ADMISSION_REFRESHED_AT,
    '--confirm-exact-20260812-1807-basic-snapshot-conflict',
] as const;

describe('concierge snapshot-conflict recovery CLI', () => {
    it('requires the exact identities, timestamps, and incident confirmation', () => {
        expect(parseConciergeSnapshotConflictRecoveryArgs(args)).toEqual({
            orderId: ORDER_ID,
            preflightId: PREFLIGHT_ID,
            expectedManualReviewAt: MANUAL_REVIEW_AT,
            expectedAdmissionRefreshedAt: ADMISSION_REFRESHED_AT,
        });
        for (const invalid of [
            args.slice(0, -1),
            ['--order-id', ORDER_ID],
            [...args, '--extra'],
            args.map(value => value === ORDER_ID ? 'not-an-id' : value),
            args.map(value => value === MANUAL_REVIEW_AT ? 'not-a-time' : value),
        ]) {
            expect(() => parseConciergeSnapshotConflictRecoveryArgs(invalid)).toThrow();
        }
    });

    it('prints only the bounded disposition and never identifiers', async () => {
        const recover = vi.fn(async () => ({
            applied: true,
            fulfillmentStatus: 'retryable_failure' as const,
        }));
        const writeStdout = vi.fn();
        await expect(runConciergeSnapshotConflictRecovery(args, {
            recover,
            writeStdout,
        })).resolves.toEqual({
            applied: true,
            status: 'retryable_failure',
        });
        expect(recover).toHaveBeenCalledWith({
            orderId: ORDER_ID,
            preflightId: PREFLIGHT_ID,
            expectedManualReviewAt: MANUAL_REVIEW_AT,
            expectedAdmissionRefreshedAt: ADMISSION_REFRESHED_AT,
        });
        const output = writeStdout.mock.calls[0]?.[0] as string;
        expect(output).toBe('{"applied":true,"status":"retryable_failure"}\n');
        expect(output).not.toContain(ORDER_ID);
        expect(output).not.toContain(PREFLIGHT_ID);
    });

    it('rejects unbounded or malformed RPC results before printing', async () => {
        const writeStdout = vi.fn();
        await expect(runConciergeSnapshotConflictRecovery(args, {
            recover: async () => ({
                applied: true,
                fulfillmentStatus: 'retryable_failure',
                orderId: ORDER_ID,
            }),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });

    it('binds the RPC to a server-derived normalized target identity hash', async () => {
        const callRecoveryRpc = vi.fn(async () => ([{
            applied: true,
            fulfillment_status: 'retryable_failure',
        }]));
        await expect(recoverWithServiceRole(
            parseConciergeSnapshotConflictRecoveryArgs(args),
            {
                loadTargetInstagramId: async () => 'Target.Name',
                callRecoveryRpc,
                env: {
                    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET:
                        Buffer.alloc(32, 7).toString('base64'),
                },
            },
        )).resolves.toEqual({
            applied: true,
            fulfillmentStatus: 'retryable_failure',
        });
        expect(callRecoveryRpc).toHaveBeenCalledOnce();
        expect(callRecoveryRpc).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_ID,
            preflightId: PREFLIGHT_ID,
            serverTargetInputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
    });

    it('does not call recovery when the stored target identity is malformed', async () => {
        const callRecoveryRpc = vi.fn();
        await expect(recoverWithServiceRole(
            parseConciergeSnapshotConflictRecoveryArgs(args),
            {
                loadTargetInstagramId: async () => 'not/a/username',
                callRecoveryRpc,
                env: {
                    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET:
                        Buffer.alloc(32, 7).toString('base64'),
                },
            },
        )).rejects.toThrow();
        expect(callRecoveryRpc).not.toHaveBeenCalled();
    });
});
