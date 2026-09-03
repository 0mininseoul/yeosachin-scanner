import { z } from 'zod';
import {
    emitBetaApifyCreditTelemetry,
    type BetaApifyCreditTelemetry,
} from './beta-apify-credit-telemetry';
import { BETA_APIFY_FREE_CREDENTIAL_SLOTS } from './beta-apify-credit-pool';

export const BETA_APIFY_POOL_OBSERVABILITY_RPC =
    'load_analysis_beta_apify_pool_observability';
export const BETA_APIFY_POOL_OBSERVABILITY_VALIDATION_ERROR =
    'ANALYSIS_BETA_POOL_OBSERVABILITY_VALIDATION_ERROR';
export const BETA_APIFY_POOL_OBSERVABILITY_PERSISTENCE_ERROR =
    'ANALYSIS_BETA_POOL_OBSERVABILITY_PERSISTENCE_ERROR';

const aggregateSchema = z.object({
    schemaVersion: z.literal(1),
    observedAt: z.string().datetime({ offset: true }),
    runtimeEnabled: z.boolean(),
    totalEffectiveHeadroomUsd: z.number().finite().min(0).max(100_000_000),
    staleSnapshotCount: z.number().int().min(0).max(BETA_APIFY_FREE_CREDENTIAL_SLOTS.length),
    activeAllocationCount: z.number().int().min(0).max(1_000_000),
    settlementLagMs: z.number().int().min(0).max(31_536_000_000),
    overcommittedSlotCount: z.number().int().min(0).max(BETA_APIFY_FREE_CREDENTIAL_SLOTS.length),
}).strict();

export type BetaApifyPoolObservability = z.infer<typeof aggregateSchema>;

export interface BetaApifyPoolObservabilityClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

export async function loadBetaApifyPoolObservability(
    client: BetaApifyPoolObservabilityClient,
    maxSnapshotAgeSeconds = 300,
): Promise<BetaApifyPoolObservability> {
    if (
        !Number.isSafeInteger(maxSnapshotAgeSeconds)
        || maxSnapshotAgeSeconds < 1
        || maxSnapshotAgeSeconds > 900
    ) {
        throw new Error(BETA_APIFY_POOL_OBSERVABILITY_VALIDATION_ERROR);
    }
    let result: Awaited<ReturnType<BetaApifyPoolObservabilityClient['rpc']>>;
    try {
        result = await client.rpc(BETA_APIFY_POOL_OBSERVABILITY_RPC, {
            p_max_age_seconds: maxSnapshotAgeSeconds,
        });
    } catch {
        throw new Error(BETA_APIFY_POOL_OBSERVABILITY_PERSISTENCE_ERROR);
    }
    if (result.error) {
        throw new Error(BETA_APIFY_POOL_OBSERVABILITY_PERSISTENCE_ERROR);
    }
    const data = Array.isArray(result.data) && result.data.length === 1
        ? result.data[0]
        : result.data;
    const parsed = aggregateSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error(BETA_APIFY_POOL_OBSERVABILITY_PERSISTENCE_ERROR);
    }
    return Object.freeze(parsed.data);
}

/** Scheduled health observation; both aggregate lookup and logging are fail-open. */
export async function observeBetaApifyPoolHealth(
    client: BetaApifyPoolObservabilityClient,
    telemetry: BetaApifyCreditTelemetry,
    maxSnapshotAgeSeconds = 300,
): Promise<boolean> {
    try {
        const aggregate = await loadBetaApifyPoolObservability(
            client, maxSnapshotAgeSeconds
        );
        emitBetaApifyCreditTelemetry(telemetry, {
            event: 'betatest_apify_credit.pool_health_observed',
            severity: aggregate.staleSnapshotCount > 0
                || aggregate.overcommittedSlotCount > 0
                || aggregate.settlementLagMs > 15 * 60 * 1_000
                ? 'warn'
                : 'info',
            totalEffectiveHeadroomUsd: aggregate.totalEffectiveHeadroomUsd,
            staleSnapshotCount: aggregate.staleSnapshotCount,
            activeAllocationCount: aggregate.activeAllocationCount,
            settlementLagMs: aggregate.settlementLagMs,
            overcommittedSlotCount: aggregate.overcommittedSlotCount,
            runtimeEnabled: aggregate.runtimeEnabled,
        });
        return true;
    } catch {
        return false;
    }
}
