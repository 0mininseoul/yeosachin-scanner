import { describe, expect, it, vi } from 'vitest';
import {
    CANONICAL_MIRROR_TIMEOUT_MS,
    createCanonicalOperationsStore,
    isCanonicalFamilyReadEnabled,
    isCanonicalFamilyWriteEnabled,
    maintenanceMarker,
    rollbackCanonicalFlags,
    withCanonicalMirrorTimeout,
} from './canonical-operations-store';

const ACCOUNT_ID = '423e4567-e89b-42d3-a456-426614174001';
const HASH = 'a'.repeat(64);

describe('retained commerce/account/maintenance canonical operations', () => {
    it('keeps only retained family flags and supports rollback', () => {
        const env = rollbackCanonicalFlags({
            COMMERCE_CANONICAL_ACCOUNT_READ: 'true',
            UNRELATED_CANONICAL_WRITE: 'true',
        });
        expect(isCanonicalFamilyReadEnabled('account', env)).toBe(false);
        expect(isCanonicalFamilyWriteEnabled('maintenance', env)).toBe(false);
        expect(env.UNRELATED_CANONICAL_WRITE).toBe('true');
        expect(env.COMMERCE_CANONICAL_ACCOUNT_READ).toBe('false');
    });

    it('preserves account lifecycle and maintenance RPC contracts', async () => {
        const rpc = vi.fn(async () => ({ data: { status: 'recorded' }, error: null }));
        const store = createCanonicalOperationsStore({ rpc });
        await expect(store.appendAccountLifecycle({
            accountId: ACCOUNT_ID,
            eventKind: 'classification',
            state: 'active',
            payload: {},
            contentHash: HASH,
        })).resolves.toMatchObject({ status: 'recorded' });
        await expect(store.enqueueMaintenanceJob({
            kind: 'recovery',
            targetKeyHash: HASH,
            payload: {},
            contentHash: HASH,
        })).resolves.toMatchObject({ status: 'recorded' });
        expect(rpc).toHaveBeenNthCalledWith(1, 'append_account_lifecycle_v1', expect.any(Object));
        expect(rpc).toHaveBeenNthCalledWith(2, 'enqueue_maintenance_job_v1', expect.any(Object));
    });

    it('does not expose removed W1A operation methods', () => {
        const store = createCanonicalOperationsStore({ rpc: vi.fn() });
        expect(store).not.toHaveProperty('enqueueNotification');
        expect(store).not.toHaveProperty('upsertFulfillmentJob');
        expect(store).not.toHaveProperty('recordSystemConfiguration');
        expect(store).not.toHaveProperty('acquireSystemLease');
        expect(maintenanceMarker('recovery', 'target', 'content')).toMatchObject({
            kind: 'recovery', payload: {},
        });
    });

    it('bounds canonical mirror timeout', async () => {
        expect(CANONICAL_MIRROR_TIMEOUT_MS).toBe(1_000);
        await expect(withCanonicalMirrorTimeout(() => Promise.resolve('ok'))).resolves.toBe('ok');
        await expect(withCanonicalMirrorTimeout(() => Promise.resolve('ok'), 0)).rejects.toThrow(
            'CANONICAL_OPERATIONS_INPUT_INVALID',
        );
    });
});
