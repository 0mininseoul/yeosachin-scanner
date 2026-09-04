import {
    BETA_APIFY_FREE_CREDENTIAL_SLOTS,
    isBetaApifyFreeCredentialSlot,
    type BetaApifyFreeCredentialSlot,
} from './beta-apify-credit-pool';

export const BETA_APIFY_CREDIT_TELEMETRY_EVENTS = Object.freeze([
    'betatest_apify_credit.refresh_completed',
    'betatest_apify_credit.refresh_failed',
    'betatest_apify_credit.allocation_accepted',
    'betatest_apify_credit.allocation_rejected',
    'betatest_apify_credit.settlement_completed',
    'betatest_apify_credit.pool_health_observed',
] as const);

type BetaApifyCreditTelemetryEvent = typeof BETA_APIFY_CREDIT_TELEMETRY_EVENTS[number];
type Severity = 'info' | 'warn' | 'error';

export interface BetaApifyCreditTelemetry {
    emit(input: Readonly<{
        event: BetaApifyCreditTelemetryEvent;
        severity: Severity;
        fields: Record<string, number | string | boolean>;
    }>): void;
}

export interface BetaApifyCreditTelemetryInput {
    readonly event: BetaApifyCreditTelemetryEvent;
    readonly severity: Severity;
    readonly credentialSlot?: BetaApifyFreeCredentialSlot;
    readonly durationMs?: number;
    readonly totalEffectiveHeadroomUsd?: number;
    readonly reservationUsd?: number;
    readonly actualUsd?: number;
    readonly releasedUsd?: number;
    readonly staleSnapshotCount?: number;
    readonly settlementLagMs?: number;
    readonly activeAllocationCount?: number;
    readonly overcommittedSlotCount?: number;
    readonly runtimeEnabled?: boolean;
}

const MAX_USD = 100_000_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_SETTLEMENT_LAG_MS = 31_536_000_000;
const MAX_COUNT = 1_000_000;

function finite(value: unknown, maximum: number, integer = false): number | undefined {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 0
        && value <= maximum
        && (!integer || Number.isInteger(value))
        ? value
        : undefined;
}

/**
 * Emits only bounded aliases and aggregate values. It deliberately accepts neither
 * IDs nor provider response objects, and logging failures cannot affect admission
 * or settlement control flow.
 */
export function emitBetaApifyCreditTelemetry(
    telemetry: BetaApifyCreditTelemetry | undefined,
    input: BetaApifyCreditTelemetryInput,
): void {
    if (!telemetry) return;
    const fields: Record<string, number | string | boolean> = {};
    if (isBetaApifyFreeCredentialSlot(input.credentialSlot)) {
        fields.credential_slot = input.credentialSlot;
    }
    const values: readonly [key: string, value: unknown, maximum: number, integer?: boolean][] = [
        ['duration_ms', input.durationMs, MAX_DURATION_MS],
        ['total_effective_headroom_usd', input.totalEffectiveHeadroomUsd, MAX_USD],
        ['reservation_usd', input.reservationUsd, MAX_USD],
        ['actual_usd', input.actualUsd, MAX_USD],
        ['released_usd', input.releasedUsd, MAX_USD],
        ['stale_snapshot_count', input.staleSnapshotCount, BETA_APIFY_FREE_CREDENTIAL_SLOTS.length, true],
        ['settlement_lag_ms', input.settlementLagMs, MAX_SETTLEMENT_LAG_MS],
        ['active_allocation_count', input.activeAllocationCount, MAX_COUNT, true],
        ['overcommitted_slot_count', input.overcommittedSlotCount, BETA_APIFY_FREE_CREDENTIAL_SLOTS.length, true],
    ];
    for (const [key, value, maximum, integer] of values) {
        const safe = finite(value, maximum, integer);
        if (safe !== undefined) fields[key] = safe;
    }
    if (typeof input.runtimeEnabled === 'boolean') {
        fields.runtime_enabled = input.runtimeEnabled;
    }
    try {
        telemetry.emit({ event: input.event, severity: input.severity, fields });
    } catch {
        // Observability is explicitly best-effort.
    }
}

export const BETA_APIFY_CREDIT_TELEMETRY_SLOT_ALLOWLIST = BETA_APIFY_FREE_CREDENTIAL_SLOTS;
