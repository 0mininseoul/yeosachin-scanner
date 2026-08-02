import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    hasAccess: vi.fn(),
    enabled: vi.fn(),
    enqueuePrepare: vi.fn(),
    store: {
        createOrReplayBeta: vi.fn(),
        markBetaPrepareDispatched: vi.fn(),
        blockBetaPrepareCapacity: vi.fn(),
    },
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
import {
    BetaPreflightAccessUnavailableError,
    prepareBetaPreflightDispatch,
} from './preflight';

const userId = '223e4567-e89b-42d3-a456-426614174000';
const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const prepareToken = preflightId.replace(/^1/, '3');

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
        mocks.store.createOrReplayBeta.mockResolvedValue({
            preflightId, expiresAt: '2030-07-13T13:00:00.000Z', created: true, status: 'pending',
            prepareGeneration: 1, prepareToken, shouldEnqueue: true,
        });
        mocks.store.markBetaPrepareDispatched.mockResolvedValue(undefined);
        mocks.store.blockBetaPrepareCapacity.mockResolvedValue('blocked');
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
        expect(mocks.store.createOrReplayBeta).not.toHaveBeenCalled();
    });

    it('creates a production preflight and enqueues only worker beta preparation', async () => {
        const response = await createBetaPreflight(request());
        expect(response.status).toBe(202);
        expect(mocks.store.createOrReplayBeta).toHaveBeenCalledWith(expect.objectContaining({
            userId, targetInstagramId: 'target.name',
        }));
        expect(mocks.hasAccess).toHaveBeenCalledTimes(2);
        expect(mocks.enqueuePrepare).toHaveBeenCalledWith(
            preflightId, userId, 1, prepareToken, expect.any(Object)
        );
        expect(mocks.store.markBetaPrepareDispatched).toHaveBeenCalledWith({
            preflightId, userId, prepareGeneration: 1, prepareToken,
        });
        await expect(response.json()).resolves.toMatchObject({ preflightId, status: 'pending' });
    });

    it('does not accept beta capability from request tampering', async () => {
        const response = await createBetaPreflight(request({
            targetInstagramId: 'target.name', accessMode: 'betatest', beta: true,
        }));
        expect(response.status).toBe(400);
        expect(mocks.store.createOrReplayBeta).not.toHaveBeenCalled();
    });

    it('replays a terminal/prepared row without manufacturing a new prepare task', async () => {
        mocks.store.createOrReplayBeta.mockResolvedValueOnce({
            preflightId, expiresAt: '2030-07-13T13:00:00.000Z', created: false,
            status: 'pending', prepareGeneration: 1, prepareToken, shouldEnqueue: false,
        });
        const response = await createBetaPreflight(request());
        expect(response.status).toBe(200);
        expect(mocks.enqueuePrepare).not.toHaveBeenCalled();
        expect(mocks.store.markBetaPrepareDispatched).not.toHaveBeenCalled();
    });

    it('terminalizes the reserved row if access is revoked between creation and enqueue', async () => {
        mocks.hasAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const response = await createBetaPreflight(request());
        expect(response.status).toBe(403);
        expect(mocks.enqueuePrepare).not.toHaveBeenCalled();
        expect(mocks.store.blockBetaPrepareCapacity).toHaveBeenCalledWith({
            preflightId, userId, prepareGeneration: 1, prepareToken, claimToken: null,
        });
    });

    it('keeps a database create/revoke race on the stable access-denied contract', async () => {
        mocks.store.createOrReplayBeta.mockRejectedValueOnce(
            new BetaPreflightAccessUnavailableError()
        );

        const response = await createBetaPreflight(request());

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            code: 'BETA_ACCESS_UNAVAILABLE',
        });
        expect(mocks.enqueuePrepare).not.toHaveBeenCalled();
    });
});

describe('beta prepare to ordinary dispatch boundary', () => {
    it('holds before it reserves or dispatches ordinary preflight processing', async () => {
        const events: string[] = [];
        const result = await prepareBetaPreflightDispatch({
            preflightId,
            userId,
            prepareGeneration: 1,
            prepareToken,
            coordinator: { prepare: async () => {
                events.push('hold');
                return { allocationId: '423e4567-e89b-42d3-a456-426614174000', credentialSlot: 'primary', existing: false };
            }, reuse: vi.fn() },
            store: {
                claimBetaPrepare: async () => {
                    events.push('claim');
                    return {
                        claimed: true, state: 'preparing',
                        claimToken: userId,
                        disposition: 'claimed',
                    };
                },
                reserveDispatch: async () => {
                    events.push('reserve');
                    return { shouldEnqueue: true, generation: 1, reservationToken: '323e4567-e89b-42d3-a456-426614174000', status: 'pending' };
                },
                markDispatched: async () => { events.push('mark'); },
            } as never,
            enqueue: async () => { events.push('enqueue'); return 'enqueued'; },
        });
        expect(result).toBe('prepared');
        expect(events).toEqual(['claim', 'hold', 'reserve', 'enqueue', 'mark']);
    });

    it('soft-blocks capacity without reserving or starting a provider', async () => {
        const reserveDispatch = vi.fn();
        const result = await prepareBetaPreflightDispatch({
            preflightId,
            userId,
            prepareGeneration: 1,
            prepareToken,
            coordinator: { prepare: async () => { throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE'); }, reuse: vi.fn() },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: true, state: 'preparing',
                    claimToken: userId,
                    disposition: 'claimed',
                }),
                blockBetaPrepareCapacity: vi.fn(async () => 'blocked'),
                reserveDispatch,
            } as never,
            enqueue: vi.fn(),
        });
        expect(result).toBe('blocked');
        expect(reserveDispatch).not.toHaveBeenCalled();
    });

    it('drops a stale generation/token task before refresh or provider access', async () => {
        const prepare = vi.fn();
        const result = await prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 2, prepareToken,
            coordinator: { prepare, reuse: vi.fn() },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: false, state: 'reserved', claimToken: null,
                    disposition: 'stale',
                }),
            } as never,
            enqueue: vi.fn(),
        });
        expect(result).toBe('noop');
        expect(prepare).not.toHaveBeenCalled();
    });

    it('noops retry-exhausted terminal work before any provider or dispatch network', async () => {
        const prepare = vi.fn();
        const reuse = vi.fn();
        const reserveDispatch = vi.fn();
        const enqueue = vi.fn();

        const result = await prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 1, prepareToken,
            coordinator: { prepare, reuse },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: false, state: 'retry_exhausted', claimToken: null,
                    disposition: 'terminal',
                }),
                reserveDispatch,
            } as never,
            enqueue,
        });

        expect(result).toBe('noop');
        expect(prepare).not.toHaveBeenCalled();
        expect(reuse).not.toHaveBeenCalled();
        expect(reserveDispatch).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('acknowledges the retry ceiling after its atomic terminal transition', async () => {
        const markBetaPrepareRetryExhausted = vi.fn(async () => true);
        const claimBetaPrepare = vi.fn();
        const prepare = vi.fn();
        const reserveDispatch = vi.fn();
        const enqueue = vi.fn();

        await expect(prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 1, prepareToken,
            deliveryRetryCount: 6,
            coordinator: { prepare, reuse: vi.fn() },
            store: {
                markBetaPrepareRetryExhausted,
                claimBetaPrepare,
                reserveDispatch,
            } as never,
            enqueue,
        })).resolves.toBe('noop');

        expect(markBetaPrepareRetryExhausted).toHaveBeenCalledOnce();
        expect(claimBetaPrepare).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(reserveDispatch).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('noops when retry exhaustion wins a capacity-block race', async () => {
        const reserveDispatch = vi.fn(() => {
            throw new Error('terminal work must never reserve dispatch');
        });
        const enqueue = vi.fn();

        await expect(prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 1, prepareToken,
            coordinator: {
                prepare: async () => {
                    throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE');
                },
                reuse: vi.fn(),
            },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: true, state: 'preparing', claimToken: userId,
                    disposition: 'claimed',
                }),
                blockBetaPrepareCapacity: vi.fn(async () => 'retry_exhausted'),
                reserveDispatch,
            } as never,
            enqueue,
        })).resolves.toBe('noop');

        expect(reserveDispatch).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('noops an expired terminal task before selecting any provider client', async () => {
        const clientForSlot = vi.fn();
        const prepare = vi.fn(async () => {
            clientForSlot('primary');
            throw new Error('expired work must never reach the coordinator');
        });
        const reuse = vi.fn();
        const reserveDispatch = vi.fn();
        const enqueue = vi.fn();

        const result = await prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 1, prepareToken,
            coordinator: { prepare, reuse },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: false, state: 'expired', claimToken: null,
                    disposition: 'terminal',
                }),
                reserveDispatch,
            } as never,
            enqueue,
        });

        expect(result).toBe('noop');
        expect(prepare).not.toHaveBeenCalled();
        expect(reuse).not.toHaveBeenCalled();
        expect(clientForSlot).not.toHaveBeenCalled();
        expect(reserveDispatch).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('releases a claim after a transient failure so the next delivery can succeed', async () => {
        const release = vi.fn(async () => true);
        await expect(prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 1, prepareToken,
            coordinator: {
                prepare: async () => { throw new Error('temporary database transport'); },
                reuse: vi.fn(),
            },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: true, state: 'preparing', disposition: 'claimed',
                    claimToken: userId,
                }),
                releaseBetaPrepareClaim: release,
            } as never,
            enqueue: vi.fn(),
        })).rejects.toThrow('temporary database transport');
        expect(release).toHaveBeenCalledOnce();
    });

    it('keeps an active same-fence lease retryable instead of tombstoning the task', async () => {
        await expect(prepareBetaPreflightDispatch({
            preflightId, userId, prepareGeneration: 1, prepareToken,
            coordinator: { prepare: vi.fn(), reuse: vi.fn() },
            store: {
                claimBetaPrepare: async () => ({
                    claimed: false, state: 'preparing', disposition: 'busy',
                    claimToken: null,
                }),
            } as never,
            enqueue: vi.fn(),
        })).rejects.toMatchObject({
            classification: expect.objectContaining({ retryable: true }),
        });
    });
});
