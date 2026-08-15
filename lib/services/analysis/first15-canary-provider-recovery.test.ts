import { describe, expect, it, vi } from 'vitest';
import type { StoredAnalysisV2ProviderRun } from './v2-provider-run-store';
import {
    runFirst15CanaryProviderRecovery,
    type First15CanaryProviderRecoveryCandidate,
    type First15CanaryProviderRecoveryDependencies,
    type First15CanaryProviderRecoveryRearm,
} from './first15-canary-provider-recovery';

const ORDER_A = '11111111-1111-4111-8111-111111111111';
const ORDER_B = '22222222-2222-4222-8222-222222222222';
const ORDER_C = '33333333-3333-4333-8333-333333333333';

function candidate(
    index: number,
    errorCode: First15CanaryProviderRecoveryCandidate['errorCode'],
    credentialSlot: First15CanaryProviderRecoveryCandidate['credentialSlot'] = 'senary',
): First15CanaryProviderRecoveryCandidate {
    const ids = [ORDER_A, ORDER_B, ORDER_C];
    return {
        orderId: ids[index - 1],
        requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        preflightId: `00000000-0000-4001-8000-${String(index).padStart(12, '0')}`,
        errorCode,
        credentialSlot,
    };
}

function providerRun(index: number): StoredAnalysisV2ProviderRun {
    return {
        requestId: candidate(index, 'SCRAPING_INCOMPLETE_ERROR').requestId,
        jobKey: 'track:relationships:collect',
        operationKey: `relationship-followers:${'a'.repeat(64)}`,
        inputHash: 'b'.repeat(64),
        reservationToken: `00000000-0000-4002-8000-${String(index).padStart(12, '0')}`,
        logicalProvider: 'apify',
        actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
        credentialSlot: 'senary',
        maxChargeUsd: 1,
        status: 'succeeded',
        runId: `RunCanary${String(index).padStart(8, '0')}`,
        actualUsageUsd: null,
        reservedAt: '2026-08-15T00:00:00.000Z',
        runStartedAt: '2026-08-15T00:00:01.000Z',
        terminalizedAt: '2026-08-15T00:00:02.000Z',
        usageReconciledAt: null,
    };
}

function dependencies(
    overrides: Partial<First15CanaryProviderRecoveryDependencies> = {},
): First15CanaryProviderRecoveryDependencies {
    return {
        workerAvailable: () => true,
        loadCandidates: vi.fn(async () => [
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR'),
            candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR'),
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR'),
        ]),
        loadRearms: vi.fn(async () => []),
        loadProviderRuns: vi.fn(async () => [
            providerRun(1), providerRun(2), providerRun(3),
        ]),
        reconcileProviderRuns: vi.fn(async runs => ({
            eligible: runs.length,
            reconciled: runs.length,
            failed: 0,
            hasMore: false,
        })),
        rearm: vi.fn(async input => ({
            applied: true,
            requestId: `00000000-0000-4003-8000-${input.orderId.slice(-12)}`,
            initialJobKey: 'coordinator:bootstrap' as const,
        })),
        dispatch: vi.fn(async () => 'enqueued'),
        ...overrides,
    };
}

describe('first15 terminal provider-canary recovery', () => {
    it('reconciles only the three source ledgers, then rearms them on tertiary sequentially', async () => {
        const deps = dependencies();

        await expect(runFirst15CanaryProviderRecovery(deps)).resolves.toEqual({
            candidates: 3,
            reconciledProviderRuns: 3,
            rearmed: 3,
            dispatched: 3,
        });

        expect(deps.loadProviderRuns).toHaveBeenCalledWith([
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR').requestId,
            candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR').requestId,
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR').requestId,
        ]);
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_A,
            fallbackCredentialSlot: 'tertiary',
        }));
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_B,
            fallbackCredentialSlot: 'tertiary',
        }));
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_C,
            fallbackCredentialSlot: 'tertiary',
        }));
        expect(deps.dispatch).toHaveBeenCalledTimes(3);
    });

    it('fails closed before provider access when the initial cohort is not the exact three errors', async () => {
        const deps = dependencies({
            loadCandidates: vi.fn(async () => [
                candidate(1, 'SCRAPING_INCOMPLETE_ERROR'),
                candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR'),
            ]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_INITIAL_SCOPE_MISMATCH',
        );
        expect(deps.loadProviderRuns).not.toHaveBeenCalled();
        expect(deps.rearm).not.toHaveBeenCalled();
    });

    it('continues only a recorded canary lineage with the next ordered free-account fallback', async () => {
        const resumed = candidate(
            1,
            'SCRAPING_PROVIDER_QUOTA_ERROR',
            'tertiary',
        );
        const deps = dependencies({
            loadCandidates: vi.fn(async () => [resumed]),
            loadRearms: vi.fn(async (): Promise<readonly First15CanaryProviderRecoveryRearm[]> => [
                {
                    orderId: resumed.orderId,
                    rearmedPreflightId: resumed.preflightId,
                    rearmGeneration: 1,
                    sourceFailureCode: 'SCRAPING_PROVIDER_QUOTA_ERROR',
                },
                {
                    orderId: ORDER_B,
                    rearmedPreflightId: '00000000-0000-4004-8000-000000000002',
                    rearmGeneration: 1,
                    sourceFailureCode: 'SCRAPING_INCOMPLETE_ERROR',
                },
                {
                    orderId: ORDER_C,
                    rearmedPreflightId: '00000000-0000-4004-8000-000000000003',
                    rearmGeneration: 1,
                    sourceFailureCode: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
                },
            ]),
            loadProviderRuns: vi.fn(async () => [providerRun(1)]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).resolves.toEqual({
            candidates: 1,
            reconciledProviderRuns: 1,
            rearmed: 1,
            dispatched: 1,
        });
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            fallbackCredentialSlot: 'quinary',
        }));
    });

    it('does not rearm while a scoped provider run is still active', async () => {
        const active = providerRun(1);
        active.status = 'running';
        active.terminalizedAt = null;
        const deps = dependencies({
            loadProviderRuns: vi.fn(async () => [active]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_ACTIVE_PROVIDER_RUNS',
        );
        expect(deps.reconcileProviderRuns).not.toHaveBeenCalled();
        expect(deps.rearm).not.toHaveBeenCalled();
    });

    it('reports a source-slot authentication blocker without rearming any canary', async () => {
        const reconcileProviderRuns = vi.fn(async (...args: unknown[]) => {
            const runs = args[0] as readonly StoredAnalysisV2ProviderRun[];
            const report = args[1] as undefined | ((failure: {
                credentialSlot: 'senary';
                reason: 'provider_auth_failed';
            }) => void);
            report?.({ credentialSlot: 'senary', reason: 'provider_auth_failed' });
            return {
                eligible: runs.length,
                reconciled: 0,
                failed: runs.length,
                hasMore: false,
            };
        });
        const deps = dependencies({ reconcileProviderRuns });

        await expect(runFirst15CanaryProviderRecovery(deps)).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_AUTH_FAILED',
        );

        expect(reconcileProviderRuns).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(Function),
        );
        expect(deps.rearm).not.toHaveBeenCalled();
        expect(deps.dispatch).not.toHaveBeenCalled();
    });
});
