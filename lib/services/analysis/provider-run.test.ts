import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    abortRunningAnalysisProviderRuns,
    analysisProviderRunCheckpoint,
    checkpointAnalysisProviderRun,
    getAnalysisProviderRun,
    reserveAnalysisProviderRun,
} from './provider-run';

function readClient(data: unknown, error: unknown = null) {
    const maybeSingle = vi.fn().mockResolvedValue({ data, error });
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle,
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    return {
        from: vi.fn().mockReturnValue(chain),
        rpc: vi.fn(),
    } as unknown as SupabaseClient;
}

describe('analysis provider run checkpoints', () => {
    it('returns a validated stored run id', async () => {
        const client = readClient({
            logical_provider: 'coderx',
            actor_id: 'coderx/instagram-followers',
            credential_slot: 'secondary',
            max_charge_usd: '0.75',
            status: 'running',
            run_id: 'Abcdefgh12345678',
        });
        await expect(getAnalysisProviderRun(client, {
            requestId: 'request-id',
            operationKey: 'relationship:followers',
        })).resolves.toEqual({
            logicalProvider: 'coderx',
            actorId: 'coderx/instagram-followers',
            credentialSlot: 'secondary',
            maxChargeUsd: 0.75,
            status: 'running',
            runId: 'Abcdefgh12345678',
        });
    });

    it('rejects malformed persisted ids', async () => {
        const client = readClient({
            logical_provider: 'apify',
            actor_id: 'actor/profile',
            credential_slot: 'primary',
            max_charge_usd: 0.25,
            status: 'running',
            run_id: '../invalid',
        });
        await expect(getAnalysisProviderRun(client, {
            requestId: 'request-id',
            operationKey: 'relationship:followers',
        })).rejects.toThrow('stored run id is invalid');
    });

    it('checkpoints a newly started run through the atomic RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        const client = { rpc, from: vi.fn() } as unknown as SupabaseClient;
        await checkpointAnalysisProviderRun(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            operationKey: 'relationship:following',
            runId: 'Abcdefgh12345678',
            logicalProvider: 'apify',
            actorId: 'actor/profile',
            credentialSlot: 'primary',
            maxChargeUsd: 0.25,
        });
        expect(rpc).toHaveBeenCalledWith('checkpoint_analysis_provider_run', expect.objectContaining({
            p_expected_step: 'collect',
            p_operation_key: 'relationship:following',
            p_logical_provider: 'apify',
            p_actor_id: 'actor/profile',
            p_credential_slot: 'primary',
            p_max_charge_usd: 0.25,
            p_run_id: 'Abcdefgh12345678',
        }));
    });

    it('reserves an at-most-once start intent before storing its returned run id', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ data: true, error: null });
        const client = readClient(null);
        vi.mocked(client.rpc).mockImplementation(rpc);
        const checkpoint = await analysisProviderRunCheckpoint(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'profiles',
            operationKey: 'profiles:2',
        });
        await checkpoint.onBeforeRunStart?.({
            logicalProvider: 'apify',
            actorId: 'actor/profile',
            credentialSlot: 'secondary',
            maxChargeUsd: 0.4,
        });
        await checkpoint.onRunStarted?.('Abcdefgh12345678');

        expect(rpc).toHaveBeenNthCalledWith(1, 'reserve_analysis_provider_run',
            expect.objectContaining({
                p_logical_provider: 'apify',
                p_actor_id: 'actor/profile',
                p_credential_slot: 'secondary',
                p_max_charge_usd: 0.4,
            }));
        expect(rpc).toHaveBeenNthCalledWith(2, 'checkpoint_analysis_provider_run',
            expect.objectContaining({ p_run_id: 'Abcdefgh12345678' }));
    });

    it('blocks automatic restart when only a starting intent survived', async () => {
        const client = readClient({
            logical_provider: 'apify',
            actor_id: 'actor/profile',
            credential_slot: 'primary',
            max_charge_usd: '0.25',
            status: 'starting',
            run_id: null,
        });
        const checkpoint = await analysisProviderRunCheckpoint(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'profiles',
            operationKey: 'profiles:2',
        });

        expect(checkpoint).toMatchObject({
            logicalProvider: 'apify',
            actorId: 'actor/profile',
            credentialSlot: 'primary',
            maxChargeUsd: 0.25,
            startReserved: true,
        });
        expect(checkpoint.resumeRunId).toBeUndefined();
        expect(checkpoint.onRunStarted).toBeUndefined();
    });

    it('reserves a provider identity through the atomic RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        await reserveAnalysisProviderRun({ rpc, from: vi.fn() } as unknown as SupabaseClient, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            operationKey: 'relationship:followers',
            logicalProvider: 'coderx',
            actorId: 'coderx/instagram-followers',
            credentialSlot: 'secondary',
            maxChargeUsd: 0.75,
        });

        expect(rpc).toHaveBeenCalledWith('reserve_analysis_provider_run',
            expect.objectContaining({
                p_logical_provider: 'coderx',
                p_credential_slot: 'secondary',
                p_max_charge_usd: 0.75,
            }));
    });

    it('builds a resume checkpoint around the stored logical provider', async () => {
        const client = readClient({
            logical_provider: 'coderx',
            actor_id: 'coderx/instagram-followers',
            credential_slot: 'secondary',
            max_charge_usd: '0.75',
            status: 'running',
            run_id: 'Abcdefgh12345678',
        });
        const checkpoint = await analysisProviderRunCheckpoint(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            operationKey: 'relationship:followers',
        });
        expect(checkpoint).toMatchObject({
            logicalProvider: 'coderx',
            actorId: 'coderx/instagram-followers',
            credentialSlot: 'secondary',
            maxChargeUsd: 0.75,
            resumeRunId: 'Abcdefgh12345678',
        });
        expect(checkpoint.onRunStarted).toBeUndefined();
    });

    it('binds started and terminal cost events to the PII-free operation identity', async () => {
        const client = readClient({
            logical_provider: 'apify',
            actor_id: 'actor/profile',
            credential_slot: 'primary',
            max_charge_usd: 0.25,
            status: 'running',
            run_id: 'Abcdefgh12345678',
        });
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        vi.mocked(client.rpc).mockImplementation(rpc);
        const checkpoint = await analysisProviderRunCheckpoint(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            operationKey: 'profile:target',
        });

        const run = {
            logicalProvider: 'apify' as const,
            actorId: 'actor/profile',
            credentialSlot: 'primary' as const,
            runId: 'Abcdefgh12345678',
            maxChargeUsd: 0.25,
        };
        await checkpoint.onCostRunStarted?.(run);
        await checkpoint.onCostRunFinished?.({
            ...run,
            status: 'succeeded',
            usageTotalUsd: 0.04,
        });

        expect(client.rpc).toHaveBeenNthCalledWith(
            1,
            'record_analysis_provider_cost_started',
            expect.objectContaining({
                p_operation_key: 'profile:target',
                p_run_id: 'Abcdefgh12345678',
            })
        );
        expect(client.rpc).toHaveBeenNthCalledWith(
            2,
            'record_analysis_provider_cost_terminal',
            expect.objectContaining({
                p_status: 'succeeded',
                p_usage_total_usd: 0.04,
            })
        );
    });

    it('rejects a cost event that drifts from the stored credential identity', async () => {
        const client = readClient({
            logical_provider: 'apify',
            actor_id: 'actor/profile',
            credential_slot: 'secondary',
            max_charge_usd: '0.25',
            status: 'running',
            run_id: 'Abcdefgh12345678',
        });
        const checkpoint = await analysisProviderRunCheckpoint(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            operationKey: 'profile:target',
        });

        await expect(checkpoint.onCostRunStarted?.({
            logicalProvider: 'apify',
            actorId: 'actor/profile',
            credentialSlot: 'primary',
            maxChargeUsd: 0.25,
            runId: 'Abcdefgh12345678',
        })).rejects.toThrow('cost event identity does not match');
        expect(client.rpc).not.toHaveBeenCalled();
    });
});

function abortClient(data: unknown, error: unknown = null) {
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValueOnce(chain).mockResolvedValueOnce({ data, error });
    return {
        from: vi.fn().mockReturnValue(chain),
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    } as unknown as SupabaseClient;
}

const runningRow = {
    operation_key: 'relationship:followers',
    logical_provider: 'apify',
    actor_id: 'actor/relationship',
    credential_slot: 'secondary',
    max_charge_usd: '0.5',
    status: 'running',
    run_id: 'Abcdefgh12345678',
};

describe('abortRunningAnalysisProviderRuns', () => {
    it('uses the stored token slot and records only the confirmed terminal usage', async () => {
        const client = abortClient([runningRow]);
        const get = vi.fn().mockResolvedValue({ status: 'RUNNING' });
        const abort = vi.fn().mockResolvedValue({ status: 'ABORTING' });
        const waitForFinish = vi.fn().mockResolvedValue({
            status: 'ABORTED',
            usageTotalUsd: 0.04,
        });
        const run = vi.fn(() => ({ get, abort, waitForFinish }));
        const clientForSlot = vi.fn(() => ({ run }));

        await expect(abortRunningAnalysisProviderRuns(client, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
        }, { clientForSlot })).resolves.toBe(1);

        expect(clientForSlot).toHaveBeenCalledWith('secondary');
        expect(run).toHaveBeenCalledWith('Abcdefgh12345678');
        expect(abort).toHaveBeenCalledOnce();
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 30 });
        expect(client.rpc).toHaveBeenCalledWith(
            'record_analysis_provider_cost_terminal',
            expect.objectContaining({
                p_credential_slot: 'secondary',
                p_max_charge_usd: 0.5,
                p_status: 'aborted',
                p_usage_total_usd: 0.04,
            })
        );
    });

    it('does not invoke Apify when no running row exists', async () => {
        const clientForSlot = vi.fn();
        await expect(abortRunningAnalysisProviderRuns(abortClient([]), {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
        }, { clientForSlot })).resolves.toBe(0);
        expect(clientForSlot).not.toHaveBeenCalled();
    });

    it('validates every stored row before aborting any Actor', async () => {
        const clientForSlot = vi.fn();
        await expect(abortRunningAnalysisProviderRuns(abortClient([
            runningRow,
            { ...runningRow, operation_key: 'profiles:not-a-cursor' },
        ]), {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
        }, { clientForSlot })).rejects.toThrow(
            'ANALYSIS_PERSISTENCE_ERROR: stored provider run is invalid.'
        );
        expect(clientForSlot).not.toHaveBeenCalled();
    });

    it('sanitizes remote abort failures', async () => {
        const run = vi.fn(() => ({
            get: vi.fn().mockRejectedValue(new Error('secret provider response')),
            abort: vi.fn(),
            waitForFinish: vi.fn(),
        }));
        await expect(abortRunningAnalysisProviderRuns(abortClient([runningRow]), {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
        }, { clientForSlot: () => ({ run }) })).rejects.toThrow(
            'ANALYSIS_PERSISTENCE_ERROR: provider run abort could not be confirmed.'
        );
    });
});
