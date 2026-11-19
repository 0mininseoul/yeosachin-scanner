import { z } from 'zod';
import {
    EMPTY_VISITOR_METRICS,
    loadAmplitudeVisitorMetrics,
    type AmplitudeVisitorMetrics,
} from '@/lib/services/admin/amplitude-dashboard';

/** Start of the visitor → payer conversion window (11/19 00:00 KST). */
export const DEFAULT_CONVERSION_SINCE = '2026-11-19T00:00:00+09:00';

export function conversionSince(env: Record<string, string | undefined> = process.env): Date {
    const configured = env.ADMIN_CONSOLE_CONVERSION_SINCE?.trim();
    const parsed = new Date(configured || DEFAULT_CONVERSION_SINCE);
    return Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_CONVERSION_SINCE) : parsed;
}

type RpcClient = {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string; code?: string } | null;
    }>;
};

const usd = z.coerce.number().finite().nonnegative();
const nonNegativeInt = z.coerce.number().int().nonnegative();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const bucketSchema = z.object({
    start: day,
    payers: nonNegativeInt,
    basicPayers: nonNegativeInt,
    standardPayers: nonNegativeInt,
    /** Reconciled Apify usage + metered AI estimates (all calls, paid or not). */
    knownCostUsd: usd,
    /** knownCostUsd plus max charge / pre-call estimate of unsettled calls. */
    conservativeCostUsd: usd,
    preflightCostUsd: usd,
    analysisCostUsd: usd,
    aiCostUsd: usd,
    unsettledCalls: nonNegativeInt,
});

export const overviewRpcSchema = z.object({
    signups: z.object({ total: nonNegativeInt, today: nonNegativeInt, last7Days: nonNegativeInt }),
    payersSinceConversion: nonNegativeInt,
    daily: z.array(bucketSchema).length(14),
    weekly: z.array(bucketSchema).length(8),
});

export type OverviewRpcPayload = z.infer<typeof overviewRpcSchema>;

export type ConsoleOverviewBucket = z.infer<typeof bucketSchema> & { visitors: number | null };

export type ConsoleOverview = Readonly<{
    generatedAt: string;
    conversionSince: string;
    activeUsersNow: number | null;
    signups: OverviewRpcPayload['signups'];
    conversion: Readonly<{ payers: number; visitors: number | null; ratePercent: number | null }>;
    today: ConsoleOverviewBucket;
    daily: readonly ConsoleOverviewBucket[];
    weekly: readonly ConsoleOverviewBucket[];
    visitorSource: 'amplitude' | 'unavailable';
}>;

function attachVisitors(
    buckets: OverviewRpcPayload['daily'],
    visitors: AmplitudeVisitorMetrics['daily'],
    weekly: boolean,
): ConsoleOverviewBucket[] {
    if (!visitors) return buckets.map(bucket => ({ ...bucket, visitors: null }));
    if (!weekly) {
        const byDay = new Map(visitors.map(point => [point.start, point.visitors]));
        return buckets.map(bucket => ({ ...bucket, visitors: byDay.get(bucket.start) ?? null }));
    }
    // Amplitude decides its own week boundaries; match each DB week (Monday
    // start) to the Amplitude week that begins within it, else leave unknown.
    return buckets.map(bucket => {
        const start = Date.parse(`${bucket.start}T00:00:00Z`);
        const match = visitors.find(point => {
            const pointStart = Date.parse(`${point.start}T00:00:00Z`);
            return pointStart >= start - 86_400_000 && pointStart < start + 6 * 86_400_000;
        });
        return { ...bucket, visitors: match?.visitors ?? null };
    });
}

/** Pure assembly so the arithmetic is testable without network or DB. */
export function assembleConsoleOverview(input: {
    rpc: OverviewRpcPayload;
    visitors: AmplitudeVisitorMetrics;
    now: Date;
    conversionSince: Date;
}): ConsoleOverview {
    const daily = attachVisitors(input.rpc.daily, input.visitors.daily, false);
    const weekly = attachVisitors(input.rpc.weekly, input.visitors.weekly, true);
    const visitors = input.visitors.visitorsSinceConversion;
    const payers = input.rpc.payersSinceConversion;
    return {
        generatedAt: input.now.toISOString(),
        conversionSince: input.conversionSince.toISOString(),
        activeUsersNow: input.visitors.activeNow,
        signups: input.rpc.signups,
        conversion: {
            payers,
            visitors,
            ratePercent: visitors && visitors > 0 ? Math.round((payers / visitors) * 10_000) / 100 : null,
        },
        today: daily[daily.length - 1]!,
        daily,
        weekly,
        visitorSource: input.visitors === EMPTY_VISITOR_METRICS ? 'unavailable' : 'amplitude',
    };
}

export async function loadConsoleOverview(input: {
    client: RpcClient;
    now?: Date;
    env?: Record<string, string | undefined>;
}): Promise<ConsoleOverview> {
    const now = input.now ?? new Date();
    const since = conversionSince(input.env);
    const [rpcResult, visitors] = await Promise.all([
        input.client.rpc('load_admin_console_overview', {
            p_now: now.toISOString(),
            p_conversion_since: since.toISOString(),
        }),
        loadAmplitudeVisitorMetrics({ now, conversionSince: since, env: input.env })
            .catch(() => EMPTY_VISITOR_METRICS),
    ]);
    if (rpcResult.error) throw new Error('ADMIN_CONSOLE_OVERVIEW_UNAVAILABLE');
    const rpc = overviewRpcSchema.parse(rpcResult.data);
    return assembleConsoleOverview({ rpc, visitors, now, conversionSince: since });
}
