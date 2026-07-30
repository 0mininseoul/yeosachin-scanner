import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES,
    analysisV2ProviderOperationKey,
    createAnalysisV2ProviderRunStore,
    type AnalysisV2ProviderRunReservationInput,
    type AnalysisV2ProviderRunSupabaseClient,
} from './v2-provider-run-store';
import type { ApifyClientLike } from '@/lib/services/instagram/providers/apify-relationship';
import { startOrResumeApifyActor } from '@/lib/services/instagram/providers/apify-relationship';
import { APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';

// gitleaks:allow -- deterministic UUID fixtures
const successorRequestId = '11111111-1111-4111-8111-111111111111';
const predecessorRequestId = '99999999-9999-4999-8999-999999999999';
const claimToken = '22222222-2222-4222-8222-222222222222';
const adoptedReservationToken = '44444444-4444-4444-8444-444444444444';
const predecessorRunId = 'PaidRun12345678';
const jobKey = 'track:relationships:collect';
const inputHash = 'a'.repeat(64);
const operationKey = analysisV2ProviderOperationKey(
    'relationship-followers',
    'followers\n0_min._.00\n1200\nstandard'
);

const identity: AnalysisV2ProviderRunReservationInput = {
    requestId: successorRequestId,
    jobKey,
    claimToken,
    operationKey,
    inputHash,
    logicalProvider: 'apify',
    actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
    credentialSlot: 'primary',
    maxChargeUsd: 0.40205,
};

function adoptedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        requestId: successorRequestId,
        jobKey,
        operationKey,
        inputHash,
        reservationToken: adoptedReservationToken,
        logicalProvider: 'apify',
        actorId: identity.actorId,
        credentialSlot: 'primary',
        maxChargeUsd: 0.40205,
        status: 'succeeded',
        runId: predecessorRunId,
        actualUsageUsd: 0,
        reservedAt: '2026-07-30T22:00:00.000Z',
        runStartedAt: '2026-07-30T22:00:00.000Z',
        terminalizedAt: '2026-07-30T22:00:00.000Z',
        usageReconciledAt: '2026-07-30T22:00:00.000Z',
        adoptedFromRequestId: predecessorRequestId,
        ...overrides,
    };
}

function clientWithRpc() {
    const rpc = vi.fn();
    return { rpc, client: { rpc } as AnalysisV2ProviderRunSupabaseClient };
}

/** Mirrors the adapter harness in providers/apify.test.ts. */
function mockApifyClient(items: Array<Record<string, unknown>> = []) {
    const start = vi.fn().mockResolvedValue({ id: 'FreshRun1234567890' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status: 'SUCCEEDED',
        defaultDatasetId: 'dataset',
    });
    const abort = vi.fn().mockResolvedValue(undefined);
    const listItems = vi.fn(async () => ({
        items,
        total: items.length,
        offset: 0,
        count: items.length,
        limit: items.length,
    }));
    const client = {
        actor: vi.fn(() => ({ start })),
        run: vi.fn(() => ({ waitForFinish, abort })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return { client, start, waitForFinish };
}

describe('analysis V2 predecessor provider run adoption', () => {
    it('adopts a recorded predecessor run instead of reserving a new paid start', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: adoptedRow(), error: null })
            .mockResolvedValueOnce({
                data: { created: false, run: adoptedRow() },
                error: null,
            });
        const store = createAnalysisV2ProviderRunStore(client);

        const binding = await store.bindAdapterCheckpoint(identity);

        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.adoptPredecessorRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
        ]);
        expect(rpc.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            p_request_id: successorRequestId,
            p_job_key: jobKey,
            p_claim_token: claimToken,
            p_operation_key: operationKey,
            p_input_hash: inputHash,
            p_logical_provider: 'apify',
            p_actor_id: identity.actorId,
            p_credential_slot: 'primary',
            p_max_charge_usd: 0.40205,
        }));
        // The adopted row is this request's reservation, so no new start is authorized.
        expect(binding.checkpoint.resumeRunId).toBe(predecessorRunId);
        expect(binding.checkpoint.onBeforeRunStart).toBeUndefined();
        expect(binding.checkpoint.onRunStarted).toBeUndefined();
        expect(binding.checkpoint.startReserved).toBeUndefined();
        expect(binding.stored).toMatchObject({
            status: 'succeeded',
            runId: predecessorRunId,
            actualUsageUsd: 0,
        });
    });

    it('never starts another Apify Actor run once adoption succeeded', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: adoptedRow(), error: null })
            .mockResolvedValueOnce({
                data: { created: false, run: adoptedRow() },
                error: null,
            })
            // The adapter still replays the terminal cost checkpoint; it must stay free.
            .mockResolvedValueOnce({ data: adoptedRow(), error: null });
        const store = createAnalysisV2ProviderRunStore(client);
        const binding = await store.bindAdapterCheckpoint(identity);
        const { client: apify, start, waitForFinish } = mockApifyClient();

        await expect(startOrResumeApifyActor(
            apify,
            APIFY_RELATIONSHIP_ACTOR_ID,
            { Account: ['0_min._.00'] },
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1200,
                maxTotalChargeUsd: 0.40205,
            },
            { ...binding.checkpoint, recordUsage: vi.fn() }
        )).resolves.toMatchObject({ status: 'SUCCEEDED' });

        expect(start).not.toHaveBeenCalled();
        expect(apify.run).toHaveBeenCalledWith(predecessorRunId);
        expect(waitForFinish).toHaveBeenCalledOnce();
        // Terminal replay carries no usage, so the adopted row is never charged.
        const terminalCall = rpc.mock.calls.find(
            ([name]) => name === ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.terminalRpc
        );
        expect(terminalCall?.[1]).toEqual(expect.objectContaining({
            p_run_id: predecessorRunId,
            p_status: 'succeeded',
            p_actual_usage_usd: null,
        }));
        expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.startedRpc
        );
    });

    it('reserves a fresh paid run when the database declines adoption', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: null, error: null });
        const store = createAnalysisV2ProviderRunStore(client);

        const binding = await store.bindAdapterCheckpoint(identity);

        expect(binding.stored).toBeNull();
        expect(binding.checkpoint.resumeRunId).toBeUndefined();
        expect(binding.checkpoint.onBeforeRunStart).toEqual(expect.any(Function));
        expect(binding.checkpoint.onRunStarted).toEqual(expect.any(Function));
    });

    it('does not ask for adoption again once the row exists for this request', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: adoptedRow(), error: null })
            .mockResolvedValueOnce({
                data: { created: false, run: adoptedRow() },
                error: null,
            });
        const store = createAnalysisV2ProviderRunStore(client);

        const binding = await store.bindAdapterCheckpoint(identity);

        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
        ]);
        expect(binding.checkpoint.resumeRunId).toBe(predecessorRunId);
    });

    it.each([
        ['non-zero usage', { actualUsageUsd: 0.401 }],
        ['an unreconciled row', { usageReconciledAt: null, actualUsageUsd: null }],
        ['a non-terminal status', {
            status: 'running',
            terminalizedAt: null,
            actualUsageUsd: null,
            usageReconciledAt: null,
        }],
        ['a missing run id', {
            status: 'starting',
            runId: null,
            runStartedAt: null,
            terminalizedAt: null,
            actualUsageUsd: null,
            usageReconciledAt: null,
        }],
        ['self-adoption', { adoptedFromRequestId: successorRequestId }],
    ])('refuses an adopted row carrying %s', async (_label, overrides) => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: adoptedRow(overrides), error: null });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.bindAdapterCheckpoint(identity)).rejects.toThrow(
            /ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR/
        );
    });

    it('refuses an adopted row whose provider identity drifted from the request', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({
                data: adoptedRow({ credentialSlot: 'secondary' }),
                error: null,
            });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.bindAdapterCheckpoint(identity)).rejects.toThrow(
            'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT'
        );
    });
});
