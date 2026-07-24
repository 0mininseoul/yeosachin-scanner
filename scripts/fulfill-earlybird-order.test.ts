import { describe, expect, it, vi } from 'vitest';
import {
    parseEarlybirdFulfillmentCliArgs,
    runEarlybirdFulfillmentCli,
} from './fulfill-earlybird-order';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';
const REQUEST = '223e4567-e89b-42d3-a456-426614174001';

describe('earlybird fulfillment operator CLI', () => {
    it('requires one order UUID and the exact paid-call confirmation flag', () => {
        expect(parseEarlybirdFulfillmentCliArgs([
            '--order-id',
            ORDER,
            '--confirm-paid-api-call',
        ])).toEqual({ orderId: ORDER });
        for (const args of [
            ['--order-id', ORDER],
            ['--confirm-paid-api-call'],
            ['--order-id', ORDER, '--confirm-paid-api-call', '--confirm-paid-api-call'],
            ['--order-id', ORDER, '--confirm-paid-api-call', '--username', 'private'],
            ['--order-id', ORDER, '--confirm-paid-api-call', '--plan', 'basic'],
            ['--order-id', ORDER, '--confirm-paid-api-call', '--token', 'secret'],
            ['--order-id', 'not-a-uuid', '--confirm-paid-api-call'],
        ]) {
            expect(() => parseEarlybirdFulfillmentCliArgs(args)).toThrow();
        }
    });

    it('prints only bounded fulfillment identifiers, state, and next action', async () => {
        const writeStdout = vi.fn();
        const fulfill = vi.fn(async () => ({
            orderId: ORDER,
            status: 'analysis_in_progress' as const,
            requestId: REQUEST,
            nextAction: 'monitor_analysis' as const,
        }));
        await expect(runEarlybirdFulfillmentCli([
            '--order-id',
            ORDER,
            '--confirm-paid-api-call',
        ], { fulfill, writeStdout })).resolves.toEqual({
            orderId: ORDER,
            status: 'analysis_in_progress',
            requestId: REQUEST,
            nextAction: 'monitor_analysis',
        });
        expect(fulfill).toHaveBeenCalledWith(ORDER);
        expect(writeStdout).toHaveBeenCalledWith(`${JSON.stringify({
            orderId: ORDER,
            status: 'analysis_in_progress',
            requestId: REQUEST,
            nextAction: 'monitor_analysis',
        }, null, 2)}\n`);
    });

    it('rejects identifier-bearing or unknown result fields before printing', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdFulfillmentCli([
            '--order-id',
            ORDER,
            '--confirm-paid-api-call',
        ], {
            fulfill: async () => ({
                orderId: ORDER,
                status: 'admission_pending',
                requestId: null,
                nextAction: 'wait_for_fresh_admission',
                targetInstagramId: 'private',
            }),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });
});
