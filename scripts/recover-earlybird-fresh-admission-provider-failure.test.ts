import { describe, expect, it, vi } from 'vitest';
import {
    parseEarlybirdFreshAdmissionProviderRecoveryCliArgs,
    runEarlybirdFreshAdmissionProviderRecoveryCli,
} from './recover-earlybird-fresh-admission-provider-failure';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';

describe('fresh-admission provider failure recovery CLI', () => {
    it('requires the order UUID and exact incident confirmation', () => {
        expect(parseEarlybirdFreshAdmissionProviderRecoveryCliArgs([
            '--order-id',
            ORDER,
            '--confirm-fresh-admission-provider-recovery',
        ])).toEqual({ orderId: ORDER });

        for (const args of [
            ['--order-id', ORDER],
            ['--confirm-fresh-admission-provider-recovery'],
            ['--order-id', 'not-a-uuid', '--confirm-fresh-admission-provider-recovery'],
            ['--order-id', ORDER, '--confirm-fresh-admission-provider-recovery', '--extra'],
        ]) {
            expect(() => (
                parseEarlybirdFreshAdmissionProviderRecoveryCliArgs(args)
            )).toThrow();
        }
    });

    it('prints only a bounded disposition without identifiers', async () => {
        const writeStdout = vi.fn();
        const recover = vi.fn(async () => ({
            orderId: ORDER,
            status: 'admission_pending' as const,
            requestId: null,
            nextAction: 'wait_for_fresh_admission' as const,
        }));

        await expect(runEarlybirdFreshAdmissionProviderRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-fresh-admission-provider-recovery',
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

    it('rejects a recovery result for a different order before printing it', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdFreshAdmissionProviderRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-fresh-admission-provider-recovery',
        ], {
            recover: async () => ({
                orderId: '223e4567-e89b-42d3-a456-426614174001',
                status: 'completed',
                requestId: '323e4567-e89b-42d3-a456-426614174001',
                nextAction: 'completed',
            }),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });

    it('rejects identifier-bearing output before printing it', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdFreshAdmissionProviderRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-fresh-admission-provider-recovery',
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
