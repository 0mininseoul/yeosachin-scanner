import { describe, expect, it, vi } from 'vitest';
import {
    recordAnalysisProviderRunFinished,
    recordAnalysisProviderRunStarted,
    type ProviderCostLedgerRpcClient,
    type ProviderCostRunIdentity,
} from './provider-cost-ledger';

const baseIdentity: ProviderCostRunIdentity = {
    requestId: '3fe8eafe-6d20-460d-889f-aef459913680',
    userId: 'f64ebbec-26b9-44d0-8757-b64dbd27aff0',
    expectedStep: 'collect',
    operationKey: 'relationship:followers',
    logicalProvider: 'apify',
    actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
    credentialSlot: 'primary',
    runId: 'Abcdefgh12345678',
    maxChargeUsd: 1,
};

function rpcClient(result: { data: unknown; error: { code?: string; message?: string } | null }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { client: { rpc } as ProviderCostLedgerRpcClient, rpc };
}

describe('provider cost ledger', () => {
    it('records the exact PII-free run identity at start', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });

        await recordAnalysisProviderRunStarted(client, baseIdentity);

        expect(rpc).toHaveBeenCalledWith('record_analysis_provider_cost_started', {
            p_request_id: baseIdentity.requestId,
            p_user_id: baseIdentity.userId,
            p_expected_step: 'collect',
            p_operation_key: 'relationship:followers',
            p_logical_provider: 'apify',
            p_actor_id: baseIdentity.actorId,
            p_credential_slot: 'primary',
            p_run_id: 'Abcdefgh12345678',
            p_max_charge_usd: 1,
        });
    });

    it('records terminal status and Apify usageTotalUsd', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });

        await recordAnalysisProviderRunFinished(client, {
            ...baseIdentity,
            status: 'succeeded',
            usageTotalUsd: 0.40205,
        });

        expect(rpc).toHaveBeenCalledWith('record_analysis_provider_cost_terminal',
            expect.objectContaining({
                p_status: 'succeeded',
                p_usage_total_usd: 0.40205,
            }));
    });

    it('preserves an unavailable actual usage amount as null', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });

        await recordAnalysisProviderRunFinished(client, {
            ...baseIdentity,
            status: 'failed',
        });

        expect(rpc).toHaveBeenCalledWith('record_analysis_provider_cost_terminal',
            expect.objectContaining({ p_usage_total_usd: null }));
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 100_000.01])(
        'rejects an unsafe maximum charge before making an RPC (%s)',
        async maxChargeUsd => {
            const { client, rpc } = rpcClient({ data: true, error: null });
            await expect(recordAnalysisProviderRunStarted(client, {
                ...baseIdentity,
                maxChargeUsd,
            })).rejects.toThrow('invalid maximum charge');
            expect(rpc).not.toHaveBeenCalled();
        }
    );

    it.each([Number.NaN, Number.NEGATIVE_INFINITY, -0.01, 100_001])(
        'rejects an unsafe actual charge before making an RPC (%s)',
        async usageTotalUsd => {
            const { client, rpc } = rpcClient({ data: true, error: null });
            await expect(recordAnalysisProviderRunFinished(client, {
                ...baseIdentity,
                status: 'succeeded',
                usageTotalUsd,
            })).rejects.toThrow('invalid actual usage');
            expect(rpc).not.toHaveBeenCalled();
        }
    );

    it('rejects operation keys that could smuggle a username or arbitrary label', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });
        await expect(recordAnalysisProviderRunStarted(client, {
            ...baseIdentity,
            operationKey: 'profile:some_username',
        })).rejects.toThrow('invalid operation key');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects an operation attached to the wrong pipeline step', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });
        await expect(recordAnalysisProviderRunStarted(client, {
            ...baseIdentity,
            expectedStep: 'profiles',
        })).rejects.toThrow('operation does not match pipeline step');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects an unsupported pipeline step at runtime', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });
        await expect(recordAnalysisProviderRunStarted(client, {
            ...baseIdentity,
            expectedStep: 'finalize' as never,
        })).rejects.toThrow('invalid pipeline step');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects malformed actor and run identifiers', async () => {
        const actor = rpcClient({ data: true, error: null });
        await expect(recordAnalysisProviderRunStarted(actor.client, {
            ...baseIdentity,
            actorId: 'https://actor.invalid/?token=secret',
        })).rejects.toThrow('invalid actor id');
        expect(actor.rpc).not.toHaveBeenCalled();

        const run = rpcClient({ data: true, error: null });
        await expect(recordAnalysisProviderRunStarted(run.client, {
            ...baseIdentity,
            runId: '../secret',
        })).rejects.toThrow('invalid run id');
        expect(run.rpc).not.toHaveBeenCalled();
    });

    it('does not expose database messages in surfaced errors', async () => {
        const { client } = rpcClient({
            data: null,
            error: { code: '23505', message: 'secret database details' },
        });
        const promise = recordAnalysisProviderRunStarted(client, baseIdentity);
        await expect(promise).rejects.toThrow('start write failed (23505)');
        await expect(promise).rejects.not.toThrow('secret database details');
    });

    it('normalizes unsafe database error codes', async () => {
        const { client } = rpcClient({
            data: null,
            error: { code: 'bad code: private', message: 'private' },
        });
        await expect(recordAnalysisProviderRunFinished(client, {
            ...baseIdentity,
            status: 'aborted',
        })).rejects.toThrow('terminal write failed (unknown)');
    });

    it('fails closed when the RPC cannot verify the request state', async () => {
        const { client } = rpcClient({ data: false, error: null });
        await expect(recordAnalysisProviderRunStarted(client, baseIdentity))
            .rejects.toThrow('request state did not match');
    });

    it('rejects nonterminal status values at runtime', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });
        await expect(recordAnalysisProviderRunFinished(client, {
            ...baseIdentity,
            status: 'running' as never,
        })).rejects.toThrow('invalid terminal status');
        expect(rpc).not.toHaveBeenCalled();
    });
});
