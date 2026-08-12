import { describe, expect, it } from 'vitest';
import {
    analysisCompletedEventKey,
    analysisStartedAtKey,
    analysisStartedEventKey,
    boundedDurationMs,
    claimAnalysisStart,
    claimObservedAnalysisStart,
    currentAttributionSource,
    landingViewEventKey,
    classifyPreflightAnalyticsOutcome,
    preflightOutcomeEventKey,
    readAttribution,
    readAnalyticsAttribution,
    markSharedAttribution,
    relationshipBucket,
    readAnalysisStartedAt,
    safeAnalyticsErrorCode,
    tryClaimAnalyticsEvent,
} from './analytics-funnel';
import * as analyticsFunnel from './analytics-funnel';

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
        expect(readAttribution('?utm_source=google&utm_medium=organic')).toEqual({
            source: 'google',
            medium: 'organic',
        });
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
        expect(readAttribution('?utm_source=kakao&utm_medium=referral')).toEqual({
            source: 'kakao',
            medium: 'referral',
        });
        expect(readAttribution(
            '?utm_source=person%40example.com&utm_medium=https%3A%2F%2Fevil.test'
            + '&utm_campaign=secret&utm_content=%40raw_target&utm_term=token',
        )).toEqual({});
    });

    it('normalizes ChatGPT Search referrals and supplies only a missing medium', () => {
        expect(readAttribution('?utm_source=chatgpt.com')).toEqual({
            source: 'chatgpt',
            medium: 'referral',
        });
        expect(readAttribution(
            '?utm_source=chatgpt.com&utm_medium=organic',
        )).toEqual({
            source: 'chatgpt',
            medium: 'organic',
        });
    });

    it('never returns raw or arbitrary attribution values', () => {
        const attribution = readAttribution(
            '?utm_source=https%3A%2F%2Fchatgpt.com%2Fshare%2Fsecret'
            + '&utm_medium=private-referrer&utm_campaign=raw-query'
            + '&utm_content=person%40example.com&utm_term=token',
        );

        expect(attribution).toEqual({});
        expect(Object.keys(attribution)).toEqual([]);
        expect(JSON.stringify(attribution)).not.toMatch(
            /https?:|chatgpt\.com|private-referrer|raw-query|person@|token/,
        );
    });

    it('maps operational failures to the registered error vocabulary', () => {
        expect(safeAnalyticsErrorCode({ code: 'TARGET_NOT_FOUND' })).toBe('TARGET_NOT_FOUND');
        expect(safeAnalyticsErrorCode({ code: 'TARGET_PRIVATE' })).toBe('TARGET_PRIVATE');
        expect(safeAnalyticsErrorCode({ code: 'AI_RATE_LIMITED' })).toBe('RATE_LIMITED');
        expect(safeAnalyticsErrorCode(new TypeError('network details must not escape')))
            .toBe('NETWORK_ERROR');
        expect(safeAnalyticsErrorCode({ code: 'person@example.com' })).toBe('UNKNOWN');
        expect(safeAnalyticsErrorCode('arbitrary raw message')).toBe('UNKNOWN');
    });

    it('attributes a valid share visit without persisting the opaque token', () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, value),
        };
        expect(markSharedAttribution(storage)).toBe(true);
        expect(currentAttributionSource(storage)).toBe('shared');
        expect(readAnalyticsAttribution('', storage)).toEqual({
            source: 'shared',
            medium: 'referral',
        });
        expect(JSON.stringify(values)).not.toMatch(/token|instagram|target/);
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
        expect(preflightOutcomeEventKey('blocked', requestId))
            .toBe(`amplitude:preflight_blocked:${requestId}`);
        expect(preflightOutcomeEventKey('failed', requestId))
            .toBe(`amplitude:preflight_failed:${requestId}`);
        expect(boundedDurationMs(2_000, 2_777.9)).toBe(777);
        expect(boundedDurationMs(5_000, 4_000)).toBe(0);
        expect(boundedDurationMs(0, Number.POSITIVE_INFINITY)).toBe(86_400_000);
    });

    it.each([
        ['TARGET_NOT_FOUND'],
        ['TARGET_PRIVATE'],
        ['TARGET_UNSUPPORTED'],
        ['OVER_PLUS_CAPACITY'],
        ['BETA_CAPACITY_UNAVAILABLE'],
    ])('classifies business block %s separately from failures', (code) => {
        expect(classifyPreflightAnalyticsOutcome('blocked', code)).toBe('blocked');
    });

    it.each([
        ['PROVIDER_ERROR'],
        ['QUEUE_UNAVAILABLE'],
        ['ANALYSIS_FAILED'],
        ['UNRECOGNIZED_CODE'],
        [undefined],
    ])('classifies technical or unknown terminal block %s as failed', (code) => {
        expect(classifyPreflightAnalyticsOutcome('blocked', code)).toBe('failed');
    });

    it('classifies ready preflight as succeeded regardless of code', () => {
        expect(classifyPreflightAnalyticsOutcome('ready')).toBe('succeeded');
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

    it('restores a persisted wall-clock preflight start after a simulated reload', () => {
        const helpers = analyticsFunnel as typeof analyticsFunnel & {
            persistPreflightStartedAt: (
                storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
                preflightId: string,
                startedAt: number,
            ) => boolean;
            preflightStartedAtKey: (preflightId: string) => string;
            readPreflightStartedAt: (
                storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
                preflightId: string,
            ) => number | null;
            trustedDurationMs: (startedAt: number | null, finishedAt: number) => number | undefined;
        };
        expect(typeof helpers.persistPreflightStartedAt).toBe('function');
        expect(typeof helpers.preflightStartedAtKey).toBe('function');
        expect(typeof helpers.readPreflightStartedAt).toBe('function');
        expect(typeof helpers.trustedDurationMs).toBe('function');
        if (
            !helpers.persistPreflightStartedAt
            || !helpers.preflightStartedAtKey
            || !helpers.readPreflightStartedAt
            || !helpers.trustedDurationMs
        ) return;

        const preflightId = '11111111-1111-4111-8111-111111111111';
        const values = new Map<string, string>();
        const firstPageStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, value),
        };
        expect(helpers.persistPreflightStartedAt(firstPageStorage, preflightId, 10_000))
            .toBe(true);
        expect(helpers.preflightStartedAtKey(preflightId))
            .toBe(`amplitude:preflight_started_at:${preflightId}`);

        const reloadedPageStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, value),
        };
        const restored = helpers.readPreflightStartedAt(reloadedPageStorage, preflightId);
        expect(restored).toBe(10_000);
        expect(helpers.trustedDurationMs(restored, 25_500)).toBe(15_500);
    });

    it('omits duration when no trustworthy analysis start is persisted', () => {
        const helpers = analyticsFunnel as typeof analyticsFunnel & {
            trustedDurationMs: (startedAt: number | null, finishedAt: number) => number | undefined;
        };
        expect(typeof helpers.trustedDurationMs).toBe('function');
        if (!helpers.trustedDurationMs) return;

        expect(helpers.trustedDurationMs(null, 25_500)).toBeUndefined();
        expect(helpers.trustedDurationMs(Number.NaN, 25_500)).toBeUndefined();
        expect(helpers.trustedDurationMs(30_000, 25_500)).toBeUndefined();
        expect(helpers.trustedDurationMs(10_000, Number.POSITIVE_INFINITY)).toBeUndefined();
    });
});
