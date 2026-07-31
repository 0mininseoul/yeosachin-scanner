import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('./server', () => ({
    operationalLogger: { emit: mocks.emit },
}));

import {
    emitPreflightProcessObservation,
    preflightWorkerErrorCode,
} from './preflight-events';
import { sanitizeOperationalEvent, type OperationalEvent } from './schema';
import type { PreflightProcessObservation } from '@/lib/services/analysis/preflight';

describe('preflight operational terminal codes', () => {
    it.each([
        ['auth', 'PROVIDER_ERROR'],
        ['circuit', 'PROVIDER_ERROR'],
        ['http', 'PROVIDER_ERROR'],
        ['rate_limit', 'RATE_LIMITED'],
        ['schema', 'PROVIDER_ERROR'],
        ['timeout', 'TIMEOUT'],
        ['transport', 'PROVIDER_ERROR'],
        ['configuration', 'JOB_DISPATCH_NOT_READY'],
        ['persistence', 'PREFLIGHT_PERSISTENCE_ERROR'],
        ['provider', 'PROVIDER_ERROR'],
        ['run_pending', 'PROVIDER_ERROR'],
        ['unknown', 'UNKNOWN'],
    ] as const)('normalizes %s to %s', (category, errorCode) => {
        expect(preflightWorkerErrorCode(category)).toBe(errorCode);
    });

    it('logs the safe cause for a blocked completion while retaining its public code', () => {
        emitPreflightProcessObservation({
            request_id: '123e4567-e89b-42d3-a456-426614174000',
            trace_id: null,
            route: '/api/analysis/preflight/worker',
            method: 'POST',
        }, {
            type: 'completed',
            outcome: 'blocked',
            preflightId: '223e4567-e89b-42d3-a456-426614174000',
            userId: '323e4567-e89b-42d3-a456-426614174000',
            targetInstagramId: 'target.name',
            errorCode: 'ANALYSIS_FAILED',
            failureCategory: 'configuration',
        });

        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'preflight.completed',
            fields: expect.objectContaining({
                error_code: 'JOB_DISPATCH_NOT_READY',
            }),
        }));
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain('ANALYSIS_FAILED');
    });

    it.each([
        'TARGET_NOT_FOUND',
        'TARGET_PRIVATE',
        'TARGET_UNSUPPORTED',
        'OVER_PLUS_CAPACITY',
    ] as const)('retains the bounded business completion code %s after sanitization', errorCode => {
        mocks.emit.mockClear();
        emitPreflightProcessObservation({
            request_id: '123e4567-e89b-42d3-a456-426614174000',
            trace_id: null,
            route: '/api/analysis/preflight/worker',
            method: 'POST',
        }, {
            type: 'completed',
            outcome: 'blocked',
            preflightId: '223e4567-e89b-42d3-a456-426614174000',
            userId: '323e4567-e89b-42d3-a456-426614174000',
            targetInstagramId: 'target.name',
            errorCode,
        });

        const emitted = mocks.emit.mock.calls[0]?.[0] as OperationalEvent;
        expect(sanitizeOperationalEvent(emitted).fields.error_code).toBe(errorCode);
    });

    it('drops an unregistered completion code after sanitization', () => {
        mocks.emit.mockClear();
        emitPreflightProcessObservation({
            request_id: '123e4567-e89b-42d3-a456-426614174000',
            trace_id: null,
            route: '/api/analysis/preflight/worker',
            method: 'POST',
        }, {
            type: 'completed',
            outcome: 'blocked',
            preflightId: '223e4567-e89b-42d3-a456-426614174000',
            userId: '323e4567-e89b-42d3-a456-426614174000',
            targetInstagramId: 'target.name',
            errorCode: 'RAW_PROVIDER_BODY' as never,
        });

        const emitted = mocks.emit.mock.calls[0]?.[0] as OperationalEvent;
        expect(sanitizeOperationalEvent(emitted).fields).not.toHaveProperty('error_code');
    });
});

describe('completed preflight observation type', () => {
    const base = {
        preflightId: '223e4567-e89b-42d3-a456-426614174000',
        userId: '323e4567-e89b-42d3-a456-426614174000',
        targetInstagramId: 'target.name',
    } as const;

    it('discriminates ready, business-blocked, and technical-blocked observations', () => {
        const ready = {
            ...base,
            type: 'completed',
            outcome: 'ready',
            requiredPlan: 'basic',
        } satisfies PreflightProcessObservation;
        const businessBlocked = {
            ...base,
            type: 'completed',
            outcome: 'blocked',
            errorCode: 'TARGET_NOT_FOUND',
        } satisfies PreflightProcessObservation;
        const technicalBlocked = {
            ...base,
            type: 'completed',
            outcome: 'blocked',
            errorCode: 'ANALYSIS_FAILED',
            failureCategory: 'provider',
        } satisfies PreflightProcessObservation;

        expect([ready, businessBlocked, technicalBlocked]).toHaveLength(3);
    });

    it('rejects invalid completed observation shapes at compile time', () => {
        // @ts-expect-error ready observations require their selected plan
        const readyWithoutPlan: PreflightProcessObservation = {
            ...base, type: 'completed', outcome: 'ready',
        };
        const readyWithError: PreflightProcessObservation = {
            ...base, type: 'completed', outcome: 'ready', requiredPlan: 'basic',
            // @ts-expect-error ready observations cannot carry terminal errors
            errorCode: 'TARGET_NOT_FOUND',
        };
        const businessWithFailure: PreflightProcessObservation = {
            ...base, type: 'completed', outcome: 'blocked', errorCode: 'TARGET_PRIVATE',
            // @ts-expect-error business blocks cannot carry a technical failure category
            failureCategory: 'provider',
        };
        // @ts-expect-error technical blocks require a normalized failure category
        const technicalWithoutFailure: PreflightProcessObservation = {
            ...base, type: 'completed', outcome: 'blocked', errorCode: 'ANALYSIS_FAILED',
        };

        expect([
            readyWithoutPlan,
            readyWithError,
            businessWithFailure,
            technicalWithoutFailure,
        ]).toHaveLength(4);
    });
});
