import { describe, expect, it, vi } from 'vitest';
import {
    FreshProvenanceStore,
    type FreshProvenanceRpcClient,
} from './fresh-provenance-store';

const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const jobKey = 'track:relationships:collect';
const jobInputHash = 'a'.repeat(64);
const providerInputHash = 'b'.repeat(64);
const operationKey = `relationship-followers:${'c'.repeat(64)}`;
const runId = 'AbCdEfGh12345678';
const datasetId = 'DatasetAbcd123456';

function client(data: unknown) {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    return { rpc, client: { rpc } as FreshProvenanceRpcClient };
}

describe('FreshProvenanceStore', () => {
    it('accepts only an exact fresh operation family and mutually exclusive RPC outcomes', async () => {
        const malformedOutcome = client({
            disposition: 'recorded',
            created: false,
            replayed: false,
        });
        const store = new FreshProvenanceStore(malformedOutcome.client);
        const identity = {
            requestId,
            jobKey,
            jobClaimToken: claimToken,
            jobInputHash,
            providerInputHash,
            runId,
        };

        await expect(store.recordProviderRun({
            ...identity,
            operationKey: `profile-repair:${'c'.repeat(64)}`,
        })).rejects.toThrow('FRESH_PROVENANCE_INVALID_INPUT');
        await expect(store.recordProviderRun({ ...identity, operationKey }))
            .rejects.toThrow('FRESH_PROVENANCE_INVALID_RESPONSE');
    });

    it('records a checkpointed Apify run using only domain-separated hashes', async () => {
        const stub = client({ disposition: 'recorded', created: true, replayed: false });
        const store = new FreshProvenanceStore(stub.client);

        await expect(store.recordProviderRun({
            requestId,
            jobKey,
            jobClaimToken: claimToken,
            jobInputHash,
            operationKey,
            providerInputHash,
            runId,
        })).resolves.toEqual({ disposition: 'recorded', created: true, replayed: false });

        expect(stub.rpc).toHaveBeenCalledWith(
            'record_analysis_revenue_fresh_provider_evidence_v1',
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: jobKey,
                p_job_claim_token: claimToken,
                p_job_input_hash: jobInputHash,
                p_operation_key: operationKey,
                p_provider_input_hash: providerInputHash,
                p_provider_run_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            })
        );
        const [, params] = stub.rpc.mock.calls[0] ?? [];
        expect(JSON.stringify(params)).not.toContain(runId);
        expect(JSON.stringify(params)).not.toContain(datasetId);
    });

    it('binds an exact dataset once and refuses malformed or raw caller identities', async () => {
        const stub = client({ disposition: 'bound', created: false, replayed: true });
        const store = new FreshProvenanceStore(stub.client);
        const identity = {
            requestId,
            jobKey,
            jobClaimToken: claimToken,
            jobInputHash,
            operationKey,
            providerInputHash,
            runId,
        };

        await store.bindProviderDataset({ ...identity, datasetId });
        expect(stub.rpc).toHaveBeenCalledWith(
            'bind_analysis_revenue_fresh_provider_dataset_v1',
            expect.objectContaining({
                p_provider_dataset_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            })
        );
        expect(JSON.stringify(stub.rpc.mock.calls[0]?.[1])).not.toContain(datasetId);

        await expect(store.recordProviderRun({ ...identity, operationKey: 'raw-target' }))
            .rejects.toThrow('FRESH_PROVENANCE_INVALID_INPUT');
        expect(stub.rpc).toHaveBeenCalledTimes(1);
    });
});
