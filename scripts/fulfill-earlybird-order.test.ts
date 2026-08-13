import { describe, expect, it, vi } from 'vitest';
import {
    diagnoseEarlybirdFulfillmentError,
    EarlybirdFulfillmentError,
} from '../lib/services/earlybird/fulfillment-store';
import * as fulfillmentCli from './fulfill-earlybird-order';
import {
    parseEarlybirdFulfillmentCliArgs,
    runEarlybirdFulfillmentCli,
} from './fulfill-earlybird-order';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';
const REQUEST = '223e4567-e89b-42d3-a456-426614174001';

describe('earlybird fulfillment operator CLI', () => {
    it('formats only the safe stage/category/code from a diagnosed failure', () => {
        const secret = 'supabase-service-role-secret';
        const error = new EarlybirdFulfillmentError(
            'ANALYSIS_V2_FRESH_ADMISSION_ERROR',
            {
                stage: 'reserve',
                category: 'persistence',
                cause: new Error(`RPC detail ${secret}`),
            }
        );
        const output = fulfillmentCli.formatEarlybirdFulfillmentCliFailure(error);

        expect(output).toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_FRESH_ADMISSION_ERROR',
            stage: 'reserve',
            category: 'persistence',
        });
        expect(JSON.stringify(output)).not.toContain(secret);
    });

    it('keeps the legacy catch-all shape for an unstructured CLI failure', () => {
        expect(fulfillmentCli.formatEarlybirdFulfillmentCliFailure(
            new Error('unstructured secret detail')
        )).toEqual({
            status: 'failed',
            errorCode: 'EARLYBIRD_FULFILLMENT_FAILED',
        });
    });

    it('does not serialize a raw plain-object cause', () => {
        const cause = { secret: 'raw-object-secret', nested: { value: 42 } };
        const error = new EarlybirdFulfillmentError(
            'ANALYSIS_V2_FRESH_ADMISSION_ERROR',
            {
                stage: 'reserve',
                category: 'persistence',
                cause,
            }
        );

        expect(error.cause).toBe(cause);
        expect(Object.keys(error)).not.toContain('cause');
        expect(JSON.stringify(error)).not.toContain('raw-object-secret');
    });

    it('rejects arbitrary prefixed diagnostic codes', () => {
        const diagnosed = diagnoseEarlybirdFulfillmentError(
            new Error('ANALYSIS_V2_ARBITRARY_CODE: sensitive detail'),
            'reserve'
        );

        expect(diagnosed.code).toBe('EARLYBIRD_FULFILLMENT_FAILED');
        expect(fulfillmentCli.formatEarlybirdFulfillmentCliFailure(diagnosed)).toEqual({
            status: 'failed',
            errorCode: 'EARLYBIRD_FULFILLMENT_FAILED',
            stage: 'reserve',
            category: 'unknown',
        });
    });

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
