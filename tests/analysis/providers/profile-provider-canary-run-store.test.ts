import { describe, expect, it, vi } from 'vitest';
import {
    PROFILE_PROVIDER_CANARY_ACTOR,
    PROFILE_PROVIDER_CANARY_DATABASE_NAMES,
    PROFILE_PROVIDER_CANARY_VERSION,
    createProfileProviderCanaryRunStore,
} from '../../../lib/services/analysis/profile-provider-canary-run-store';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_TOKEN = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'ReplacementRun1234';
const HMAC = 'a'.repeat(64);
const NOW = '2026-07-19T03:00:00.000Z';
const SOURCE_PROOF = Object.freeze({
    sourceRunCount: 8 as const,
    candidateCount: 15 as const,
    uniqueCandidateCount: 15 as const,
    publicCandidateCount: 15 as const,
    incompleteCandidateCount: 15 as const,
    unavailableCandidateCount: 0 as const,
    primarySuccessCandidateCount: 0 as const,
    criticalCandidateCount: 3 as const,
});

function experiment(overrides: Record<string, unknown> = {}) {
    return {
        sourceRequestId: SOURCE_REQUEST_ID,
        canaryVersion: PROFILE_PROVIDER_CANARY_VERSION,
        orderedSetHmac: HMAC,
        ...SOURCE_PROOF,
        state: 'active',
        terminalReason: null,
        rep2ApprovalDeadlineAt: null,
        sourceKvsCleanupState: 'pending',
        sourceDatasetCleanupState: 'pending',
        sourceRequestQueueCleanupState: 'pending',
        sourceKvsCleanedAt: null,
        sourceDatasetCleanedAt: null,
        sourceRequestQueueCleanedAt: null,
        cleanupClaimToken: null,
        cleanupClaimedAt: null,
        cleanupLeaseExpiresAt: null,
        hmacClearedAt: null,
        experimentTerminalAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

function run(overrides: Record<string, unknown> = {}) {
    return {
        sourceRequestId: SOURCE_REQUEST_ID,
        canaryVersion: PROFILE_PROVIDER_CANARY_VERSION,
        repetition: 1,
        actorId: PROFILE_PROVIDER_CANARY_ACTOR.actorId,
        actorBuild: PROFILE_PROVIDER_CANARY_ACTOR.build,
        inputContractVersion: 1,
        outputContractVersion: 1,
        credentialSlot: 'primary',
        requestedCount: 15,
        maxChargeUsd: 0.05,
        reservationToken: RESERVATION_TOKEN,
        state: 'starting',
        runId: null,
        terminalCount: null,
        successCount: null,
        unavailableCount: null,
        incompleteCount: null,
        otherFailureCount: null,
        criticalSuccessCount: null,
        latencyMs: null,
        buildVerified: null,
        restrictedAccessVerified: true,
        gatePassed: null,
        actualUsageUsd: null,
        costStatus: 'conservative',
        kvsCleanupState: 'pending',
        datasetCleanupState: 'pending',
        requestQueueCleanupState: 'pending',
        kvsCleanedAt: null,
        datasetCleanedAt: null,
        requestQueueCleanedAt: null,
        resolutionKind: 'none',
        resolutionEvidenceHash: null,
        reservedAt: NOW,
        runStartedAt: null,
        ambiguousAt: null,
        resolvedAt: null,
        terminalizedAt: null,
        usageReconciledAt: null,
        cleanupCompletedAt: null,
        updatedAt: NOW,
        ...overrides,
    };
}

function clientWith(...responses: unknown[]) {
    const rpc = vi.fn();
    for (const response of responses) {
        rpc.mockResolvedValueOnce({ data: response, error: null });
    }
    return { rpc };
}

describe('profile provider replacement canary run store', () => {
    it('reserves the immutable exact-15 identity with a temporary ordered HMAC', async () => {
        const client = clientWith({ created: true, experiment: experiment(), run: run() });
        const store = createProfileProviderCanaryRunStore(client, {
            randomUUID: () => RESERVATION_TOKEN,
        });

        await expect(store.reserve({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            ...SOURCE_PROOF,
            orderedSetHmac: HMAC,
            restrictedAccessVerified: true,
        })).resolves.toMatchObject({
            created: true,
            experiment: { state: 'active', orderedSetHmac: HMAC },
            run: {
                actorId: 'apify/instagram-scraper',
                actorBuild: '0.0.692',
                credentialSlot: 'primary',
                requestedCount: 15,
                state: 'starting',
            },
        });
        expect(client.rpc).toHaveBeenCalledWith(
            PROFILE_PROVIDER_CANARY_DATABASE_NAMES.reserveRpc,
            {
                p_source_request_id: SOURCE_REQUEST_ID,
                p_repetition: 1,
                p_source_run_count: 8,
                p_candidate_count: 15,
                p_unique_candidate_count: 15,
                p_public_candidate_count: 15,
                p_incomplete_candidate_count: 15,
                p_unavailable_candidate_count: 0,
                p_primary_success_candidate_count: 0,
                p_critical_candidate_count: 3,
                p_ordered_set_hmac: HMAC,
                p_restricted_access_verified: true,
                p_reservation_token: RESERVATION_TOKEN,
            }
        );
    });

    it('checkpoints, terminalizes, reconciles, and marks each storage independently', async () => {
        const running = run({ state: 'running', runId: RUN_ID, runStartedAt: NOW });
        const terminal = run({
            state: 'succeeded', runId: RUN_ID, runStartedAt: NOW,
            terminalCount: 15, successCount: 15, unavailableCount: 0,
            incompleteCount: 0, otherFailureCount: 0, criticalSuccessCount: 3,
            latencyMs: 40_000, buildVerified: true, terminalizedAt: NOW,
        });
        const reconciled = run({
            ...terminal, actualUsageUsd: 0.04, costStatus: 'actual',
            usageReconciledAt: NOW,
        });
        const cleaned = run({
            ...reconciled, kvsCleanupState: 'verified_absent', kvsCleanedAt: NOW,
        });
        const client = clientWith(running, terminal, reconciled, cleaned);
        const store = createProfileProviderCanaryRunStore(client);

        await store.checkpointStarted({
            sourceRequestId: SOURCE_REQUEST_ID, repetition: 1,
            reservationToken: RESERVATION_TOKEN, runId: RUN_ID,
        });
        await store.terminalize({
            sourceRequestId: SOURCE_REQUEST_ID, repetition: 1,
            reservationToken: RESERVATION_TOKEN, runId: RUN_ID,
            terminalCount: 15, successCount: 15, unavailableCount: 0,
            incompleteCount: 0, otherFailureCount: 0, criticalSuccessCount: 3,
            latencyMs: 40_000, buildVerified: true, restrictedAccessVerified: true,
        });
        await store.reconcileUsage({
            sourceRequestId: SOURCE_REQUEST_ID, repetition: 1,
            reservationToken: RESERVATION_TOKEN, runId: RUN_ID,
            actualUsageUsd: 0.04,
        });
        await store.markRunStorageClean({
            sourceRequestId: SOURCE_REQUEST_ID, repetition: 1,
            reservationToken: RESERVATION_TOKEN, runId: RUN_ID,
            storage: 'kvs',
        });
        expect(client.rpc.mock.calls.map(call => call[0])).toEqual([
            PROFILE_PROVIDER_CANARY_DATABASE_NAMES.checkpointStartedRpc,
            PROFILE_PROVIDER_CANARY_DATABASE_NAMES.terminalizeRpc,
            PROFILE_PROVIDER_CANARY_DATABASE_NAMES.reconcileUsageRpc,
            PROFILE_PROVIDER_CANARY_DATABASE_NAMES.markRunStorageCleanRpc,
        ]);
        expect(client.rpc.mock.calls[1][1]).toMatchObject({
            p_build_verified: true,
            p_restricted_access_verified: true,
        });
    });

    it('accepts bounded observed usage above the fixed charge identity and rejects over one dollar', async () => {
        const observed = run({
            state: 'succeeded', runId: RUN_ID, runStartedAt: NOW,
            terminalCount: 15, successCount: 15, unavailableCount: 0,
            incompleteCount: 0, otherFailureCount: 0, criticalSuccessCount: 3,
            latencyMs: 40_000, buildVerified: true, terminalizedAt: NOW,
            actualUsageUsd: 0.2, costStatus: 'actual', usageReconciledAt: NOW,
        });
        const client = clientWith(observed);
        const store = createProfileProviderCanaryRunStore(client);

        await expect(store.reconcileUsage({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            actualUsageUsd: 0.2,
        })).resolves.toMatchObject({ actualUsageUsd: 0.2, maxChargeUsd: 0.05 });
        await expect(store.reconcileUsage({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            actualUsageUsd: 1.01,
        })).rejects.toThrow('VALIDATION');
        expect(client.rpc).toHaveBeenCalledTimes(1);
    });

    it('parses terminal restricted-access evidence as a boolean instead of a fixed identity', async () => {
        const terminal = run({
            state: 'succeeded', runId: RUN_ID, runStartedAt: NOW,
            terminalCount: 15, successCount: 15, unavailableCount: 0,
            incompleteCount: 0, otherFailureCount: 0, criticalSuccessCount: 3,
            latencyMs: 40_000, buildVerified: true, restrictedAccessVerified: false,
            terminalizedAt: NOW,
        });
        const store = createProfileProviderCanaryRunStore(clientWith(terminal));

        await expect(store.loadRun({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
        })).resolves.toMatchObject({ restrictedAccessVerified: false });
    });

    it('claims bounded expiry cleanup and completes without exposing a start method', async () => {
        const terminalizing = experiment({
            state: 'terminalizing',
            terminalReason: 'expired_waiting_for_repetition',
            cleanupClaimToken: CLAIM_TOKEN,
            cleanupClaimedAt: NOW,
            cleanupLeaseExpiresAt: '2026-07-19T03:05:00.000Z',
        });
        const inventory = {
            sourceRequestId: SOURCE_REQUEST_ID,
            sourceRuns: Array.from({ length: 8 }, (_, index) => ({
                runId: `SourceRun${String(index).padStart(8, '0')}`,
                credentialSlot: 'tertiary',
            })),
            canaryRuns: [{
                repetition: 1,
                runId: RUN_ID,
                credentialSlot: 'primary',
                reservationToken: RESERVATION_TOKEN,
            }],
        };
        const client = clientWith([terminalizing], inventory);
        const store = createProfileProviderCanaryRunStore(client, {
            randomUUID: () => CLAIM_TOKEN,
        });

        await expect(store.claimExpiredForCleanup({ limit: 4 })).resolves.toEqual([
            expect.objectContaining({ terminalReason: 'expired_waiting_for_repetition' }),
        ]);
        await expect(store.loadCleanupInventory({
            sourceRequestId: SOURCE_REQUEST_ID,
            cleanupClaimToken: CLAIM_TOKEN,
        })).resolves.toEqual(inventory);
        expect('start' in store).toBe(false);
    });

    it('rejects cleanup inventory with fewer than the eight source runs', async () => {
        const inventory = {
            sourceRequestId: SOURCE_REQUEST_ID,
            sourceRuns: Array.from({ length: 7 }, (_, index) => ({
                runId: `SourceRun${String(index).padStart(8, '0')}`,
                credentialSlot: 'tertiary',
            })),
            canaryRuns: [],
        };
        const store = createProfileProviderCanaryRunStore(clientWith(inventory));

        await expect(store.loadCleanupInventory({
            sourceRequestId: SOURCE_REQUEST_ID,
            cleanupClaimToken: CLAIM_TOKEN,
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_RUN_PERSISTENCE_ERROR');
    });

    it.each([
        ['duplicate source runs', {
            sourceRequestId: SOURCE_REQUEST_ID,
            sourceRuns: Array.from({ length: 8 }, () => ({
                runId: 'SourceRun12345678', credentialSlot: 'tertiary',
            })),
            canaryRuns: [],
        }],
        ['mismatched source request identity', {
            sourceRequestId: '99999999-9999-4999-8999-999999999999',
            sourceRuns: Array.from({ length: 8 }, (_, index) => ({
                runId: `SourceRun${String(index).padStart(8, '0')}`,
                credentialSlot: 'tertiary',
            })),
            canaryRuns: [],
        }],
    ])('rejects cleanup inventory with %s', async (_label, inventory) => {
        const store = createProfileProviderCanaryRunStore(clientWith(inventory));
        await expect(store.loadCleanupInventory({
            sourceRequestId: SOURCE_REQUEST_ID,
            cleanupClaimToken: CLAIM_TOKEN,
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_RUN_PERSISTENCE_ERROR');
    });

    it.each([
        'strict_failure', 'completed', 'aborted_by_operator', 'verified_no_run',
    ] as const)('parses a re-lease while preserving %s', async reason => {
        const terminalizing = experiment({
            state: 'terminalizing',
            terminalReason: reason,
            cleanupClaimToken: CLAIM_TOKEN,
            cleanupClaimedAt: NOW,
            cleanupLeaseExpiresAt: '2026-07-19T03:05:00.000Z',
        });
        const client = clientWith([terminalizing]);
        const store = createProfileProviderCanaryRunStore(client, {
            randomUUID: () => CLAIM_TOKEN,
        });

        await expect(store.claimExpiredForCleanup({ limit: 4 })).resolves.toEqual([
            expect.objectContaining({ terminalReason: reason }),
        ]);
        expect(client.rpc).toHaveBeenCalledWith(
            PROFILE_PROVIDER_CANARY_DATABASE_NAMES.claimExpiredCleanupRpc,
            { p_limit: 4, p_cleanup_claim_token: CLAIM_TOKEN }
        );
        expect('reserveRun' in store).toBe(false);
        expect('start' in store).toBe(false);
    });

    it('rejects mutable identity, unsafe HMACs, and unexpected sensitive database fields', async () => {
        const client = clientWith(run({
            username: 'private.account',
            datasetId: 'private-storage',
            rawError: 'private provider detail',
        }));
        const store = createProfileProviderCanaryRunStore(client);

        await expect(store.reserve({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            ...SOURCE_PROOF,
            orderedSetHmac: 'not-a-hmac',
            restrictedAccessVerified: true,
        })).rejects.toThrow('VALIDATION');
        const loaded = await store.loadRun({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
        });
        expect(JSON.stringify(loaded)).not.toMatch(/private|username|dataset.?id|raw.?error/i);
    });
});
