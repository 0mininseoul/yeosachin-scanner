import { describe, expect, it, vi } from 'vitest';
import { createRequestStartGate } from '../../../../../../lib/services/instagram/providers/selfhosted/rate-limit';
import {
    createSelfHostedProfileGlobalGate,
    type SelfHostedProfileGlobalGate,
    type SelfHostedProfileGlobalGateAttemptOptions,
    type SelfHostedProfileGlobalGateHandoff,
    type SelfHostedProfileGlobalGateRpcClient,
} from '../../../../../../lib/services/instagram/providers/selfhosted/global-request-gate';
import {
    classifyWebProfileFailure,
    createSharedWebProfileFetchers,
    createWebProfileCircuitBreaker,
    getWebProfileConfig,
    makeWebProfileAdmissionFetcher,
    makeWebProfileFetcher,
    type WebProfileCircuitAttemptPermit,
    type WebProfileCircuitBreaker,
} from '../../../../../../lib/services/instagram/providers/selfhosted/web-client';

function response(payload: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(payload), { status, headers });
}

function env(overrides: Record<string, string> = {}) {
    return {
        SELFHOSTED_PROFILE_TIMEOUT_MS: '1000',
        SELFHOSTED_PROFILE_RETRIES: '0',
        SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS: '0',
        SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '0',
        SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS: '1000',
        SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD: '2',
        SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '3',
        SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS: '60000',
        ...overrides,
    };
}

function rawUser(username: string) {
    return {
        username,
        is_private: false,
        is_verified: false,
        edge_followed_by: { count: 1 },
        edge_follow: { count: 1 },
        edge_owner_to_timeline_media: { count: 0, edges: [] },
    };
}

function rpcBuilder(result: { data: unknown; error: unknown }) {
    const request = Promise.resolve(result);
    return Object.assign(request, {
        abortSignal: () => request,
    });
}

function neverSettlingRpcBuilder(onSignal: (signal: AbortSignal) => void) {
    const request = new Promise<{ data: unknown; error: unknown }>(() => undefined);
    return Object.assign(request, {
        abortSignal: (signal: AbortSignal) => {
            onSignal(signal);
            return request;
        },
    });
}

function immediateGlobalGate(): SelfHostedProfileGlobalGate {
    return {
        async reserveWaitAndStart<T>(
            minIntervalMs: number,
            options: SelfHostedProfileGlobalGateAttemptOptions,
            handoff: SelfHostedProfileGlobalGateHandoff<T>
        ) {
            void minIntervalMs;
            void options;
            handoff.beforeStart?.();
            return {
                reservation: {
                    schemaVersion: 1,
                    waitMs: 0,
                    reservedAt: '2026-07-16T12:34:56.789+00:00',
                },
                started: handoff.start(),
            };
        },
    };
}

describe('selfhosted web profile client', () => {
    it('keeps the default cold-profile start schedule within two minutes', () => {
        const config = getWebProfileConfig({});
        expect(config.minIntervalMs).toBe(300);
        expect((350 - 1) * config.minIntervalMs).toBeLessThan(120_000);
    });

    it('returns null only for HTTP 404 or an explicit data.user=null', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 404))
            .mockResolvedValueOnce(response({ data: { user: null } }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('missing_one')).resolves.toBeNull();
        await expect(fetchProfile('missing_two')).resolves.toBeNull();
    });

    it('rejects an unexpected successful response schema', async () => {
        const fetchProfile = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: {} })),
        });

        await expect(fetchProfile('target')).rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('honors Retry-After for a bounded 429 retry while other calls see the circuit', async () => {
        let clock = 0;
        const waits: number[] = [];
        const wait = async (ms: number) => {
            waits.push(ms);
            clock += ms;
        };
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 429, { 'retry-after': '0.5' }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('target') } }));
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_RETRIES: '1' }),
            fetchFn,
            now: () => clock,
            sleep: wait,
            gate: createRequestStartGate(() => clock, wait),
            circuit: createWebProfileCircuitBreaker(() => clock),
        });

        await expect(fetchProfile('target')).resolves.toMatchObject({ username: 'target' });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(waits).toContain(500);
    });

    it('keeps a bounded retry after a 429 probe gets a below-threshold schema failure', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 429))
            .mockResolvedValueOnce(response({ data: {} }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('target') } }));
        const fetchProfile = makeWebProfileFetcher({
            env: env({
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false',
                SELFHOSTED_PROFILE_RETRIES: '2',
            }),
            fetchFn,
            now: () => 0,
            sleep: async () => undefined,
        });

        await expect(fetchProfile('target')).resolves.toMatchObject({ username: 'target' });
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('opens immediately after a terminal 429 and fails the next call before fetch', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({}, 429));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('first')).rejects.toThrow('rate limited');
        await expect(fetchProfile('second')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('exposes only bounded routing metadata for an empty text/plain 429', async () => {
        const fetchProfile = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => new Response('', {
                status: 429,
                headers: { 'content-type': 'text/plain' },
            })),
        });

        const error = await fetchProfile('target').catch(caught => caught);

        expect(classifyWebProfileFailure(error)).toEqual({
            kind: 'rate_limit',
            retryable: true,
            httpStatus: 429,
        });
        expect(Object.keys(classifyWebProfileFailure(error) ?? {})).toEqual([
            'kind',
            'retryable',
            'httpStatus',
        ]);
        expect(classifyWebProfileFailure(new Error('target raw response'))).toBeNull();
    });

    it('opens after the configured successful-response schema burst threshold', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({ data: {} }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('first')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('second')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('third')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('opens after a bounded burst of retryable provider outages', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({}, 503));
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '2' }),
            fetchFn,
        });

        await expect(fetchProfile('first')).rejects.toThrow('HTTP 503');
        await expect(fetchProfile('second')).rejects.toThrow('HTTP 503');
        await expect(fetchProfile('third')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('counts a malformed raw profile contract and username mismatch as schema failures', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({ data: { user: { username: 'target' } } }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('other') } }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('target')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('target')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('target')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('keeps fresh admission independent from timeline, verification, and URL fields', async () => {
        const minimalUser = {
            username: 'target',
            is_private: false,
            edge_followed_by: { count: 401 },
            edge_follow: { count: 399 },
            edge_owner_to_timeline_media: { count: 'changed' },
            is_verified: 'changed',
            profile_pic_url: 'not a url',
        };
        const admissionFetcher = makeWebProfileAdmissionFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: { user: minimalUser } })),
        });
        const fullFetcher = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: { user: minimalUser } })),
        });

        await expect(admissionFetcher('target')).resolves.toMatchObject({
            username: 'target',
            edge_followed_by: { count: 401 },
            edge_follow: { count: 399 },
        });
        await expect(fullFetcher('target')).rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('rejects invalid reliability settings before making a request', () => {
        expect(() => getWebProfileConfig({ SELFHOSTED_PROFILE_RETRIES: 'unbounded' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });

    it('reserves globally and waits before usage accounting or the network request', async () => {
        const order: string[] = [];
        let clock = 0;
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn((_name, params) => {
                order.push(`reserve:${params.p_min_interval_ms}`);
                return rpcBuilder({
                    data: {
                        schemaVersion: 1,
                        waitMs: 40,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    error: null,
                });
            }),
        };
        const globalGate = createSelfHostedProfileGlobalGate({
            client,
            now: () => clock,
            sleep: async ms => {
                order.push(`wait:${ms}`);
                clock += ms;
            },
        });
        const fetchProfile = makeWebProfileFetcher({
            env: env({
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
                SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: '750',
            }),
            globalGate,
            now: () => clock,
            fetchFn: vi.fn<typeof fetch>(async () => {
                order.push('fetch');
                return response({ data: { user: rawUser('target') } });
            }),
        });

        await fetchProfile('target', undefined, {
            onRequest: () => order.push('onRequest'),
        });

        expect(order).toEqual(['reserve:750', 'wait:40', 'fetch', 'onRequest']);
    });

    it('bypasses the global RPC completely when the gate is disabled', async () => {
        const globalGate: SelfHostedProfileGlobalGate = {
            reserveWaitAndStart: vi.fn(async () => {
                throw new Error('must not run');
            }),
        };
        const circuit = createWebProfileCircuitBreaker(() => 0);
        const acquireAttempt = vi.spyOn(circuit, 'acquireAttempt');
        const assertAvailable = vi.spyOn(circuit, 'assertAvailable');
        const fetchFn = vi.fn<typeof fetch>(async () =>
            response({ data: { user: rawUser('target') } })
        );
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false' }),
            globalGate,
            circuit,
            fetchFn,
        });

        await expect(fetchProfile('target')).resolves.toMatchObject({ username: 'target' });
        expect(globalGate.reserveWaitAndStart).not.toHaveBeenCalled();
        expect(acquireAttempt).toHaveBeenCalledTimes(1);
        expect(assertAvailable).toHaveBeenCalledTimes(2);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('classifies coordination failure as retryable transport without a network start', async () => {
        const globalGate: SelfHostedProfileGlobalGate = {
            reserveWaitAndStart: vi.fn(async () => {
                throw new Error('raw database endpoint and credential');
            }),
        };
        const fetchFn = vi.fn<typeof fetch>();
        const onRequest = vi.fn();
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            fetchFn,
        });

        const error = await fetchProfile('target', undefined, { onRequest })
            .catch(caught => caught);

        expect(classifyWebProfileFailure(error)).toEqual({
            kind: 'transport',
            retryable: true,
            httpStatus: null,
        });
        expect((error as Error).message).not.toContain('database endpoint');
        expect(onRequest).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('aborts and drains a started request when post-start accounting throws', async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchFn = vi.fn<typeof fetch>((_input, init) => {
            requestSignal = init?.signal ?? undefined;
            return Promise.reject(new Error('raw in-flight provider failure'));
        });
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: immediateGlobalGate(),
            fetchFn,
        });

        const error = await fetchProfile('target', undefined, {
            onRequest: () => {
                throw new Error('raw accounting failure');
            },
        }).catch(caught => caught);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(requestSignal?.aborted).toBe(true);
        expect(classifyWebProfileFailure(error)).toEqual({
            kind: 'transport',
            retryable: true,
            httpStatus: null,
        });
        expect((error as Error).message).not.toContain('accounting');
        expect((error as Error).message).not.toContain('provider failure');
    });

    it('bounds the full gate wait to the caller deadline after request headroom', async () => {
        const clock = 10_000;
        const globalGate = immediateGlobalGate();
        const reserveWaitAndStart = vi.spyOn(globalGate, 'reserveWaitAndStart');
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            fetchFn: vi.fn<typeof fetch>(async () =>
                response({ data: { user: rawUser('target') } })
            ),
            now: () => clock,
        });

        await fetchProfile('target', undefined, {
            invocationDeadlineAtMs: clock + 5_000,
        });

        expect(reserveWaitAndStart).toHaveBeenCalledWith(
            750,
            {
                deadlineAtMs: clock + 3_750,
                maxWaitMs: 3_000,
                responseGuardMs: 100,
                rpcTimeoutMs: 750,
            },
            {
                beforeStart: expect.any(Function),
                start: expect.any(Function),
            }
        );
    });

    it('reserves deadline headroom for the larger response guard when it exceeds the RPC timeout', async () => {
        const clock = 10_000;
        const globalGate = immediateGlobalGate();
        const reserveWaitAndStart = vi.spyOn(globalGate, 'reserveWaitAndStart');
        const fetchProfile = makeWebProfileFetcher({
            env: env({
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
                SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS: '1000',
                SELFHOSTED_PROFILE_GLOBAL_RPC_TIMEOUT_MS: '100',
            }),
            globalGate,
            fetchFn: vi.fn<typeof fetch>(async () =>
                response({ data: { user: rawUser('target') } })
            ),
            now: () => clock,
        });

        await fetchProfile('target', undefined, {
            invocationDeadlineAtMs: clock + 5_000,
        });

        expect(reserveWaitAndStart).toHaveBeenCalledWith(
            750,
            {
                deadlineAtMs: clock + 3_750,
                maxWaitMs: 2_750,
                responseGuardMs: 1_000,
                rpcTimeoutMs: 100,
            },
            {
                beforeStart: expect.any(Function),
                start: expect.any(Function),
            }
        );
    });

    it('keeps successful independent-client network starts at least one interval apart', async () => {
        let nextStartMs = 0;
        let firstClock = 0;
        let secondClock = 0;
        const client = (advanceRpc: () => void): SelfHostedProfileGlobalGateRpcClient => ({
            rpc: vi.fn((_name, params) => {
                const waitMs = nextStartMs;
                nextStartMs += params.p_min_interval_ms + params.p_response_guard_ms;
                advanceRpc();
                return rpcBuilder({
                    data: {
                        schemaVersion: 1,
                        waitMs,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    error: null,
                });
            }),
        });
        const starts: number[] = [];
        const first = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: createSelfHostedProfileGlobalGate({
                client: client(() => { firstClock += 50; }),
                now: () => firstClock,
                sleep: async ms => { firstClock += ms; },
            }),
            now: () => firstClock,
            sleep: async ms => { firstClock += ms; },
            fetchFn: vi.fn<typeof fetch>(async () => {
                starts.push(firstClock);
                return response({ data: { user: rawUser('first') } });
            }),
        });
        const second = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: createSelfHostedProfileGlobalGate({
                client: client(() => undefined),
                now: () => secondClock,
                sleep: async ms => { secondClock += ms; },
            }),
            now: () => secondClock,
            sleep: async ms => { secondClock += ms; },
            fetchFn: vi.fn<typeof fetch>(async () => {
                starts.push(secondClock);
                return response({ data: { user: rawUser('second') } });
            }),
        });

        await Promise.all([first('first'), second('second')]);

        expect(starts).toEqual([50, 850]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(750);
    });

    it('rejects a first client whose post-wait handoff would collapse the shared interval', async () => {
        let nextStartMs = 0;
        let firstClock = 0;
        let secondClock = 0;
        const client = (advanceRpc: () => void): SelfHostedProfileGlobalGateRpcClient => ({
            rpc: vi.fn((_name, params) => {
                const waitMs = nextStartMs;
                nextStartMs += params.p_min_interval_ms + params.p_response_guard_ms;
                advanceRpc();
                return rpcBuilder({
                    data: {
                        schemaVersion: 1,
                        waitMs,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    error: null,
                });
            }),
        });
        const attemptPermit = {} as WebProfileCircuitAttemptPermit;
        let availabilityChecks = 0;
        const delayedCircuit: WebProfileCircuitBreaker = {
            acquireAttempt: vi.fn(() => attemptPermit),
            assertAvailable: vi.fn(() => {
                availabilityChecks++;
                if (availabilityChecks === 3) firstClock += 600;
            }),
            recordSuccess: vi.fn(),
            recordFailure: vi.fn(),
        };
        const starts: number[] = [];
        const firstOnRequest = vi.fn();
        const firstFetch = vi.fn<typeof fetch>(async () => {
            starts.push(firstClock);
            return response({ data: { user: rawUser('first') } });
        });
        const first = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: createSelfHostedProfileGlobalGate({
                client: client(() => { firstClock += 50; }),
                now: () => firstClock,
                sleep: async ms => { firstClock += ms; },
            }),
            circuit: delayedCircuit,
            now: () => firstClock,
            sleep: async ms => { firstClock += ms; },
            fetchFn: firstFetch,
        });
        const second = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: createSelfHostedProfileGlobalGate({
                client: client(() => undefined),
                now: () => secondClock,
                sleep: async ms => { secondClock += ms; },
            }),
            now: () => secondClock,
            sleep: async ms => { secondClock += ms; },
            fetchFn: vi.fn<typeof fetch>(async () => {
                starts.push(secondClock);
                return response({ data: { user: rawUser('second') } });
            }),
        });

        const [firstResult, secondResult] = await Promise.allSettled([
            first('first', undefined, { onRequest: firstOnRequest }),
            second('second'),
        ]);

        expect(starts).not.toEqual([650, 850]);
        expect(firstResult.status).toBe('rejected');
        expect(secondResult.status).toBe('fulfilled');
        expect(firstOnRequest).not.toHaveBeenCalled();
        expect(firstFetch).not.toHaveBeenCalled();
        expect(starts).toEqual([850]);
    });

    it('rejects a late 600ms reservation before Instagram while the next client starts safely', async () => {
        let nextStartMs = 0;
        let slowClock = 0;
        let nextClock = 0;
        const client = (advanceRpc: () => void): SelfHostedProfileGlobalGateRpcClient => ({
            rpc: vi.fn((_name, params) => {
                const waitMs = nextStartMs;
                nextStartMs += params.p_min_interval_ms + params.p_response_guard_ms;
                advanceRpc();
                return rpcBuilder({
                    data: {
                        schemaVersion: 1,
                        waitMs,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    error: null,
                });
            }),
        });
        const slowFetch = vi.fn<typeof fetch>();
        const slowOnRequest = vi.fn();
        const nextStarts: number[] = [];
        const slow = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: createSelfHostedProfileGlobalGate({
                client: client(() => { slowClock += 600; }),
                now: () => slowClock,
                sleep: async ms => { slowClock += ms; },
            }),
            now: () => slowClock,
            sleep: async ms => { slowClock += ms; },
            fetchFn: slowFetch,
        });
        const next = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate: createSelfHostedProfileGlobalGate({
                client: client(() => undefined),
                now: () => nextClock,
                sleep: async ms => { nextClock += ms; },
            }),
            now: () => nextClock,
            sleep: async ms => { nextClock += ms; },
            fetchFn: vi.fn<typeof fetch>(async () => {
                nextStarts.push(nextClock);
                return response({ data: { user: rawUser('next') } });
            }),
        });

        const [slowResult, nextResult] = await Promise.allSettled([
            slow('slow', undefined, { onRequest: slowOnRequest }),
            next('next'),
        ]);

        expect(slowResult.status).toBe('rejected');
        expect(nextResult.status).toBe('fulfilled');
        expect(slowOnRequest).not.toHaveBeenCalled();
        expect(slowFetch).not.toHaveBeenCalled();
        expect(nextStarts).toEqual([850]);
    });

    it('hard-times out a never-settling reservation before usage or Instagram starts', async () => {
        vi.useFakeTimers();
        try {
            let abortSignal: AbortSignal | undefined;
            const client: SelfHostedProfileGlobalGateRpcClient = {
                rpc: vi.fn(() => neverSettlingRpcBuilder(signal => {
                    abortSignal = signal;
                })),
            };
            const fetchFn = vi.fn<typeof fetch>();
            const onRequest = vi.fn();
            const fetchProfile = makeWebProfileFetcher({
                env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
                globalGate: createSelfHostedProfileGlobalGate({ client }),
                fetchFn,
            });

            const pending = fetchProfile('target', undefined, { onRequest })
                .catch(caught => caught);
            await vi.advanceTimersByTimeAsync(750);
            const error = await pending;

            expect(classifyWebProfileFailure(error)).toEqual({
                kind: 'transport',
                retryable: true,
                httpStatus: null,
            });
            expect(abortSignal?.aborted).toBe(true);
            expect(onRequest).not.toHaveBeenCalled();
            expect(fetchFn).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails before the global RPC when the caller deadline cannot cover gate and request work', async () => {
        const clock = 10_000;
        const globalGate = immediateGlobalGate();
        const reserveWaitAndStart = vi.spyOn(globalGate, 'reserveWaitAndStart');
        const fetchFn = vi.fn<typeof fetch>();
        const onRequest = vi.fn();
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            fetchFn,
            now: () => clock,
        });

        const error = await fetchProfile('target', undefined, {
            invocationDeadlineAtMs: clock + 1_900,
            onRequest,
        }).catch(caught => caught);

        expect(classifyWebProfileFailure(error)).toEqual({
            kind: 'transport',
            retryable: true,
            httpStatus: null,
        });
        expect(reserveWaitAndStart).not.toHaveBeenCalled();
        expect(onRequest).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('rechecks the process-local circuit after the global wait', async () => {
        let circuitOpen = false;
        const attemptPermit = {} as WebProfileCircuitAttemptPermit;
        const circuit: WebProfileCircuitBreaker = {
            acquireAttempt: vi.fn(() => attemptPermit),
            assertAvailable: vi.fn(() => {
                if (circuitOpen) throw new Error('circuit opened while globally queued');
            }),
            recordSuccess: vi.fn(),
            recordFailure: vi.fn(),
        };
        const globalGate: SelfHostedProfileGlobalGate = {
            async reserveWaitAndStart<T>(
                minIntervalMs: number,
                options: SelfHostedProfileGlobalGateAttemptOptions,
                handoff: SelfHostedProfileGlobalGateHandoff<T>
            ) {
                void minIntervalMs;
                void options;
                circuitOpen = true;
                handoff.beforeStart?.();
                return {
                    reservation: {
                        schemaVersion: 1,
                        waitMs: 0,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    started: handoff.start(),
                };
            },
        };
        const fetchFn = vi.fn<typeof fetch>();
        const onRequest = vi.fn();
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            circuit,
            fetchFn,
        });

        await expect(fetchProfile('target', undefined, { onRequest })).rejects.toThrow();
        expect(circuit.assertAvailable).toHaveBeenCalledTimes(3);
        expect(onRequest).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('invalidates a reissued retry probe when another request reopens during the global wait', async () => {
        const circuit = createWebProfileCircuitBreaker(() => 0);
        let reservationCount = 0;
        let releaseLaterResponse!: () => void;
        let markLaterStarted!: () => void;
        let markLaterFinished!: () => void;
        const laterResponse = new Promise<void>(resolve => {
            releaseLaterResponse = resolve;
        });
        const laterStarted = new Promise<void>(resolve => {
            markLaterStarted = resolve;
        });
        const laterFinished = new Promise<void>(resolve => {
            markLaterFinished = resolve;
        });
        const globalGate: SelfHostedProfileGlobalGate = {
            async reserveWaitAndStart<T>(
                minIntervalMs: number,
                options: SelfHostedProfileGlobalGateAttemptOptions,
                handoff: SelfHostedProfileGlobalGateHandoff<T>
            ) {
                void minIntervalMs;
                void options;
                reservationCount++;
                if (reservationCount === 4) {
                    releaseLaterResponse();
                    await laterFinished;
                }
                handoff.beforeStart?.();
                return {
                    reservation: {
                        schemaVersion: 1,
                        waitMs: 0,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    started: handoff.start(),
                };
            },
        };
        let targetFetches = 0;
        const fetchFn = vi.fn<typeof fetch>(async input => {
            const username = new URL(String(input)).searchParams.get('username');
            if (username === 'later') {
                markLaterStarted();
                await laterResponse;
                return response({}, 429);
            }
            targetFetches++;
            if (targetFetches === 1) return response({}, 429);
            if (targetFetches === 2) return response({ data: {} });
            return response({ data: { user: rawUser('target') } });
        });
        const sharedDeps = {
            globalGate,
            circuit,
            fetchFn,
            now: () => 0,
            sleep: async () => undefined,
        };
        const fetchLater = makeWebProfileFetcher({
            ...sharedDeps,
            env: env({
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
                SELFHOSTED_PROFILE_RETRIES: '0',
            }),
        });
        const fetchTarget = makeWebProfileFetcher({
            ...sharedDeps,
            env: env({
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
                SELFHOSTED_PROFILE_RETRIES: '2',
            }),
        });

        const laterCall = fetchLater('later')
            .catch(() => undefined)
            .finally(markLaterFinished);
        await laterStarted;

        await expect(fetchTarget('target')).rejects.toThrow('circuit is open');
        await laterCall;
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(targetFetches).toBe(2);
    });

    it('builds the default full and admission fetchers around one shared global gate', async () => {
        const globalGate = immediateGlobalGate();
        const reserveWaitAndStart = vi.spyOn(globalGate, 'reserveWaitAndStart');
        const fetchFn = vi.fn<typeof fetch>(async () =>
            response({ data: { user: rawUser('target') } })
        );
        const fetchers = createSharedWebProfileFetchers({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            fetchFn,
        });

        await fetchers.full('target');
        await fetchers.admission('target');

        expect(reserveWaitAndStart).toHaveBeenNthCalledWith(
            1,
            750,
            {
                maxWaitMs: 60_000,
                responseGuardMs: 100,
                rpcTimeoutMs: 750,
            },
            {
                beforeStart: expect.any(Function),
                start: expect.any(Function),
            }
        );
        expect(reserveWaitAndStart).toHaveBeenNthCalledWith(
            2,
            750,
            {
                maxWaitMs: 500,
                responseGuardMs: 100,
                rpcTimeoutMs: 750,
            },
            {
                beforeStart: expect.any(Function),
                start: expect.any(Function),
            }
        );
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
});
