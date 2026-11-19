import { describe, expect, it } from 'vitest';
import {
    attributionLabelFromCookieHeader,
    classifyClientDevice,
} from '@/lib/services/admin/client-signals';
import {
    EMPTY_VISITOR_METRICS,
    loadAmplitudeVisitorMetrics,
    parseRealtimeActiveUsers,
    parseSegmentationSeries,
    parseSegmentationTotal,
} from '@/lib/services/admin/amplitude-dashboard';
import { assembleConsoleOverview, overviewRpcSchema } from '@/lib/services/admin/console-overview';
import {
    AdminConsoleCursorInvalidError,
    decodeLeadCursor,
    displayGender,
    encodeLeadCursor,
} from '@/lib/services/admin/console-records';

describe('admin console client signals', () => {
    it.each([
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0', 'iPhone · 카카오톡 인앱'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0', 'iPhone · 인스타 인앱'],
        ['Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'Android · 삼성 인터넷'],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 Edg/125.0', 'Windows · Edge'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36', 'Mac · Chrome'],
    ])('classifies %s', (userAgent, label) => {
        expect(classifyClientDevice(userAgent)).toBe(label);
    });

    it('returns null without a user agent', () => {
        expect(classifyClientDevice(null)).toBeNull();
        expect(classifyClientDevice('   ')).toBeNull();
    });

    it('reads only the bounded attribution label from the cookie header', () => {
        const value = encodeURIComponent('UTM: 인스타그램|https://l.instagram.com/');
        expect(attributionLabelFromCookieHeader(`a=1; kakao_signup_attribution=${value}`)).toBe('UTM: 인스타그램');
        expect(attributionLabelFromCookieHeader(`kakao_signup_attribution=${encodeURIComponent('<script>')}`)).toBeNull();
        expect(attributionLabelFromCookieHeader(null)).toBeNull();
    });
});

describe('amplitude dashboard parsing', () => {
    it('pairs daily uniques with dates and reads the range total', () => {
        const body = { data: { xValues: ['2026-11-18', '2026-11-19'], series: [[347, 296]], seriesCollapsed: [[{ value: 540 }]] } };
        expect(parseSegmentationSeries(body)).toEqual([
            { start: '2026-11-18', visitors: 347 },
            { start: '2026-11-19', visitors: 296 },
        ]);
        expect(parseSegmentationTotal(body)).toBe(540);
        expect(parseSegmentationSeries({ data: { xValues: ['2026-11-19'], series: [[1, 2]] } })).toBeNull();
    });

    it('takes the latest reported bucket of today', () => {
        expect(parseRealtimeActiveUsers({
            data: { xValues: ['14:00', '14:05', '14:10'], seriesLabels: ['Today', 'Yesterday'], series: [[20, 23, null], [9, 9, 9]] },
        })).toBe(23);
        expect(parseRealtimeActiveUsers({ nope: true })).toBeNull();
    });

    it('returns empty metrics without credentials', async () => {
        const metrics = await loadAmplitudeVisitorMetrics({
            now: new Date('2026-11-19T05:00:00Z'),
            conversionSince: new Date('2026-11-18T15:00:00Z'),
            env: {},
        });
        expect(metrics).toBe(EMPTY_VISITOR_METRICS);
    });
});

describe('console overview assembly', () => {
    const bucket = (start: string, payers = 0) => ({
        start, payers, basicPayers: 0, standardPayers: payers,
        knownCostUsd: 1.5, conservativeCostUsd: 2, preflightCostUsd: 0.5, analysisCostUsd: 0.7, aiCostUsd: 0.3,
        unsettledCalls: 0,
    });
    const days = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 10, 6 + index));
        return date.toISOString().slice(0, 10);
    });
    const rpc = overviewRpcSchema.parse({
        signups: { total: 4812, today: 37, last7Days: 214 },
        payersSinceConversion: 4,
        daily: days.map((day, index) => bucket(day, index === 13 ? 4 : 1)),
        weekly: ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']
            .map(week => bucket(week, 5)),
    });

    it('computes conversion and keeps unknown visitors as null', () => {
        const overview = assembleConsoleOverview({
            rpc,
            visitors: {
                activeNow: 23,
                daily: [{ start: '2026-11-19', visitors: 296 }],
                weekly: [{ start: '2026-11-15', visitors: 1904 }],
                visitorsSinceConversion: 296,
            },
            now: new Date('2026-11-19T05:00:00Z'),
            conversionSince: new Date('2026-11-18T15:00:00Z'),
        });
        expect(overview.conversion).toEqual({ payers: 4, visitors: 296, ratePercent: 1.35 });
        expect(overview.today.start).toBe('2026-11-19');
        expect(overview.today.visitors).toBe(296);
        expect(overview.daily[0]!.visitors).toBeNull();
        // Amplitude's Sunday-start week maps onto the DB's Monday-start week.
        expect(overview.weekly[7]!.visitors).toBe(1904);
        expect(overview.visitorSource).toBe('amplitude');
    });

    it('never divides by an unknown visitor count', () => {
        const overview = assembleConsoleOverview({
            rpc, visitors: EMPTY_VISITOR_METRICS,
            now: new Date('2026-11-19T05:00:00Z'), conversionSince: new Date('2026-11-18T15:00:00Z'),
        });
        expect(overview.conversion.ratePercent).toBeNull();
        expect(overview.activeUsersNow).toBeNull();
        expect(overview.visitorSource).toBe('unavailable');
    });
});

describe('console records helpers', () => {
    it('round-trips lead cursors and rejects tampered ones', () => {
        const cursor = encodeLeadCursor('2026-11-19T05:05:00.000+00:00', '123e4567-e89b-42d3-a456-426614174000');
        expect(decodeLeadCursor(cursor)).toEqual({
            createdAt: '2026-11-19T05:05:00.000+00:00', id: '123e4567-e89b-42d3-a456-426614174000',
        });
        expect(() => decodeLeadCursor('not-a-cursor')).toThrow(AdminConsoleCursorInvalidError);
    });

    it('normalizes gender values', () => {
        expect(displayGender('female')).toBe('여성');
        expect(displayGender('남성')).toBe('남성');
        expect(displayGender('other')).toBeNull();
    });
});
