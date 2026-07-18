import { describe, expect, it } from 'vitest';
import {
    analysisCompletedEventKey,
    analysisStartedAtKey,
    analysisStartedEventKey,
    boundedDurationMs,
    claimAnalysisStart,
    claimObservedAnalysisStart,
    landingViewEventKey,
    preflightOutcomeEventKey,
    readAttribution,
    relationshipBucket,
    readAnalysisStartedAt,
    safeAnalyticsErrorCode,
    tryClaimAnalyticsEvent,
} from './analytics-funnel';

describe('Amplitude funnel helpers', () => {
    it.each([
        [undefined, 'unknown'],
        [null, 'unknown'],
        [-1, 'unknown'],
        [0, '0_400'],
        [400, '0_400'],
        [401, '401_800'],
        [800, '401_800'],
        [801, '801_1200'],
        [1_200, '801_1200'],
        [1_201, 'over_1200'],
    ] as const)('buckets relationship count %s as %s', (value, expected) => {
        expect(relationshipBucket(value)).toBe(expected);
    });

    it('accepts only the closed attribution vocabulary', () => {
        expect(readAttribution('')).toEqual({ source: 'direct', medium: 'direct' });
        expect(readAttribution(
            '?utm_source=instagram&utm_medium=paid_social&utm_campaign=launch_2026'
            + '&utm_content=hero-a&utm_term=detector',
        )).toEqual({
            source: 'instagram',
            medium: 'paid_social',
            campaign: 'launch_2026',
            content: 'hero-a',
            term: 'detector',
        });
        expect(readAttribution(
            '?utm_source=person%40example.com&utm_medium=https%3A%2F%2Fevil.test'
            + '&utm_campaign=secret&utm_content=%40raw_target&utm_term=token',
        )).toEqual({});
    });

    it('maps operational failures to the registered error vocabulary', () => {
        expect(safeAnalyticsErrorCode({ code: 'TARGET_NOT_FOUND' })).toBe('NOT_FOUND');
        expect(safeAnalyticsErrorCode({ code: 'TARGET_PRIVATE' })).toBe('VALIDATION_ERROR');
        expect(safeAnalyticsErrorCode({ code: 'AI_RATE_LIMITED' })).toBe('RATE_LIMITED');
        expect(safeAnalyticsErrorCode(new TypeError('network details must not escape')))
            .toBe('NETWORK_ERROR');
        expect(safeAnalyticsErrorCode({ code: 'person@example.com' })).toBe('UNKNOWN');
        expect(safeAnalyticsErrorCode('arbitrary raw message')).toBe('UNKNOWN');
    });

    it('builds non-PII lifecycle keys and bounds durations', () => {
        const requestId = '11111111-1111-4111-8111-111111111111';
        expect(landingViewEventKey()).toBe('amplitude:landing_viewed');
        expect(analysisStartedAtKey(requestId))
            .toBe(`amplitude:analysis_started_at:${requestId}`);
        expect(analysisStartedEventKey(requestId))
            .toBe(`amplitude:analysis_started:${requestId}`);
        expect(analysisCompletedEventKey(requestId))
            .toBe(`amplitude:analysis_completed:${requestId}`);
        expect(preflightOutcomeEventKey('succeeded', requestId))
            .toBe(`amplitude:preflight_succeeded:${requestId}`);
        expect(boundedDurationMs(2_000, 2_777.9)).toBe(777);
        expect(boundedDurationMs(5_000, 4_000)).toBe(0);
        expect(boundedDurationMs(0, Number.POSITIVE_INFINITY)).toBe(86_400_000);
    });

    it('claims a session event once and fails open when storage is unavailable', () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, value),
        };
        expect(tryClaimAnalyticsEvent(storage, 'amplitude:test')).toBe(true);
        expect(tryClaimAnalyticsEvent(storage, 'amplitude:test')).toBe(false);
        expect(tryClaimAnalyticsEvent({
            getItem: () => { throw new Error('blocked'); },
            setItem: () => { throw new Error('blocked'); },
        }, 'amplitude:test')).toBe(true);
    });

    it('deduplicates analysis start between entitlement and progress fallback', () => {
        const requestId = '11111111-1111-4111-8111-111111111111';
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, value),
        };

        expect(claimAnalysisStart(storage, requestId, 1_000)).toBe(true);
        expect(claimObservedAnalysisStart(storage, requestId, {
            requestId,
            status: 'processing',
        }, 2_000)).toBe(false);
        expect(readAnalysisStartedAt(storage, requestId)).toBe(1_000);
    });

    it('lets progress claim a missing start marker without throwing on blocked storage', () => {
        const requestId = '11111111-1111-4111-8111-111111111111';
        expect(claimObservedAnalysisStart(null, requestId, {
            requestId,
            status: 'pending',
        }, 1_000)).toBe(true);
        expect(claimObservedAnalysisStart({
            getItem: () => { throw new Error('blocked'); },
            setItem: () => { throw new Error('blocked'); },
        }, requestId, { requestId, status: 'processing' }, 1_000)).toBe(true);
        expect(readAnalysisStartedAt(null, requestId)).toBeNull();
        expect(claimAnalysisStart(null, 'not-a-request-id', 1_000)).toBe(false);
    });

    it('rejects terminal, failed, or mismatched progress observations', () => {
        const requestId = '11111111-1111-4111-8111-111111111111';
        const otherRequestId = '22222222-2222-4222-8222-222222222222';
        for (const status of ['completed', 'failed'] as const) {
            expect(claimObservedAnalysisStart(null, requestId, {
                requestId,
                status,
            }, 1_000)).toBe(false);
        }
        expect(claimObservedAnalysisStart(null, requestId, {
            requestId: otherRequestId,
            status: 'processing',
        }, 1_000)).toBe(false);
    });
});
