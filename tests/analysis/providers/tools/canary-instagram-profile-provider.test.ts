import { describe, expect, it, vi } from 'vitest';
import { parseInstagramProfileProviderCanaryArgs } from '../../../../scripts/canary-instagram-profile-provider-options';
import {
    deleteAndVerifyApifyRunStorage,
    runInstagramProfileProviderCanary,
    runInstagramProfileProviderCanaryCli,
    type InstagramProfileProviderCanaryDependencies,
    type InstagramProfileProviderCanaryRunRecord,
    type InstagramProfileProviderCanarySource,
    type ProfileProviderCanaryRunEvidence,
} from '../../../../scripts/canary-instagram-profile-provider';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function options(paid = false) {
    return parseInstagramProfileProviderCanaryArgs([
        '--source-request-id', SOURCE_REQUEST_ID,
        ...(paid ? ['--confirm-paid-api-call'] : []),
    ]);
}

function source(): InstagramProfileProviderCanarySource {
    return {
        sourceRunIds: Array.from({ length: 8 }, (_, index) => `SourceRun${index}`),
        usernames: Array.from({ length: 15 }, (_, index) => `candidate_${index}`),
        criticalIncompleteCount: 3,
    };
}

function evidence(overrides: Partial<ProfileProviderCanaryRunEvidence> = {}): ProfileProviderCanaryRunEvidence {
    return {
        outcomes: Array.from({ length: 15 }, () => 'success' as const),
        criticalSuccessCount: 3,
        latencyMs: 59_999,
        buildMatched: true,
        restrictedAccess: true,
        ...overrides,
    };
}

function record(
    repetition: 1 | 2,
    state: InstagramProfileProviderCanaryRunRecord['state'],
    overrides: Partial<InstagramProfileProviderCanaryRunRecord> = {}
): InstagramProfileProviderCanaryRunRecord {
    return {
        repetition,
        state,
        runId: state === 'running' || state === 'terminal' ? `PaidRun${repetition}` : null,
        runStartedAtMs: state === 'running' || state === 'terminal'
            ? Date.parse('2026-07-19T00:00:00.000Z')
            : null,
        evidence: state === 'terminal' ? evidence() : null,
        terminalSucceeded: state === 'terminal' ? true : null,
        actualCostUsd: state === 'terminal' ? 0.04 : null,
        costStatus: state === 'terminal' ? 'actual' : 'conservative',
        cleanup: {
            keyValueStore: state === 'terminal',
            dataset: state === 'terminal',
            requestQueue: state === 'terminal',
        },
        gatePassed: state === 'terminal' ? true : null,
        ...overrides,
    };
}

function setup(input: {
    initial?: InstagramProfileProviderCanaryRunRecord[];
    source?: InstagramProfileProviderCanarySource;
    evidences?: ProfileProviderCanaryRunEvidence[];
    costs?: Array<number | null>;
    storageGet?: () => unknown;
    throwBeforeRunId?: boolean;
    checkpointFails?: boolean;
} = {}) {
    const events: string[] = [];
    const rows = new Map((input.initial ?? []).map(row => [row.repetition, row]));
    let freshRunNumber = 0;
    let evidenceIndex = 0;
    let costIndex = 0;
    const storageGet = input.storageGet ?? (() => undefined);
    const resources = new Map<string, {
        delete: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
    }>();
    const resource = (runId: string, kind: string) => {
        const key = `${runId}:${kind}`;
        if (!resources.has(key)) {
            resources.set(key, {
                delete: vi.fn(async () => { events.push(`delete:${runId}:${kind}`); }),
                get: vi.fn(async () => storageGet()),
            });
        }
        return resources.get(key)!;
    };

    const deps: InstagramProfileProviderCanaryDependencies = {
        resumeTerminalization: vi.fn(async () => null),
        loadSource: vi.fn(async () => input.source ?? source()),
        assertPaidReadiness: vi.fn(async () => { events.push('readiness'); }),
        loadRun: vi.fn(async repetition => rows.get(repetition) ?? null),
        reserveRun: vi.fn(async ({ repetition }) => {
            events.push(`reserve:${repetition}`);
            const existing = rows.get(repetition);
            if (existing) return { created: false, run: existing };
            const run = record(repetition, 'reserved');
            rows.set(repetition, run);
            return { created: true, run };
        }),
        checkpointStarted: vi.fn(async ({ repetition, runId }) => {
            events.push(`checkpoint:${repetition}`);
            if (input.checkpointFails) throw new Error('sensitive persistence failure');
            const run = record(repetition, 'running', { runId });
            rows.set(repetition, run);
            return run;
        }),
        markAmbiguous: vi.fn(async ({ repetition }) => {
            events.push(`ambiguous:${repetition}`);
            const run = record(repetition, 'ambiguous');
            rows.set(repetition, run);
            return run;
        }),
        terminalize: vi.fn(async ({ repetition, runId, evidence: runEvidence, gatePassed }) => {
            events.push(`terminal:${repetition}`);
            const run = record(repetition, 'terminal', {
                runId,
                evidence: runEvidence,
                terminalSucceeded: gatePassed,
                actualCostUsd: null,
                costStatus: 'conservative',
                cleanup: { keyValueStore: false, dataset: false, requestQueue: false },
                gatePassed,
            });
            rows.set(repetition, run);
            return run;
        }),
        reconcileActualCost: vi.fn(async ({ repetition, actualCostUsd }) => {
            events.push(`cost:${repetition}`);
            const run = { ...rows.get(repetition)!, actualCostUsd, costStatus: 'actual' as const };
            rows.set(repetition, run);
            return run;
        }),
        markStorageCleaned: vi.fn(async ({ repetition, storage }) => {
            events.push(`clean:${repetition}:${storage}`);
            const current = rows.get(repetition)!;
            const cleanup = { ...current.cleanup, [storage]: true };
            const run = {
                ...current,
                cleanup,
                gatePassed: Object.values(cleanup).every(Boolean)
                    && (current.actualCostUsd ?? Number.POSITIVE_INFINITY) <= 0.05
                    && current.evidence?.outcomes.every(outcome => outcome === 'success') === true
                    && current.evidence.criticalSuccessCount === 3
                    && current.evidence.latencyMs <= 60_000
                    && current.evidence.buildMatched
                    && current.evidence.restrictedAccess,
            };
            rows.set(repetition, run);
            return run;
        }),
        beginTerminalization: vi.fn(async ({ status }) => {
            events.push(`begin-terminalization:${status}`);
        }),
        markSourceStorageCleaned: vi.fn(async ({ storage }) => {
            events.push(`source-clean:${storage}`);
        }),
        markExperimentTerminal: vi.fn(async ({ status }) => { events.push(`experiment:${status}`); }),
        executeRun: vi.fn(async ({ resumeRunId, onRunStarted }) => {
            if (input.throwBeforeRunId && !resumeRunId) {
                throw new Error('sensitive provider start failure');
            }
            const runId = resumeRunId ?? `PaidRun${++freshRunNumber}`;
            if (!resumeRunId) {
                events.push(`start:${freshRunNumber}`);
                await onRunStarted(runId);
            }
            events.push(`wait:${runId}`);
            return input.evidences?.[evidenceIndex++] ?? evidence();
        }),
        getStableActualCost: vi.fn(async () => input.costs
            ? input.costs[costIndex++] ?? null
            : 0.04),
        getApifyClient: vi.fn(() => ({
            run: (runId: string) => ({
                keyValueStore: () => resource(runId, 'keyValueStore'),
                dataset: () => resource(runId, 'dataset'),
                requestQueue: () => resource(runId, 'requestQueue'),
            }),
        })),
        writeStdout: vi.fn(),
    };

    return { deps, events, rows, resources };
}

describe('Instagram profile provider canary replay', () => {
    it.each(['terminalizing', 'experiment_terminal'])(
        'keeps default replay write-free when the experiment is %s',
        async () => {
        const { deps } = setup();
        vi.mocked(deps.resumeTerminalization).mockResolvedValue({
            runs: [record(1, 'terminal', { gatePassed: false })],
        });

        await expect(runInstagramProfileProviderCanary(options(), deps)).resolves.toMatchObject({
            mode: 'replay',
            source_cleanup_complete: false,
            experiment_terminal: false,
            gate_passed: false,
        });
        expect(deps.resumeTerminalization).not.toHaveBeenCalled();
        expect(deps.loadSource).toHaveBeenCalledOnce();
        expect(deps.assertPaidReadiness).not.toHaveBeenCalled();
        expect(deps.reserveRun).not.toHaveBeenCalled();
        expect(deps.checkpointStarted).not.toHaveBeenCalled();
        expect(deps.markAmbiguous).not.toHaveBeenCalled();
        expect(deps.terminalize).not.toHaveBeenCalled();
        expect(deps.reconcileActualCost).not.toHaveBeenCalled();
        expect(deps.markStorageCleaned).not.toHaveBeenCalled();
        expect(deps.executeRun).not.toHaveBeenCalled();
        expect(deps.beginTerminalization).not.toHaveBeenCalled();
        expect(deps.markSourceStorageCleaned).not.toHaveBeenCalled();
        expect(deps.markExperimentTerminal).not.toHaveBeenCalled();
    });

    it('resumes terminal cleanup only with exact paid confirmation', async () => {
        const { deps } = setup();
        vi.mocked(deps.resumeTerminalization).mockResolvedValue({
            runs: [record(1, 'terminal', { gatePassed: false })],
        });

        await expect(runInstagramProfileProviderCanary(options(true), deps)).resolves.toMatchObject({
            mode: 'paid_canary',
            source_cleanup_complete: true,
            experiment_terminal: true,
            gate_passed: false,
        });
        expect(deps.resumeTerminalization).toHaveBeenCalledOnce();
        expect(deps.loadSource).not.toHaveBeenCalled();
        expect(deps.assertPaidReadiness).not.toHaveBeenCalled();
        expect(deps.reserveRun).not.toHaveBeenCalled();
        expect(deps.executeRun).not.toHaveBeenCalled();
    });

    it('never starts a replacement after verified_no_run enters terminal cleanup', async () => {
        const { deps } = setup();
        vi.mocked(deps.resumeTerminalization).mockResolvedValue({ runs: [] });

        await expect(runInstagramProfileProviderCanary(options(true), deps)).resolves.toMatchObject({
            mode: 'paid_canary',
            runs: [],
            source_cleanup_complete: true,
            experiment_terminal: true,
            gate_passed: false,
        });
        expect(deps.loadSource).not.toHaveBeenCalled();
        expect(deps.reserveRun).not.toHaveBeenCalled();
        expect(deps.executeRun).not.toHaveBeenCalled();
    });

    it('validates the exact source set with zero starts, readiness checks, or writes', async () => {
        const { deps } = setup();

        await expect(runInstagramProfileProviderCanary(options(), deps)).resolves.toMatchObject({
            mode: 'replay',
            source_run_count: 8,
            requested_count: 15,
            critical_incomplete_count: 3,
            runs: [],
            session_maximum_exposure_usd: 0,
        });
        expect(deps.executeRun).not.toHaveBeenCalled();
        expect(deps.assertPaidReadiness).not.toHaveBeenCalled();
        expect(deps.loadRun).not.toHaveBeenCalled();
        expect(deps.reserveRun).not.toHaveBeenCalled();
        expect(deps.markSourceStorageCleaned).not.toHaveBeenCalled();
        expect(deps.beginTerminalization).not.toHaveBeenCalled();
    });

    it.each([
        { sourceRunIds: source().sourceRunIds.slice(0, 7) },
        { sourceRunIds: [...source().sourceRunIds.slice(0, 7), source().sourceRunIds[0]] },
        { usernames: source().usernames.slice(0, 14) },
        { usernames: [...source().usernames.slice(0, 14), source().usernames[0]] },
        { criticalIncompleteCount: 2 },
    ])('rejects an inexact source before any paid dependency', async override => {
        const fixture = { ...source(), ...override };
        const { deps } = setup({ source: fixture });
        await expect(runInstagramProfileProviderCanary(options(true), deps))
            .rejects.toThrow('SOURCE_INVALID');
        expect(deps.assertPaidReadiness).not.toHaveBeenCalled();
        expect(deps.reserveRun).not.toHaveBeenCalled();
        expect(deps.executeRun).not.toHaveBeenCalled();
    });
});

describe('Instagram profile provider paid lifecycle', () => {
    it('checks readiness immediately before each reserve and starts exactly two gated runs', async () => {
        const { deps, events } = setup();

        const result = await runInstagramProfileProviderCanary(options(true), deps);

        expect(result).toMatchObject({
            mode: 'paid_canary',
            total_actual_cost_usd: 0.08,
            cost_status: 'actual',
            source_cleanup_complete: true,
            experiment_terminal: true,
            gate_passed: true,
        });
        expect(result.runs).toHaveLength(2);
        expect(deps.loadSource).toHaveBeenCalledTimes(2);
        expect(deps.executeRun).toHaveBeenCalledTimes(2);
        expect(events.indexOf('readiness')).toBe(events.indexOf('reserve:1') - 1);
        expect(events.lastIndexOf('readiness')).toBe(events.indexOf('reserve:2') - 1);
        expect(events.slice(0, 8)).toEqual([
            'readiness', 'reserve:1', 'start:1', 'checkpoint:1',
            'wait:PaidRun1', 'terminal:1', 'cost:1', 'delete:PaidRun1:keyValueStore',
        ]);
        expect(events.indexOf('reserve:2')).toBeGreaterThan(events.indexOf('clean:1:requestQueue'));
        expect(events.at(-1)).toBe('experiment:completed');
        expect(events.indexOf('begin-terminalization:completed'))
            .toBeLessThan(events.indexOf('delete:SourceRun0:keyValueStore'));
        expect(events.indexOf('delete:SourceRun7:keyValueStore'))
            .toBeLessThan(events.indexOf('source-clean:keyValueStore'));
        expect(events.indexOf('delete:SourceRun7:dataset'))
            .toBeLessThan(events.indexOf('source-clean:dataset'));
        expect(events.indexOf('delete:SourceRun7:requestQueue'))
            .toBeLessThan(events.indexOf('source-clean:requestQueue'));
    });

    it('requires exact 15/15 success, the pinned build, restricted access, and at most 60 seconds', async () => {
        const { deps } = setup({
            evidences: [evidence({ latencyMs: 60_001 })],
        });

        const result = await runInstagramProfileProviderCanary(options(true), deps);

        expect(result).toMatchObject({ gate_passed: false, experiment_terminal: true });
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0]).toMatchObject({
            terminal_count: 15,
            success_count: 15,
            latency_ms: 60_001,
            gate_passed: false,
        });
        expect(deps.reserveRun).toHaveBeenCalledTimes(1);
        expect(deps.markExperimentTerminal).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed_gate',
        }));
    });

    it('stops before every deletion and repetition two until stable actual cost exists', async () => {
        const { deps, events } = setup({ costs: [null] });

        const result = await runInstagramProfileProviderCanary(options(true), deps);

        expect(result).toMatchObject({
            total_actual_cost_usd: null,
            cost_status: 'conservative',
            source_cleanup_complete: false,
            experiment_terminal: false,
            gate_passed: false,
        });
        expect(events.some(event => event.startsWith('delete:'))).toBe(false);
        expect(deps.reserveRun).toHaveBeenCalledTimes(1);
        expect(deps.markSourceStorageCleaned).not.toHaveBeenCalled();
        expect(deps.beginTerminalization).not.toHaveBeenCalled();
    });

    it('records bounded provider overspend, fails the gate, and still completes strict cleanup', async () => {
        const { deps } = setup({ costs: [0.051] });

        const result = await runInstagramProfileProviderCanary(options(true), deps);

        expect(result).toMatchObject({
            total_actual_cost_usd: 0.051,
            cost_status: 'actual',
            source_cleanup_complete: true,
            experiment_terminal: true,
            gate_passed: false,
            runs: [{ actual_cost_usd: 0.051, gate_passed: false }],
        });
        expect(deps.reserveRun).toHaveBeenCalledTimes(1);
        expect(deps.beginTerminalization).toHaveBeenCalledWith(expect.objectContaining({
            status: 'strict_failure',
        }));
        expect(deps.markExperimentTerminal).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed_gate',
        }));
    });

    it('stops as an unreconciled incident when observed cost exceeds the bounded ceiling', async () => {
        const { deps } = setup({ costs: [1.001] });

        await expect(runInstagramProfileProviderCanary(options(true), deps))
            .rejects.toThrow('ACTUAL_COST_OUT_OF_BOUNDS');
        expect(deps.reconcileActualCost).not.toHaveBeenCalled();
        expect(deps.markStorageCleaned).not.toHaveBeenCalled();
        expect(deps.beginTerminalization).not.toHaveBeenCalled();
        expect(deps.markSourceStorageCleaned).not.toHaveBeenCalled();
    });

    it('resumes only a checkpointed run and never reserves or starts its replacement', async () => {
        const running = record(1, 'running');
        const { deps, events } = setup({ initial: [running] });

        await runInstagramProfileProviderCanary(options(true), deps);

        expect(deps.executeRun).toHaveBeenNthCalledWith(1, expect.objectContaining({
            resumeRunId: running.runId,
            durableRunStartedAtMs: running.runStartedAtMs,
        }));
        expect(events.filter(event => event === 'readiness')).toHaveLength(1);
        expect(events.filter(event => event.startsWith('start:'))).toEqual(['start:1']);
        expect(deps.reserveRun).toHaveBeenCalledTimes(1);
    });

    it('does not cross an ambiguous pre-ID start or continue with no fresh paid approval', async () => {
        const ambiguous = setup({ initial: [record(1, 'reserved')] });
        const first = await runInstagramProfileProviderCanary(options(true), ambiguous.deps);
        expect(first).toMatchObject({ experiment_terminal: false, gate_passed: false });
        expect(ambiguous.deps.markAmbiguous).toHaveBeenCalledOnce();
        expect(ambiguous.deps.executeRun).not.toHaveBeenCalled();

        const completedRepOne = record(1, 'terminal');
        const replay = setup({ initial: [completedRepOne] });
        await runInstagramProfileProviderCanary(options(), replay.deps);
        expect(replay.deps.loadRun).not.toHaveBeenCalled();
        expect(replay.deps.reserveRun).not.toHaveBeenCalled();
        expect(replay.deps.executeRun).not.toHaveBeenCalled();
    });

    it('marks a fresh pre-ID exception ambiguous without leaking the provider error', async () => {
        const { deps } = setup({ throwBeforeRunId: true });

        const result = await runInstagramProfileProviderCanary(options(true), deps);

        expect(result).toMatchObject({
            cost_status: 'conservative',
            experiment_terminal: false,
            gate_passed: false,
            runs: [{ lifecycle_status: 'ambiguous', actual_cost_usd: null }],
        });
        expect(deps.markAmbiguous).toHaveBeenCalledWith({ repetition: 1 });
        expect(deps.terminalize).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('sensitive provider start failure');
    });

    it('marks a lost start checkpoint ambiguous and never starts a replacement', async () => {
        const { deps } = setup({ checkpointFails: true });

        const result = await runInstagramProfileProviderCanary(options(true), deps);

        expect(result).toMatchObject({
            experiment_terminal: false,
            runs: [{ lifecycle_status: 'ambiguous' }],
        });
        expect(deps.executeRun).toHaveBeenCalledTimes(1);
        expect(deps.checkpointStarted).toHaveBeenCalledTimes(1);
        expect(deps.markAmbiguous).toHaveBeenCalledWith({ repetition: 1 });
        expect(deps.reserveRun).toHaveBeenCalledTimes(1);
    });

    it('deletes and verifies all three run-scoped storages before durable cleanup checkpoints', async () => {
        const { deps, events } = setup();
        await runInstagramProfileProviderCanary(options(true), deps);

        for (const storage of ['keyValueStore', 'dataset', 'requestQueue'] as const) {
            expect(events.indexOf(`delete:PaidRun1:${storage}`))
                .toBeLessThan(events.indexOf(`clean:1:${storage}`));
        }
        expect(events.filter(event => event.startsWith('delete:'))).toHaveLength(30);
    });
});

describe('Instagram profile provider cleanup and output safety', () => {
    it('proves deletion only when a run-scoped storage GET returns missing', async () => {
        const missing = setup();
        await expect(deleteAndVerifyApifyRunStorage(
            missing.deps.getApifyClient(), 'PaidRun1', 'dataset'
        )).resolves.toBeUndefined();

        const retained = setup({ storageGet: () => ({ id: 'still-present' }) });
        await expect(deleteAndVerifyApifyRunStorage(
            retained.deps.getApifyClient(), 'PaidRun1', 'dataset'
        )).rejects.toThrow('STORAGE_CLEANUP_UNVERIFIED');
    });

    it('writes only the sanitized aggregate result to stdout', async () => {
        const { deps } = setup();
        await runInstagramProfileProviderCanaryCli([
            '--source-request-id', SOURCE_REQUEST_ID,
        ], deps);
        const stdout = vi.mocked(deps.writeStdout!).mock.calls.flat().join('');
        expect(JSON.parse(stdout)).toMatchObject({ mode: 'replay', requested_count: 15 });
        expect(stdout).not.toMatch(
            /candidate_|SourceRun|PaidRun|run_?id|dataset_?id|token|hash|url|email|provider.*message/i
        );
    });
});
