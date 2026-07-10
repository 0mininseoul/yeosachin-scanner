import { describe, expect, it, vi } from 'vitest';
import {
    checkpointRelationshipList,
    type RelationshipCheckpointRpcClient,
} from './relationship-persistence';

const rows = [{
    username: 'candidate',
    isPrivate: false,
    isVerified: false,
}];

describe('relationship checkpoint persistence', () => {
    it('atomically identifies the list kind and owner through the RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        await checkpointRelationshipList({ rpc } as RelationshipCheckpointRpcClient, {
            requestId: 'request-id',
            userId: 'user-id',
            kind: 'followers',
            rows,
        });

        expect(rpc).toHaveBeenCalledWith('checkpoint_analysis_relationship_list', {
            p_request_id: 'request-id',
            p_user_id: 'user-id',
            p_kind: 'followers',
            p_rows: rows,
        });
    });

    it('fails closed when state changed or the RPC fails', async () => {
        await expect(checkpointRelationshipList({
            rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
        }, {
            requestId: 'request-id',
            userId: 'user-id',
            kind: 'following',
            rows,
        })).rejects.toThrow('state did not match');

        await expect(checkpointRelationshipList({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }),
        }, {
            requestId: 'request-id',
            userId: 'user-id',
            kind: 'following',
            rows,
        })).rejects.toThrow('(42501)');
    });
});
