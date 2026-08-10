import { describe, expect, it, vi } from 'vitest';
import {
    RevenueCostOperationStore,
    type RevenueCostOperationRpcClient,
} from './revenue-cost-operation-store';

const requestId = '11111111-1111-4111-8111-111111111111';
const ownerKeyHash = 'a'.repeat(64);
const scopeHash = 'b'.repeat(64);

function client(data: unknown, error: { code?: string; message?: string } | null = null) {
    const rpc = vi.fn().mockResolvedValue({ data, error });
    return { rpc, client: { rpc } as RevenueCostOperationRpcClient };
}

describe('RevenueCostOperationStore', () => {
    it('uses only opaque identity inputs to reserve an operation', async () => {
        const stub = client({ disposition: 'accepted', operationId: '22222222-2222-4222-8222-222222222222' });
        const store = new RevenueCostOperationStore(stub.client);

        await expect(store.reserve({
            requestId,
            ownerKind: 'routing',
            ownerKeyHash,
            attempt: 1,
            operationKind: 'stage_one_routing',
            units: 400,
            estimatedEconomicUsd: 0.5,
            selectedManifestScopeHash: scopeHash,
        })).resolves.toMatchObject({ disposition: 'accepted' });

        expect(stub.rpc).toHaveBeenCalledWith('reserve_analysis_revenue_cost_operation_v1', {
            p_request_id: requestId,
            p_owner_kind: 'routing',
            p_owner_key_hash: ownerKeyHash,
            p_attempt: 1,
            p_operation_kind: 'stage_one_routing',
            p_units: 400,
            p_estimated_economic_usd: 0.5,
            p_selected_manifest_scope_hash: scopeHash,
        });
    });

    it('returns a durable denial without surfacing database details', async () => {
        const stub = client({ disposition: 'denied', operationId: '22222222-2222-4222-8222-222222222222', reason: 'hard_cap' });
        const store = new RevenueCostOperationStore(stub.client);
        await expect(store.reserve({
            requestId, ownerKind: 'profile', ownerKeyHash, attempt: 1,
            operationKind: 'detail_profile', units: 100, estimatedEconomicUsd: 2, selectedManifestScopeHash: scopeHash,
        })).resolves.toMatchObject({ disposition: 'denied', reason: 'hard_cap' });
    });

    it('rejects raw or malformed identity values before an RPC', async () => {
        const stub = client({ disposition: 'accepted' });
        const store = new RevenueCostOperationStore(stub.client);
        await expect(store.reserve({
            requestId, ownerKind: 'profile', ownerKeyHash: 'target_username', attempt: 1,
            operationKind: 'detail_profile', units: 1, estimatedEconomicUsd: 0.01, selectedManifestScopeHash: scopeHash,
        })).rejects.toThrow('REVENUE_COST_OPERATION_INVALID_INPUT');
        expect(stub.rpc).not.toHaveBeenCalled();
    });

    it('fences lifecycle calls on the same opaque operation identity', async () => {
        const stub = client({ disposition: 'started' });
        const store = new RevenueCostOperationStore(stub.client);
        await store.markStarted({ requestId, ownerKind: 'routing', ownerKeyHash, attempt: 1 });
        expect(stub.rpc).toHaveBeenCalledWith('mark_analysis_revenue_cost_operation_started_v1', {
            p_request_id: requestId, p_owner_kind: 'routing', p_owner_key_hash: ownerKeyHash, p_attempt: 1,
        });
    });

    it('does not expose raw database messages', async () => {
        const stub = client(null, { code: 'P0001', message: 'username=private-target' });
        const store = new RevenueCostOperationStore(stub.client);
        const outcome = store.manualReview({ requestId, reasonCode: 'routing_failure' });
        await expect(outcome).rejects.toThrow('REVENUE_COST_OPERATION_RPC_FAILED_P0001');
        await expect(outcome).rejects.not.toThrow('private-target');
    });
});
