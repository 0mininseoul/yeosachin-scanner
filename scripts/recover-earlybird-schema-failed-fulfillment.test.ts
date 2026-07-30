import { describe, expect, it, vi } from 'vitest';
import {
    parseEarlybirdSchemaFailureRecoveryCliArgs,
    runEarlybirdSchemaFailureRecoveryCli,
} from './recover-earlybird-schema-failed-fulfillment';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';

describe('earlybird schema-failure recovery operator CLI', () => {
    it('requires one order UUID and the exact schema-failure confirmation flag', () => {
        expect(parseEarlybirdSchemaFailureRecoveryCliArgs([
            '--order-id',
            ORDER,
            '--confirm-schema-failure-recovery',
        ])).toEqual({ orderId: ORDER });
        for (const args of [
            ['--order-id', ORDER],
            ['--confirm-schema-failure-recovery'],
            ['--order-id', ORDER, '--confirm-schema-failure-recovery', '--confirm-schema-failure-recovery'],
            ['--order-id', ORDER, '--confirm-schema-failure-recovery', '--request-id', 'private'],
            ['--order-id', 'not-a-uuid', '--confirm-schema-failure-recovery'],
        ]) {
            expect(() => parseEarlybirdSchemaFailureRecoveryCliArgs(args)).toThrow();
        }
    });

    it('prints only the bounded recovery disposition', async () => {
        const writeStdout = vi.fn();
        const recover = vi.fn(async () => ({
            status: 'admission_pending' as const,
            nextAction: 'wait_for_fresh_admission' as const,
        }));
        await expect(runEarlybirdSchemaFailureRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-schema-failure-recovery',
        ], { recover, writeStdout })).resolves.toEqual({
            status: 'admission_pending',
            nextAction: 'wait_for_fresh_admission',
        });
        expect(recover).toHaveBeenCalledWith(ORDER);
        expect(writeStdout).toHaveBeenCalledWith(`${JSON.stringify({
            status: 'admission_pending',
            nextAction: 'wait_for_fresh_admission',
        })}\n`);
    });

    it('rejects identifier-bearing recovery output before printing', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdSchemaFailureRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-schema-failure-recovery',
        ], {
            recover: async () => ({
                status: 'admission_pending',
                nextAction: 'wait_for_fresh_admission',
                requestId: 'private',
            }),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });
});
