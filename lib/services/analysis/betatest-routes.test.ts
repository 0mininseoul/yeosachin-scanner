import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    hasAccess: vi.fn(),
    enabled: vi.fn(),
    enqueuePrepare: vi.fn(),
    store: { createOrReplay: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/betatest-access', async importOriginal => ({
    ...(await importOriginal<typeof import('./betatest-access')>()),
    betaTestFreePoolEnabled: mocks.enabled,
    hasBetaTestAccess: mocks.hasAccess,
}));
vi.mock('@/lib/services/analysis/preflight', async importOriginal => ({
    ...(await importOriginal<typeof import('./preflight')>()),
    preflightStore: mocks.store,
}));
vi.mock('@/lib/services/analysis/preflight-tasks', () => ({
    getPreflightTasksConfig: () => ({ queue: 'configured' }),
    enqueueBetaPreflightPrepareTask: mocks.enqueuePrepare,
}));

import { POST as createBetaPreflight } from '@/app/api/analysis/betatest/preflight/route';
import { prepareBetaPreflightDispatch } from './preflight';

const userId = '223e4567-e89b-42d3-a456-426614174000';
const preflightId = '123e4567-e89b-42d3-a456-426614174000';

function request(body: unknown = { targetInstagramId: 'target.name' }) {
    return new Request('https://example.com/api/analysis/betatest/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'beta-preflight-key-000000' },
        body: JSON.stringify(body),
    });
}

describe('dedicated betatest preflight route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser }, rpc: vi.fn() });
        mocks.getUser.mockResolvedValue({ data: { user: {
            id: userId, email: 'owner@example.com', app_metadata: { provider: 'google' },
        } }, error: null });
        mocks.enabled.mockReturnValue(true);
        mocks.hasAccess.mockResolvedValue(true);
        mocks.store.createOrReplay.mockResolvedValue({
            preflightId, expiresAt: '2030-07-13T13:00:00.000Z', created: true, status: 'pending',
        });
        mocks.enqueuePrepare.mockResolvedValue('enqueued');
    });

    it('fails closed before a mutation when auth, flag, or self-grant is unavailable', async () => {
        mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
        expect((await createBetaPreflight(request())).status).toBe(401);
        mocks.enabled.mockReturnValue(false);
        expect((await createBetaPreflight(request())).status).toBe(403);
        mocks.enabled.mockReturnValue(true);
        mocks.hasAccess.mockResolvedValue(false);
        expect((await createBetaPreflight(request())).status).toBe(403);
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
    });

    it('creates a production preflight and enqueues only worker beta preparation', async () => {
        const response = await createBetaPreflight(request());
        expect(response.status).toBe(202);
        expect(mocks.store.createOrReplay).toHaveBeenCalledWith(expect.objectContaining({
            userId, targetInstagramId: 'target.name', accessMode: 'production',
        }));
        expect(mocks.hasAccess).toHaveBeenCalledTimes(2);
        expect(mocks.enqueuePrepare).toHaveBeenCalledWith(preflightId, userId, expect.any(Object));
        await expect(response.json()).resolves.toMatchObject({ preflightId, status: 'pending' });
    });

    it('does not accept beta capability from request tampering', async () => {
        const response = await createBetaPreflight(request({
            targetInstagramId: 'target.name', accessMode: 'betatest', beta: true,
        }));
        expect(response.status).toBe(400);
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
    });
});

describe('beta prepare to ordinary dispatch boundary', () => {
    it('holds before it reserves or dispatches ordinary preflight processing', async () => {
        const events: string[] = [];
        const result = await prepareBetaPreflightDispatch({
            preflightId,
            userId,
            coordinator: { prepare: async () => {
                events.push('hold');
                return { allocationId: '423e4567-e89b-42d3-a456-426614174000', credentialSlot: 'primary', existing: false };
            }, reuse: vi.fn() },
            store: {
                reserveDispatch: async () => {
                    events.push('reserve');
                    return { shouldEnqueue: true, generation: 1, reservationToken: '323e4567-e89b-42d3-a456-426614174000', status: 'pending' };
                },
                markDispatched: async () => { events.push('mark'); },
            } as never,
            enqueue: async () => { events.push('enqueue'); return 'enqueued'; },
        });
        expect(result).toBe('prepared');
        expect(events).toEqual(['hold', 'reserve', 'enqueue', 'mark']);
    });

    it('soft-blocks capacity without reserving or starting a provider', async () => {
        const reserveDispatch = vi.fn();
        const result = await prepareBetaPreflightDispatch({
            preflightId,
            userId,
            coordinator: { prepare: async () => { throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE'); }, reuse: vi.fn() },
            store: { reserveDispatch } as never,
            enqueue: vi.fn(),
        });
        expect(result).toBe('noop');
        expect(reserveDispatch).not.toHaveBeenCalled();
    });
});
