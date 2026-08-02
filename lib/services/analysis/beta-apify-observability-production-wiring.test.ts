import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisV2JobStore } from './v2-job-store';

const wiring = vi.hoisted(() => {
    const admin = { rpc: vi.fn() };
    const operationalLogger = { emit: vi.fn(), flush: vi.fn() };
    return {
        admin,
        operationalLogger,
        recover: vi.fn(),
        archive: vi.fn(),
        refresh: vi.fn(),
    };
});

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: wiring.admin }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: wiring.operationalLogger,
}));
vi.mock('./beta-apify-credit-settlement-runtime', () => ({
    recoverBetaApifyCredit: wiring.recover,
    archiveSettledBetaApifyCredit: wiring.archive,
    refreshBetaApifyCreditSnapshots: wiring.refresh,
}));

import { recoverAnalysisV2Jobs } from './v2-recovery';
import { runPreflightRetention } from './preflight-retention';

const env = {
    BETATEST_FREE_POOL_ENABLED: 'false',
    BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS: '123',
    BETATEST_FREE_POOL_REFRESH_INTERVAL_SECONDS: '60',
};

function emptyJobStore(): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn(),
        rearmDispatch: vi.fn(),
        deferRecovery: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(),
        deferTerminalCleanup: vi.fn(),
        deferAiCapacity: vi.fn(),
        continueScheduler: vi.fn(),
        releaseClaim: vi.fn(),
        completeAndFanout: vi.fn(),
        listDispatchable: vi.fn(async () => []),
    };
}

function recoveryDependencies() {
    return {
        env,
        store: emptyJobStore(),
        cleanupTerminalMedia: vi.fn(async () => undefined),
        cleanupProviderRuns: vi.fn(async () => ({
            scanned: 0, settled: 0, failed: 0,
            unconfirmedStarts: 0, hasMore: false,
        })),
        reconcileProviderUsage: vi.fn(async () => ({
            eligible: 0, reconciled: 0, failed: 0, hasMore: false,
        })),
        recoverFulfillments: vi.fn(async () => ({
            reconciled: { scanned: 0, completed: 0, manualReview: 0, retryable: 0 },
            scanned: 0, advanced: 0, failed: 0,
        })),
        recoverGeminiCutoffAttempts: vi.fn(async () => 0),
        reapGeminiCutoffLeases: vi.fn(async () => 0),
        recoverSchedulerOperations: vi.fn(async () => 0),
        reapSchedulerGeminiLeases: vi.fn(async () => 0),
        recoverScoreAudits: vi.fn(async () => undefined),
    };
}

describe('beta Apify production observability wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wiring.recover.mockResolvedValue(1);
        wiring.archive.mockResolvedValue(0);
        wiring.refresh.mockResolvedValue(undefined);
    });

    it('passes the operational logger and shared snapshot age in V2 recovery', async () => {
        await expect(recoverAnalysisV2Jobs(recoveryDependencies()))
            .resolves.toMatchObject({ betaCreditRecovered: 1 });

        expect(wiring.recover).toHaveBeenCalledWith(wiring.admin, 100, {
            telemetry: wiring.operationalLogger,
            maxSnapshotAgeSeconds: 123,
        });
        expect(wiring.refresh).toHaveBeenCalledWith(wiring.admin, {
            env,
            telemetry: wiring.operationalLogger,
        });
    });

    it('passes the same logger and age in preflight retention', async () => {
        wiring.admin.rpc.mockResolvedValue({ data: 0, error: null });
        const providerRunStore = {
            listUnreconciled: vi.fn(async () => []),
            reconcileUsage: vi.fn(),
        };

        await expect(runPreflightRetention(wiring.admin, {
            env,
            providerRunStore,
        })).resolves.toMatchObject({ betaCreditRecovered: 1 });

        expect(wiring.recover).toHaveBeenCalledWith(wiring.admin, 100, {
            telemetry: wiring.operationalLogger,
            maxSnapshotAgeSeconds: 123,
        });
        expect(wiring.refresh).toHaveBeenCalledWith(wiring.admin, {
            env,
            telemetry: wiring.operationalLogger,
        });
    });
});
