import { describe, expect, it, vi } from 'vitest';
import {
    SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS,
    SELFHOSTED_PROFILE_GLOBAL_GATE_RPC,
    createSelfHostedProfileGlobalGate,
    getSelfHostedProfileGlobalGateConfig,
    reserveSelfHostedProfileRequestStart,
    type SelfHostedProfileGlobalGateRpcBuilder,
    type SelfHostedProfileGlobalGateRpcClient,
} from '../../../../../../lib/services/instagram/providers/selfhosted/global-request-gate';

const validReservation = {
    schemaVersion: 1,
    waitMs: 125,
    reservedAt: '2026-07-16T12:34:56.789+00:00',
};
const defaultAttemptOptions = {
    maxWaitMs: 60_000,
    responseGuardMs: 100,
    rpcTimeoutMs: 750,
};

function rpcBuilder(
    result: { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>
): SelfHostedProfileGlobalGateRpcBuilder {
    const promise = Promise.resolve(result);
    return Object.assign(promise, {
        abortSignal: vi.fn(() => promise),
    });
}

function fakeClient(result: { data: unknown; error: unknown }) {
    const rpc = vi.fn(() => rpcBuilder(result));
    return {
        client: { rpc } as SelfHostedProfileGlobalGateRpcClient,
        rpc,
    };
}

describe('selfhosted production-wide profile request gate config', () => {
    it('defaults on only in production with bounded aggregate timing budgets', () => {
        expect(getSelfHostedProfileGlobalGateConfig({ NODE_ENV: 'production' })).toEqual({
            admissionMaxWaitMs: 500,
            enabled: true,
            fullMaxWaitMs: 60_000,
            minIntervalMs: 750,
            responseGuardMs: 100,
            rpcTimeoutMs: 750,
        });
        expect(getSelfHostedProfileGlobalGateConfig({ NODE_ENV: 'development' })).toEqual({
            admissionMaxWaitMs: 500,
            enabled: false,
            fullMaxWaitMs: 60_000,
            minIntervalMs: 750,
            responseGuardMs: 100,
            rpcTimeoutMs: 750,
        });
        expect(getSelfHostedProfileGlobalGateConfig({})).toEqual({
            admissionMaxWaitMs: 500,
            enabled: false,
            fullMaxWaitMs: 60_000,
            minIntervalMs: 750,
            responseGuardMs: 100,
            rpcTimeoutMs: 750,
        });
    });

    it('lets explicit true or false override the environment default', () => {
        expect(getSelfHostedProfileGlobalGateConfig({
            NODE_ENV: 'development',
            SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
        }).enabled).toBe(true);
        expect(getSelfHostedProfileGlobalGateConfig({
            NODE_ENV: 'production',
            SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false',
        }).enabled).toBe(false);
    });

    it('rejects ambiguous booleans and out-of-range or non-integer intervals', () => {
        expect(() => getSelfHostedProfileGlobalGateConfig({
            SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: '1',
        })).toThrow('SCRAPING_CONFIG_ERROR');
        for (const value of ['249', '60001', '750.5', 'not-a-number']) {
            expect(() => getSelfHostedProfileGlobalGateConfig({
                SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: value,
            })).toThrow('SCRAPING_CONFIG_ERROR');
        }
        expect(getSelfHostedProfileGlobalGateConfig({
            SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: '250',
        }).minIntervalMs).toBe(250);
        expect(getSelfHostedProfileGlobalGateConfig({
            SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: '60000',
        }).minIntervalMs).toBe(60_000);
    });

    it.each([
        ['SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS', '49'],
        ['SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS', '1001'],
        ['SELFHOSTED_PROFILE_GLOBAL_RPC_TIMEOUT_MS', '99'],
        ['SELFHOSTED_PROFILE_GLOBAL_RPC_TIMEOUT_MS', '5001'],
        ['SELFHOSTED_PROFILE_GLOBAL_ADMISSION_MAX_WAIT_MS', '-1'],
        ['SELFHOSTED_PROFILE_GLOBAL_ADMISSION_MAX_WAIT_MS', '300001'],
        ['SELFHOSTED_PROFILE_GLOBAL_FULL_MAX_WAIT_MS', '-1'],
        ['SELFHOSTED_PROFILE_GLOBAL_FULL_MAX_WAIT_MS', '1.5'],
    ])('rejects invalid bounded timing setting %s=%s', (key, value) => {
        expect(() => getSelfHostedProfileGlobalGateConfig({ [key]: value }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });
});

describe('selfhosted production-wide profile request reservation', () => {
    it('calls the exact RPC and accepts only its strict versioned result', async () => {
        const { client, rpc } = fakeClient({ data: validReservation, error: null });

        await expect(reserveSelfHostedProfileRequestStart(client, 750, {
            maxWaitMs: 500,
            responseGuardMs: 100,
            rpcTimeoutMs: 750,
        }))
            .resolves.toEqual(validReservation);
        expect(rpc).toHaveBeenCalledWith(SELFHOSTED_PROFILE_GLOBAL_GATE_RPC, {
            p_min_interval_ms: 750,
            p_response_guard_ms: 100,
            p_max_wait_ms: 500,
        });
    });

    it.each([
        null,
        [],
        { ...validReservation, schemaVersion: 2 },
        { ...validReservation, waitMs: -1 },
        { ...validReservation, waitMs: 1.5 },
        { ...validReservation, waitMs: SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS + 1 },
        { ...validReservation, reservedAt: 'not-a-timestamp' },
        { ...validReservation, unexpected: true },
    ])('fails closed on a malformed RPC result %#', async (data) => {
        const { client } = fakeClient({ data, error: null });

        await expect(reserveSelfHostedProfileRequestStart(client, 750)).rejects.toThrow(
            'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
        );
    });

    it('sanitizes returned and thrown RPC errors', async () => {
        const returned = fakeClient({
            data: null,
            error: { message: 'database-host-and-secret-detail' },
        });
        await expect(reserveSelfHostedProfileRequestStart(returned.client, 750))
            .rejects.toThrow(
                'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
            );

        const falseyError = fakeClient({ data: validReservation, error: '' });
        await expect(reserveSelfHostedProfileRequestStart(falseyError.client, 750))
            .rejects.toThrow(
                'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
            );

        const thrown: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(() => rpcBuilder(Promise.reject(
                new Error('raw connection string')
            ))),
        };
        const error = await reserveSelfHostedProfileRequestStart(thrown, 750)
            .catch(caught => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain('connection string');
    });

    it('reserves first and waits exactly the returned delay', async () => {
        const order: string[] = [];
        let clock = 0;
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(() => {
                order.push('reserve');
                return rpcBuilder({ data: validReservation, error: null });
            }),
        };
        const gate = createSelfHostedProfileGlobalGate({
            client,
            now: () => clock,
            sleep: async (ms) => {
                order.push(`wait:${ms}`);
                clock += ms;
            },
        });

        const started = { request: true };
        await expect(gate.reserveWaitAndStart(750, defaultAttemptOptions, {
            beforeStart: () => order.push('beforeStart'),
            start: () => {
                order.push('start');
                return started;
            },
        })).resolves.toEqual({ reservation: validReservation, started });
        expect(order).toEqual(['reserve', 'wait:125', 'beforeStart', 'start']);
    });

    it('rejects a reservation when total RPC latency exceeds the response guard', async () => {
        let clock = 0;
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(() => {
                clock += 600;
                return rpcBuilder({
                    data: { ...validReservation, waitMs: 0 },
                    error: null,
                });
            }),
        };
        const gate = createSelfHostedProfileGlobalGate({
            client,
            now: () => clock,
            sleep: async () => undefined,
        });

        await expect(gate.reserveWaitAndStart(750, defaultAttemptOptions, {
            start: () => undefined,
        })).rejects.toThrow('SELFHOSTED_PROFILE_COORDINATION_ERROR');
    });

    it('waits again when sleep resolves before the reserved relative delay', async () => {
        let clock = 0;
        const sleeps: number[] = [];
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(() => {
                clock += 20;
                return rpcBuilder({
                    data: { ...validReservation, waitMs: 100 },
                    error: null,
                });
            }),
        };
        const gate = createSelfHostedProfileGlobalGate({
            client,
            now: () => clock,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock += sleeps.length === 1 ? 40 : ms;
            },
        });

        await expect(gate.reserveWaitAndStart(750, defaultAttemptOptions, {
            start: () => undefined,
        })).resolves.toMatchObject({ reservation: { waitMs: 100 } });
        expect(sleeps).toEqual([100, 60]);
        expect(clock).toBe(120);
    });

    it('rejects when RPC latency plus positive sleep overshoot exceeds the guard', async () => {
        let clock = 0;
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(() => {
                clock += 20;
                return rpcBuilder({
                    data: { ...validReservation, waitMs: 100 },
                    error: null,
                });
            }),
        };
        const gate = createSelfHostedProfileGlobalGate({
            client,
            now: () => clock,
            sleep: async () => {
                clock += 190;
            },
        });

        await expect(gate.reserveWaitAndStart(750, defaultAttemptOptions, {
            start: () => undefined,
        })).rejects.toThrow('SELFHOSTED_PROFILE_COORDINATION_ERROR');
    });

    it('charges the 1ms ceil allowance before permitting the final start handoff', async () => {
        let clock = 0;
        const start = vi.fn();
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(() => {
                clock += 99;
                return rpcBuilder({
                    data: { ...validReservation, waitMs: 0 },
                    error: null,
                });
            }),
        };
        const gate = createSelfHostedProfileGlobalGate({
            client,
            now: () => clock,
        });

        await expect(gate.reserveWaitAndStart(750, defaultAttemptOptions, {
            beforeStart: () => { clock += 1; },
            start,
        })).rejects.toThrow('SELFHOSTED_PROFILE_COORDINATION_ERROR');
        expect(start).not.toHaveBeenCalled();
    });

    it('aborts and rejects a never-settling RPC at the hard timeout', async () => {
        vi.useFakeTimers();
        try {
            const never = new Promise<{ data: unknown; error: unknown }>(() => undefined);
            const abortSignal = vi.fn<(
                signal: AbortSignal
            ) => PromiseLike<{ data: unknown; error: unknown }>>(() => never);
            const builder = Object.assign(never, { abortSignal });
            const client = {
                rpc: vi.fn(() => builder),
            } as unknown as SelfHostedProfileGlobalGateRpcClient;
            let rejection: unknown;

            void reserveSelfHostedProfileRequestStart(client, 750, {
                maxWaitMs: 500,
                responseGuardMs: 100,
                rpcTimeoutMs: 750,
            }).catch(error => {
                rejection = error;
            });
            await vi.advanceTimersByTimeAsync(750);

            expect(rejection).toBeInstanceOf(Error);
            expect((rejection as Error).message).toBe(
                'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
            );
            expect(abortSignal).toHaveBeenCalledTimes(1);
            expect(abortSignal.mock.calls[0][0].aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shortens the never-settling RPC timeout to the caller deadline', async () => {
        vi.useFakeTimers();
        try {
            const never = new Promise<{ data: unknown; error: unknown }>(() => undefined);
            const abortSignal = vi.fn<(
                signal: AbortSignal
            ) => PromiseLike<{ data: unknown; error: unknown }>>(() => never);
            const client = {
                rpc: vi.fn(() => Object.assign(never, { abortSignal })),
            } as unknown as SelfHostedProfileGlobalGateRpcClient;
            let rejection: unknown;

            void reserveSelfHostedProfileRequestStart(client, 750, {
                deadlineAtMs: 10_100,
                maxWaitMs: 500,
                responseGuardMs: 100,
                rpcTimeoutMs: 750,
            }, () => 10_000).catch(error => {
                rejection = error;
            });
            await vi.advanceTimersByTimeAsync(99);
            expect(rejection).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);

            expect(rejection).toBeInstanceOf(Error);
            expect(abortSignal.mock.calls[0][0].aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
