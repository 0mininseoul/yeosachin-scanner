import { describe, expect, it } from 'vitest';
import { parseConfirmedAnalysisTestIssuerArgs } from './analysis-test-issuer-options';

describe('parseConfirmedAnalysisTestIssuerArgs', () => {
    const requiredOptions = ['--user', '--target', '--idempotency-key'] as const;

    it('accepts each required value with one exact valueless paid confirmation', () => {
        const parsed = parseConfirmedAnalysisTestIssuerArgs([
            '--user', 'user-id',
            '--confirm-paid-api-call',
            '--target', 'target-id',
            '--idempotency-key', 'idempotency-key',
        ], requiredOptions);

        expect(Object.fromEntries(parsed)).toEqual({
            '--user': 'user-id',
            '--target': 'target-id',
            '--idempotency-key': 'idempotency-key',
        });
    });

    it('rejects an issuer invocation without the paid confirmation', () => {
        expect(() => parseConfirmedAnalysisTestIssuerArgs([
            '--user', 'user-id',
            '--target', 'target-id',
            '--idempotency-key', 'idempotency-key',
        ], requiredOptions)).toThrow('--confirm-paid-api-call is required');
    });

    it('rejects a confirmation with an assigned value', () => {
        expect(() => parseConfirmedAnalysisTestIssuerArgs([
            '--user', 'user-id',
            '--target', 'target-id',
            '--idempotency-key', 'idempotency-key',
            '--confirm-paid-api-call=true',
        ], requiredOptions)).toThrow('--confirm-paid-api-call must be exact and valueless');
    });

    it('rejects repeated or unrecognized options', () => {
        expect(() => parseConfirmedAnalysisTestIssuerArgs([
            '--user', 'user-id',
            '--target', 'target-id',
            '--idempotency-key', 'idempotency-key',
            '--confirm-paid-api-call',
            '--confirm-paid-api-call',
        ], requiredOptions)).toThrow('--confirm-paid-api-call must appear exactly once');

        expect(() => parseConfirmedAnalysisTestIssuerArgs([
            '--user', 'user-id',
            '--target', 'target-id',
            '--idempotency-key', 'idempotency-key',
            '--confirm-paid-api-call',
            '--plan', 'standard',
        ], requiredOptions)).toThrow('unknown argument: --plan');
    });
});
