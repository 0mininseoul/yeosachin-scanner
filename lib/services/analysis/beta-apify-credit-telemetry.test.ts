import { describe, expect, it, vi } from 'vitest';
import { sanitizeOperationalEvent } from '@/lib/observability/schema';
import {
    emitBetaApifyCreditTelemetry,
    type BetaApifyCreditTelemetry,
} from './beta-apify-credit-telemetry';

describe('beta Apify credit telemetry boundary', () => {
    it('emits the bounded pool health and USD coverage without identities or provider payloads', () => {
        const emit = vi.fn();
        const telemetry: BetaApifyCreditTelemetry = { emit };

        emitBetaApifyCreditTelemetry(telemetry, {
            event: 'betatest_apify_credit.refresh_completed',
            severity: 'info',
            credentialSlot: 'primary',
            durationMs: 125,
            totalEffectiveHeadroomUsd: 4.5,
            staleSnapshotCount: 0,
            activeAllocationCount: 2,
            token: 'must-not-pass',
            providerAccountId: 'must-not-pass',
            userId: '123e4567-e89b-42d3-a456-426614174000',
            rawProviderPayload: { token: 'must-not-pass' },
        } as never);

        expect(emit).toHaveBeenCalledWith({
            event: 'betatest_apify_credit.refresh_completed',
            severity: 'info',
            fields: {
                credential_slot: 'primary',
                duration_ms: 125,
                total_effective_headroom_usd: 4.5,
                stale_snapshot_count: 0,
                active_allocation_count: 2,
            },
        });
        expect(JSON.stringify(emit.mock.calls)).not.toMatch(
            /must-not-pass|123e4567-e89b-42d3-a456-426614174000|rawProviderPayload/
        );
    });

    it('rejects secondary and malformed fields at both beta and global log boundaries', () => {
        const emit = vi.fn();
        emitBetaApifyCreditTelemetry({ emit }, {
            event: 'betatest_apify_credit.allocation_rejected',
            severity: 'warn',
            credentialSlot: 'secondary' as never,
            reservationUsd: Number.NaN,
            actualUsd: -1,
            releasedUsd: Number.POSITIVE_INFINITY,
            settlementLagMs: -1,
            staleSnapshotCount: 7,
        });

        const input = emit.mock.calls[0]?.[0];
        expect(input).toEqual({
            event: 'betatest_apify_credit.allocation_rejected',
            severity: 'warn',
            fields: {},
        });
        expect(sanitizeOperationalEvent(input).fields).not.toHaveProperty('credential_slot');
        expect(sanitizeOperationalEvent(input).fields).not.toHaveProperty('reservation_usd');
        expect(sanitizeOperationalEvent({
            event: 'betatest_apify_credit.pool_health_observed',
            severity: 'warn', fields: { stale_snapshot_count: 7 },
        }).fields).not.toHaveProperty('stale_snapshot_count');
    });

    it('never lets telemetry failure change the caller outcome', () => {
        expect(() => emitBetaApifyCreditTelemetry({
            emit: () => { throw new Error('logger unavailable'); },
        }, {
            event: 'betatest_apify_credit.settlement_completed',
            severity: 'info',
            actualUsd: 0.1,
            releasedUsd: 0.2,
        })).not.toThrow();
    });

    it('keeps multi-day settlement lag visible and bounds invariant counts', () => {
        const emit = vi.fn();
        emitBetaApifyCreditTelemetry({ emit }, {
            event: 'betatest_apify_credit.pool_health_observed',
            severity: 'warn',
            settlementLagMs: 7 * 24 * 60 * 60 * 1_000,
            overcommittedSlotCount: 1,
            runtimeEnabled: false,
        });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            fields: {
                settlement_lag_ms: 604_800_000,
                overcommitted_slot_count: 1,
                runtime_enabled: false,
            },
        }));
    });
});
