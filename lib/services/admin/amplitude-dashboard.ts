import { z } from 'zod';

/**
 * Server-side reader for Amplitude's Dashboard REST API (visitor counts only).
 * Requires AMPLITUDE_API_KEY (or NEXT_PUBLIC_AMPLITUDE_API_KEY) and
 * AMPLITUDE_SECRET_KEY. Any failure yields null so the console shows "미상"
 * instead of inventing a number.
 */

const DEFAULT_BASE_URL = 'https://amplitude.com';
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
/** Amplitude's built-in event that matches any active user. */
const ACTIVE_EVENT = JSON.stringify({ event_type: '_active' });

export type AmplitudeCredentials = Readonly<{ apiKey: string; secretKey: string; baseUrl: string }>;

export type VisitorSeriesPoint = Readonly<{ start: string; visitors: number }>;

export type AmplitudeVisitorMetrics = Readonly<{
    activeNow: number | null;
    daily: readonly VisitorSeriesPoint[] | null;
    weekly: readonly VisitorSeriesPoint[] | null;
    visitorsSinceConversion: number | null;
}>;

export const EMPTY_VISITOR_METRICS: AmplitudeVisitorMetrics = Object.freeze({
    activeNow: null, daily: null, weekly: null, visitorsSinceConversion: null,
});

export function amplitudeCredentials(
    env: Record<string, string | undefined> = process.env,
): AmplitudeCredentials | null {
    const apiKey = (env.AMPLITUDE_API_KEY ?? env.NEXT_PUBLIC_AMPLITUDE_API_KEY)?.trim();
    const secretKey = env.AMPLITUDE_SECRET_KEY?.trim();
    if (!apiKey || !secretKey) return null;
    const baseUrl = env.AMPLITUDE_DASHBOARD_BASE_URL?.trim() || DEFAULT_BASE_URL;
    if (baseUrl !== DEFAULT_BASE_URL && baseUrl !== 'https://analytics.eu.amplitude.com') return null;
    return { apiKey, secretKey, baseUrl };
}

const count = z.number().finite().nonnegative();

const segmentationSchema = z.object({
    data: z.object({
        xValues: z.array(z.string()),
        series: z.array(z.array(count)),
        seriesCollapsed: z.array(z.array(z.object({ value: count }))).optional(),
    }),
});

const realtimeSchema = z.object({
    data: z.object({
        xValues: z.array(z.string()),
        series: z.array(z.array(count.nullable())),
        seriesLabels: z.array(z.string()).optional(),
    }),
});

/** Pairs Amplitude's xValues with the first series (no group-by is requested). */
export function parseSegmentationSeries(body: unknown): VisitorSeriesPoint[] | null {
    const parsed = segmentationSchema.safeParse(body);
    if (!parsed.success) return null;
    const values = parsed.data.data.series[0];
    if (!values || values.length !== parsed.data.data.xValues.length) return null;
    return parsed.data.data.xValues.map((start, index) => ({
        start: start.slice(0, 10),
        visitors: Math.round(values[index]!),
    }));
}

/** Unique users over the whole requested range (the bar-chart value). */
export function parseSegmentationTotal(body: unknown): number | null {
    const parsed = segmentationSchema.safeParse(body);
    const value = parsed.success ? parsed.data.data.seriesCollapsed?.[0]?.[0]?.value : undefined;
    return value === undefined ? null : Math.round(value);
}

/** Latest reported 5-minute bucket of today's real-time series. */
export function parseRealtimeActiveUsers(body: unknown): number | null {
    const parsed = realtimeSchema.safeParse(body);
    if (!parsed.success) return null;
    const labels = parsed.data.data.seriesLabels;
    const todayIndex = labels ? Math.max(0, labels.findIndex(label => /today/i.test(label))) : 0;
    const today = parsed.data.data.series[todayIndex] ?? [];
    for (let index = today.length - 1; index >= 0; index -= 1) {
        const value = today[index];
        if (typeof value === 'number') return Math.round(value);
    }
    return null;
}

/** YYYYMMDD in the given IANA time zone. */
export function amplitudeDate(value: Date, timeZone = 'Asia/Seoul'): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(value);
    return parts.replaceAll('-', '');
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function getJson(
    credentials: AmplitudeCredentials,
    path: string,
    params: Record<string, string>,
    fetchImpl: FetchLike,
): Promise<unknown | null> {
    const url = new URL(path, credentials.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const auth = Buffer.from(`${credentials.apiKey}:${credentials.secretKey}`).toString('base64');
    try {
        const response = await fetchImpl(url.toString(), {
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

let cache: { key: string; expiresAt: number; value: AmplitudeVisitorMetrics } | null = null;

export async function loadAmplitudeVisitorMetrics(input: {
    now: Date;
    conversionSince: Date;
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
}): Promise<AmplitudeVisitorMetrics> {
    const credentials = amplitudeCredentials(input.env);
    if (!credentials) return EMPTY_VISITOR_METRICS;
    const fetchImpl = input.fetchImpl ?? fetch;
    const end = amplitudeDate(input.now);
    const dailyStart = amplitudeDate(new Date(input.now.getTime() - 13 * 86_400_000));
    const weeklyStart = amplitudeDate(new Date(input.now.getTime() - 55 * 86_400_000));
    const conversionStart = amplitudeDate(input.conversionSince);
    const cacheKey = `${end}:${conversionStart}:${credentials.baseUrl}`;
    if (!input.fetchImpl && cache && cache.key === cacheKey && cache.expiresAt > Date.now()) {
        return cache.value;
    }

    // Four requests stay under Amplitude's 5-concurrent-request limit.
    const [realtime, daily, weekly, sinceConversion] = await Promise.all([
        getJson(credentials, '/api/2/realtime', { i: '5' }, fetchImpl),
        getJson(credentials, '/api/2/events/segmentation',
            { e: ACTIVE_EVENT, m: 'uniques', i: '1', start: dailyStart, end }, fetchImpl),
        getJson(credentials, '/api/2/events/segmentation',
            { e: ACTIVE_EVENT, m: 'uniques', i: '7', start: weeklyStart, end }, fetchImpl),
        getJson(credentials, '/api/2/events/segmentation',
            { e: ACTIVE_EVENT, m: 'uniques', i: '1', start: conversionStart, end }, fetchImpl),
    ]);
    const value: AmplitudeVisitorMetrics = {
        activeNow: parseRealtimeActiveUsers(realtime),
        daily: parseSegmentationSeries(daily),
        weekly: parseSegmentationSeries(weekly),
        visitorsSinceConversion: parseSegmentationTotal(sinceConversion),
    };
    if (!input.fetchImpl) cache = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
}
