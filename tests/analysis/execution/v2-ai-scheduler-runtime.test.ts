import { paidStandardFourthFeatureEnabled, withPaidStandardCapacityJob } from '@/lib/services/analysis/paid-standard-capacity';
import { VertexAiBudgetCapacityPendingError } from '@/lib/services/ai/vertex-ai-cost-policy';
import { DevLiveVertexBudgetReservationPendingError } from '@/lib/services/dev-ui/live-budget-signals';
import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_SCHEDULER_V1_POLICY,
    ProcessWideAnalysisV2SchedulerArbiter,
    runAnalysisV2FairAiScheduler,
    type AnalysisV2SchedulerOperationStore,
    type AnalysisV2SchedulerTask,
} from '../../../lib/services/analysis/v2-ai-scheduler-runtime';
import { AnalysisV2AiTerminalUnavailableError } from '../../../lib/services/analysis/v2-ai-fallback-policy';
import { AnalysisV2SchedulerContinuationError } from '../../../lib/services/analysis/v2-ai-scheduler-continuation';

function operationStore<T = string>(
    states = new Map<string, 'claimed' | 'ready'>(),
): AnalysisV2SchedulerOperationStore<T> {
    return {
        claim: vi.fn(async ({ key }) => {
            const state = states.get(key);
            if (state === 'ready') return {
                decision: 'ready' as const,
                value: key as T,
            };
            if (state === 'claimed') return {
                decision: 'deferred' as const,
                notBeforeAtMs: 360_000,
            };
            states.set(key, 'claimed');
            return { decision: 'execute' as const, claimToken: `claim:${key}` };
        }),
        commitReady: vi.fn(async ({ key, claimToken }) => {
            if (states.get(key) !== 'claimed' || claimToken !== `claim:${key}`) {
                throw new Error('OPERATION_FENCE_MISMATCH');
            }
            states.set(key, 'ready');
        }),
    };
}

function task(
    key: string,
    stage: AnalysisV2SchedulerTask<string>['stage'],
    ordinal: number,
    run = vi.fn(async () => key),
): AnalysisV2SchedulerTask<string> {
    return { key, stage, ordinal, run };
}

describe('analysis V2 scheduler-v1 runtime', () => {
    it('keeps a busy feature slot on one worker from occupying a second worker', async () => {
        const first = new ProcessWideAnalysisV2SchedulerArbiter();
        const second = new ProcessWideAnalysisV2SchedulerArbiter();
        const policy = { featureAnalysisConcurrency: 1 };
        let release!: () => void;
        const held = new Promise<string>(resolve => { release = () => resolve('held'); });
        const run = (key: string, arbiter: ProcessWideAnalysisV2SchedulerArbiter, execute: () => Promise<string>) =>
            runAnalysisV2FairAiScheduler({
                capability: 'scheduler-v1', policy, operationStore: operationStore(),
                handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
                tasks: [{ key, stage: 'featureAnalysis', ordinal: 0, run: execute }],
            }, arbiter);
        const entered = vi.fn(() => held);
        const blocked = vi.fn(async () => 'second delivery');
        const executions = [run('first delivery', first, entered), run('second delivery', first, blocked)];
        try {
            const free = await run('different worker', second, async () => 'free');
            expect(free.completed[0]?.value).toBe('free');
            expect(entered).toHaveBeenCalledOnce();
            expect(blocked).not.toHaveBeenCalled();
        } finally {
            release();
            await Promise.all(executions);
        }
        expect(blocked).toHaveBeenCalledOnce();
    });

    it('requires the signed worker, enabled flag, matching job and v2.11 policy for a fourth feature', async () => {
        const policy = 'ai-stage-policy-v2.11';
        const job = { requestId: 'fixture', jobKey: 'track:profile-ai:batch:0', claimToken: 'claim' };
        const env = { NODE_ENV: 'production', K_SERVICE: 'analysis-paid-worker', ANALYSIS_WORKLOAD_ROLE: 'paid',
            ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', PAID_STANDARD_VERTEX_CAPACITY_MODE: 'expanded128', PAID_STANDARD_PROCESS_FEATURE_SLOTS: '4' };
        const verify = vi.fn(async () => true);
        const check = (overrides: Record<string, string | undefined>, version = policy, fence = job) =>
            withPaidStandardCapacityJob(job, verify, () => paidStandardFourthFeatureEnabled(version, fence.requestId, fence), { ...env, ...overrides });
        expect(await check({ PAID_STANDARD_PROCESS_FEATURE_SLOTS: undefined })).toBe(false);
        expect(await check({ PAID_STANDARD_PROCESS_FEATURE_SLOTS: '40' })).toBe(false);
        expect(await check({ K_SERVICE: 'other' })).toBe(false);
        expect(await check({ DEV_LIVE_WORKLOAD: 'paid' })).toBe(false);
        expect(await check({}, 'ai-stage-policy-v2.12')).toBe(false);
        expect(await check({}, policy, { ...job, requestId: 'other' })).toBe(false);
        expect(await check({}, policy, { ...job, claimToken: 'other' })).toBe(false);
        expect(await check({}, policy, { ...job, jobKey: 'track:profile-ai:batch:1' })).toBe(false);
        expect(verify).not.toHaveBeenCalled();
        expect(await check({})).toBe(true);
        expect(verify).toHaveBeenCalledOnce();
    });

    it('grants the shared fourth feature slot only to an opted-in signed job and keeps an older eligible waiter first', async () => {
        const arbiter = new ProcessWideAnalysisV2SchedulerArbiter();
        const job = { requestId: 'fixture', jobKey: 'track:profile-ai:batch:0', claimToken: 'claim', aiStagePolicyVersion: 'ai-stage-policy-v2.11' };
        const env = { NODE_ENV: 'production', K_SERVICE: 'analysis-paid-worker', ANALYSIS_WORKLOAD_ROLE: 'paid',
            ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', PAID_STANDARD_VERTEX_CAPACITY_MODE: 'expanded128', PAID_STANDARD_PROCESS_FEATURE_SLOTS: '4' };
        const entered: string[] = [];
        const held = new Map<string, () => void>();
        const pending: Promise<unknown>[] = [];
        function start(key: string, signed = false, envValue = '4', fence = job) {
            const execute = () => runAnalysisV2FairAiScheduler({
                capability: 'scheduler-v1', policy: { featureAnalysisConcurrency: 99 },
                featureJob: fence, handlerDeadlineAtMs: 1_000_000, nowMs: () => 0, operationStore: operationStore(),
                tasks: [task(key, 'featureAnalysis', 0, vi.fn(async () => {
                    entered.push(key);
                    await new Promise<void>(resolve => held.set(key, resolve));
                    return key;
                }))],
            }, arbiter);
            pending.push(withPaidStandardCapacityJob(job, async () => signed, execute, { ...env, PAID_STANDARD_PROCESS_FEATURE_SLOTS: envValue }));
        }
        start('first'); start('second'); start('third');
        await vi.waitFor(() => expect(entered).toHaveLength(3));
        const forged = {};
        expect(arbiter.tryAcquire('featureAnalysis', { ...ANALYSIS_V2_SCHEDULER_V1_POLICY, featureAnalysisConcurrency: 99 }, forged).status).toBe('blocked');
        arbiter.cancel(forged);
        start('paid', true);
        await vi.waitFor(() => expect(entered).toHaveLength(4));
        expect(entered[3]).toBe('paid');
        start('older');
        // Let this waiter register before sending another signed wave.
        await new Promise<void>(resolve => setImmediate(resolve));
        start('paid-later', true); start('paid-next', true);
        start('off', true, '3'); start('invalid', true, '5');
        start('wrong-claim', true, '4', { ...job, claimToken: 'different' });
        start('old-policy', true, '4', { ...job, aiStagePolicyVersion: 'ai-stage-policy-v2.10' });
        held.get('paid')!();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(entered).toHaveLength(4);
        start('paid-new', true);
        held.get('first')!();
        await vi.waitFor(() => expect(entered).toContain('older'));
        expect(entered[4]).toBe('older');
        while (entered.length < pending.length) {
            const count = entered.length;
            for (const release of held.values()) release();
            await vi.waitFor(() => expect(entered.length).toBeGreaterThan(count));
        }
        for (const release of held.values()) release();
        await Promise.all(pending);
    });

    it.each(['claim', 'defer'] as const)('drains admitted siblings before continuing after a DB %s timeout', async operation => {
        const timeout = new AnalysisV2SchedulerContinuationError('ANALYSIS_V2_AI_CAPACITY_PENDING', 5);
        const store = operationStore();
        const claim = store.claim;
        const failureReached = vi.fn();
        const fail = async () => {
            failureReached();
            throw timeout;
        };
        if (operation === 'claim') {
            store.claim = vi.fn(input => input.key === 'waiting' ? fail() : claim(input));
        } else {
            store.defer = vi.fn(fail);
        }
        let release!: () => void;
        const receiving = new Promise<string>(resolve => { release = () => resolve('checkpointed'); });
        const sibling = vi.fn(() => receiving);
        const waiting = vi.fn(async () => { throw new DevLiveVertexBudgetReservationPendingError(); });
        const finished = vi.fn();
        const run = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [task('receiving', 'featureAnalysis', 0, sibling), task('waiting', 'featureAnalysis', 1, waiting)],
            operationStore: store, handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        }).catch(error => { finished(error); return error; });
        try {
            await vi.waitFor(() => expect(failureReached).toHaveBeenCalledOnce());
            expect(sibling).toHaveBeenCalledOnce();
            expect(finished).not.toHaveBeenCalled();
        } finally {
            release();
            await run;
        }
        expect(finished).toHaveBeenCalledWith(timeout);
        expect(store.commitReady).toHaveBeenCalledExactlyOnceWith({
            key: 'receiving', stage: 'featureAnalysis', claimToken: 'claim:receiving', value: 'checkpointed',
        });
    });

    it.each(['capacity', 'mixed fence', 'rollback', 'already deferred', 'failed defer', 'untrusted commit'] as const)(
        'marks only a durably deferred capacity-only scheduler turn for the 50s trial (%s)', async scenario => {
            vi.stubEnv('STANDARD_SHARED_RESOLVER_GRACE_MS', '50000');
            try {
                const states = new Map<string, 'claimed' | 'ready'>();
                if (scenario === 'already deferred') states.set('peer', 'claimed');
                const store = operationStore(states);
                const capacity = new Error('ANALYSIS_V2_AI_CAPACITY_PENDING');
                const timeout = new AnalysisV2SchedulerContinuationError('ANALYSIS_V2_AI_CAPACITY_PENDING', 5);
                let releasePeer!: () => void;
                const peerMayFinish = new Promise<void>(resolve => { releasePeer = resolve; });
                store.defer = vi.fn(async () => {
                    if (scenario === 'failed defer') throw timeout;
                    releasePeer();
                    return 5000;
                });
                if (scenario === 'untrusted commit') store.commitReady = vi.fn().mockRejectedValue(capacity);
                const tasks = [task('required', 'featureAnalysis', 0, vi.fn(async () => {
                    if (scenario === 'untrusted commit') return 'completed';
                    if (scenario === 'rollback') throw new DevLiveVertexBudgetReservationPendingError();
                    throw capacity;
                }))];
                if (scenario === 'mixed fence' || scenario === 'already deferred') {
                    tasks.unshift(task('peer', 'featureAnalysis', 0, vi.fn(async () => {
                        await peerMayFinish;
                        throw new Error('OPERATION_FENCE_MISMATCH');
                    })));
                }
                const run = runAnalysisV2FairAiScheduler({
                    capability: 'scheduler-v1', tasks, operationStore: store,
                    handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
                });
                if (scenario === 'failed defer') await expect(run).rejects.toBe(timeout);
                else if (scenario === 'mixed fence') await expect(run).rejects.toThrow('OPERATION_FENCE_MISMATCH');
                else await expect(run).rejects.toMatchObject({ reason: capacity.message,
                    confirmedCapacityOnly: scenario === 'capacity' });
                expect(store.defer).toHaveBeenCalledOnce();
            } finally {
                vi.unstubAllEnvs();
            }
        },
    );

    it('releases the operation fence only for a proven pre-dispatch budget rollback', async () => {
        const rollback = new DevLiveVertexBudgetReservationPendingError();
        const store = { ...operationStore(), defer: vi.fn().mockResolvedValue(5_000) };
        const execute = (error: Error) => runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [task('feature', 'featureAnalysis', 0, vi.fn().mockRejectedValue(error))],
            operationStore: store, handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        });
        await expect(execute(rollback)).rejects.toMatchObject({
            reason: 'ANALYSIS_V2_AI_CAPACITY_PENDING', notBeforeAtMs: 5_000,
        });
        expect(store.defer).toHaveBeenCalledWith({
            key: 'feature', stage: 'featureAnalysis', claimToken: 'claim:feature',
            reason: 'ANALYSIS_V2_AI_CAPACITY_PENDING',
        });
        store.claim = operationStore().claim;
        const unconfirmed = new Error(rollback.message);
        await expect(execute(unconfirmed)).rejects.toBe(unconfirmed);
        expect(store.defer).toHaveBeenCalledTimes(1);
        expect(store.commitReady).not.toHaveBeenCalled();
    });

    it.each(['success', 'hard error'] as const)('drains paid siblings after a temporary budget rejection (%s)', async outcome => {
        const pending = new VertexAiBudgetCapacityPendingError();
        const hard = new Error('VERTEX_AI_BUDGET_EXCEEDED:run');
        const store = { ...operationStore(), defer: vi.fn().mockResolvedValue(5_000) };
        let finish!: () => void;
        const receiving = new Promise<void>(resolve => { finish = resolve; });
        const sibling = vi.fn(async () => {
            await receiving;
            if (outcome === 'hard error') throw hard;
            return 'paid-checkpoint';
        });
        const done = vi.fn();
        const run = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', operationStore: store, handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
            tasks: [task('already-sent', 'featureAnalysis', 0, sibling),
                task('no-funds-yet', 'featureAnalysis', 1, vi.fn().mockRejectedValue(pending))],
        }).catch(done);
        try {
            await vi.waitFor(() => expect(store.defer).toHaveBeenCalledExactlyOnceWith({
                key: 'no-funds-yet', stage: 'featureAnalysis', claimToken: 'claim:no-funds-yet', reason: 'ANALYSIS_V2_AI_CAPACITY_PENDING',
            }));
            expect(done).not.toHaveBeenCalled();
        } finally {
            finish();
            await run;
        }
        expect(sibling).toHaveBeenCalledOnce();
        expect(done).toHaveBeenCalledExactlyOnceWith(outcome === 'success' ? pending : hard);
        expect(store.commitReady).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    });

    it.each(['budget first', 'deadline first', 'hard first'] as const)(
        'returns the first hard sibling error after all admitted work drains (%s)', async order => {
            const budget = new VertexAiBudgetCapacityPendingError();
            const deadline = new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
            const hard = new Error('VERTEX_AI_BUDGET_EXCEEDED:run');
            const fence = new Error('ANALYSIS_V2_AI_RESULT_FENCE_MISMATCH');
            const failures = order === 'budget first' ? [budget, deadline, fence, hard]
                : order === 'deadline first' ? [deadline, budget, hard, fence] : [hard, budget, deadline, fence];
            const reject: ((error: Error) => void)[] = [];
            const runs = failures.map(() => vi.fn(() => new Promise<string>((_, fail) => { reject.push(fail); })));
            const store = { ...operationStore(), defer: vi.fn().mockResolvedValue(5_000) };
            const done = vi.fn();
            const result = runAnalysisV2FairAiScheduler({
                capability: 'scheduler-v1', operationStore: store, handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
                tasks: runs.map((run, index) => task(String(index), 'genderTriage', index, run)),
            }).catch(done);
            await vi.waitFor(() => expect(reject).toHaveLength(4));
            for (const [index, error] of failures.entries()) {
                expect(done).not.toHaveBeenCalled();
                reject[index]!(error);
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            await result;
            expect(done).toHaveBeenCalledExactlyOnceWith(order === 'budget first' ? fence : hard);
            expect(store.defer).toHaveBeenCalledTimes(2);
            expect(store.commitReady).not.toHaveBeenCalled();
            runs.forEach(run => expect(run).toHaveBeenCalledOnce());
        },
    );

    it('is fail-closed outside the exact persisted scheduler capability', async () => {
        await expect(runAnalysisV2FairAiScheduler({
            capability: 'legacy',
            tasks: [],
            operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        })).rejects.toThrow('ANALYSIS_V2_SCHEDULER_NOT_ENABLED');
    });

    it('honours each stage cap and the process-wide cap while completing all work', async () => {
        let active = 0;
        let peak = 0;
        const stageActive = new Map<string, number>();
        const peakByStage = new Map<string, number>();
        const work = (stage: string, value: string) => vi.fn(async () => {
            active++;
            peak = Math.max(peak, active);
            const count = (stageActive.get(stage) ?? 0) + 1;
            stageActive.set(stage, count);
            peakByStage.set(stage, Math.max(peakByStage.get(stage) ?? 0, count));
            await Promise.resolve();
            active--;
            stageActive.set(stage, stageActive.get(stage)! - 1);
            return value;
        });
        const tasks = [
            ...Array.from({ length: 8 }, (_, index) => task(`g${index}`, 'genderTriage', index, work('genderTriage', `g${index}`))),
            ...Array.from({ length: 5 }, (_, index) => task(`f${index}`, 'featureAnalysis', 20 + index, work('featureAnalysis', `f${index}`))),
            ...Array.from({ length: 4 }, (_, index) => task(`p${index}`, 'privateAccountName', 30 + index, work('privateAccountName', `p${index}`))),
        ];
        const promise = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks, operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        });
        const result = await promise;
        expect(result.status).toBe('completed');
        expect(peak).toBeLessThanOrEqual(ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency);
        expect(peakByStage.get('genderTriage')).toBeLessThanOrEqual(6);
        expect(peakByStage.get('featureAnalysis')).toBeLessThanOrEqual(3);
        expect(peakByStage.get('privateAccountName')).toBeLessThanOrEqual(2);
    });

    it('enforces hard caps across two concurrent scheduler invocations and clamps overrides', async () => {
        let active = 0;
        let peak = 0;
        const activeByStage = new Map<string, number>();
        const peakByStage = new Map<string, number>();
        const releases: Array<() => void> = [];
        const work = (stage: string, value: string) => vi.fn(async () => {
            active++;
            peak = Math.max(peak, active);
            const stageCount = (activeByStage.get(stage) ?? 0) + 1;
            activeByStage.set(stage, stageCount);
            peakByStage.set(stage, Math.max(peakByStage.get(stage) ?? 0, stageCount));
            await new Promise<void>(resolve => releases.push(resolve));
            active--;
            activeByStage.set(stage, activeByStage.get(stage)! - 1);
            return value;
        });
        const makeTasks = (prefix: string) => [
            ...Array.from({ length: 8 }, (_, index) => task(
                `${prefix}:g${index}`, 'genderTriage', index,
                work('genderTriage', `${prefix}:g${index}`),
            )),
            ...Array.from({ length: 5 }, (_, index) => task(
                `${prefix}:f${index}`, 'featureAnalysis', 20 + index,
                work('featureAnalysis', `${prefix}:f${index}`),
            )),
            ...Array.from({ length: 4 }, (_, index) => task(
                `${prefix}:p${index}`, 'privateAccountName', 30 + index,
                work('privateAccountName', `${prefix}:p${index}`),
            )),
        ];
        const unsafeOverride = {
            sharedConcurrency: 99,
            genderTriageConcurrency: 99,
            featureAnalysisConcurrency: 99,
            privateAccountNameConcurrency: 99,
            admissionReserveMs: 1,
        };
        let settled = false;
        const executions = Promise.all([
            runAnalysisV2FairAiScheduler({
                capability: 'scheduler-v1',
                tasks: makeTasks('a'),
                operationStore: operationStore(),
                handlerDeadlineAtMs: 1_000_000,
                nowMs: () => 0,
                policy: unsafeOverride,
            }),
            runAnalysisV2FairAiScheduler({
                capability: 'scheduler-v1',
                tasks: makeTasks('b'),
                operationStore: operationStore(),
                handlerDeadlineAtMs: 1_000_000,
                nowMs: () => 0,
                policy: unsafeOverride,
            }),
        ]).finally(() => { settled = true; });
        for (let turn = 0; !settled && turn < 200; turn++) {
            if (releases.length > 0) releases.splice(0).forEach(release => release());
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        await executions;
        expect(peak).toBeLessThanOrEqual(8);
        expect(peakByStage.get('genderTriage')).toBeLessThanOrEqual(6);
        expect(peakByStage.get('featureAnalysis')).toBeLessThanOrEqual(3);
        expect(peakByStage.get('privateAccountName')).toBeLessThanOrEqual(2);
    });

    it('returns continuation at admission cutoff while all process slots remain held', async () => {
        const releases: Array<() => void> = [];
        const held = (value: string) => vi.fn(async () => {
            await new Promise<void>(resolve => releases.push(resolve));
            return value;
        });
        const blockers = [
            ...Array.from({ length: 6 }, (_, index) => task(
                `held:g${index}`, 'genderTriage', index, held(`held:g${index}`),
            )),
            ...Array.from({ length: 2 }, (_, index) => task(
                `held:p${index}`, 'privateAccountName', 20 + index, held(`held:p${index}`),
            )),
        ];
        const blockerExecution = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: blockers,
            operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        });
        await vi.waitFor(() => expect(releases).toHaveLength(8));

        const startedAt = performance.now();
        const waitingPaidCall = vi.fn(async () => 'waiting');
        const waitingResult = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [task('waiting', 'featureAnalysis', 0, waitingPaidCall)],
            operationStore: operationStore(),
            handlerDeadlineAtMs: 225_050,
            nowMs: () => performance.now() - startedAt,
        });
        const elapsedMs = performance.now() - startedAt;
        expect(waitingResult).toMatchObject({
            status: 'continuation',
            remainingKeys: ['waiting'],
        });
        expect(waitingPaidCall).not.toHaveBeenCalled();
        expect(elapsedMs).toBeGreaterThanOrEqual(30);
        expect(elapsedMs).toBeLessThan(250);

        releases.splice(0).forEach(release => release());
        await expect(blockerExecution).resolves.toMatchObject({ status: 'completed' });
    });

    it('does not lose a release between failed acquisition and waiter registration', async () => {
        const releases: Array<() => void> = [];
        const held = (value: string) => vi.fn(async () => {
            await new Promise<void>(resolve => releases.push(resolve));
            return value;
        });
        const blockers = [
            ...Array.from({ length: 6 }, (_, index) => task(
                `race:g${index}`, 'genderTriage', index, held(`race:g${index}`),
            )),
            ...Array.from({ length: 2 }, (_, index) => task(
                `race:p${index}`, 'privateAccountName', 20 + index, held(`race:p${index}`),
            )),
        ];
        const blockerExecution = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: blockers,
            operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        });
        await vi.waitFor(() => expect(releases).toHaveLength(8));

        const beforeWait = vi.fn(() => {
            releases.splice(0).forEach(release => release());
        });
        const paidCall = vi.fn(async () => 'recovered-slot');
        const startedAt = performance.now();
        const result = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [task('race:waiting', 'featureAnalysis', 0, paidCall)],
            operationStore: operationStore(),
            handlerDeadlineAtMs: 225_500,
            nowMs: () => performance.now() - startedAt,
            onBeforeArbiterWait: beforeWait,
        });
        expect(result).toMatchObject({
            status: 'completed',
            completed: [{ key: 'race:waiting', value: 'recovered-slot' }],
        });
        expect(paidCall).toHaveBeenCalledOnce();
        expect(beforeWait).toHaveBeenCalledOnce();
        expect(performance.now() - startedAt).toBeLessThan(250);
        await expect(blockerExecution).resolves.toMatchObject({ status: 'completed' });
    });

    it('round-robins ready stages so feature work is not starved by triage', async () => {
        const started: string[] = [];
        const tasks = [
            ...Array.from({ length: 8 }, (_, index) => task(`g${index}`, 'genderTriage', index,
                vi.fn(async () => { started.push(`g${index}`); return `g${index}`; }))),
            ...Array.from({ length: 3 }, (_, index) => task(`f${index}`, 'featureAnalysis', 20 + index,
                vi.fn(async () => { started.push(`f${index}`); return `f${index}`; }))),
        ];
        await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks, operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        });
        expect(started.slice(0, 6)).toEqual(['g0', 'f0', 'g1', 'f1', 'g2', 'f2']);
    });

    it('fairly arbitrates stages across concurrent scheduler invocations', async () => {
        const releases = new Map<string, () => void>();
        const held = (key: string) => vi.fn(async () => {
            await new Promise<void>(resolve => releases.set(key, resolve));
            return key;
        });
        const blockers = [
            ...Array.from({ length: 6 }, (_, index) => task(
                `fair-held:g${index}`,
                'genderTriage',
                index,
                held(`g${index}`),
            )),
            ...Array.from({ length: 2 }, (_, index) => task(
                `fair-held:p${index}`,
                'privateAccountName',
                20 + index,
                held(`p${index}`),
            )),
        ];
        const blockerExecution = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: blockers,
            operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        });
        await vi.waitFor(() => expect(releases.size).toBe(8));

        const started: string[] = [];
        const waiting = (
            key: string,
            stage: AnalysisV2SchedulerTask<string>['stage'],
        ) => runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [task(key, stage, 0, vi.fn(async () => {
                started.push(key);
                return key;
            }))],
            operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        });
        const feature = waiting('fair-feature', 'featureAnalysis');
        await Promise.resolve();
        const privateName = waiting('fair-private', 'privateAccountName');
        await Promise.resolve();
        const gender = waiting('fair-gender', 'genderTriage');
        await Promise.resolve();

        try {
            releases.get('g0')!();
            await vi.waitFor(() => expect(started[0]).toBe('fair-feature'));
            releases.get('p0')!();
            await vi.waitFor(() => expect(started).toContain('fair-private'));
            expect(started.indexOf('fair-feature')).toBeLessThan(
                started.indexOf('fair-gender'),
            );
            await Promise.all([feature, privateName, gender]);
        } finally {
            [...releases.entries()]
                .filter(([key]) => !['g0', 'p0'].includes(key))
                .forEach(([, release]) => release());
            await blockerExecution;
        }
    });

    it('returns a successful continuation before the admission reserve and resumes without repeating committed work', async () => {
        let now = 0;
        const store = operationStore();
        const first = task('first', 'genderTriage', 0);
        const second = task('second', 'featureAnalysis', 1);
        const initial = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks: [first, second], operationStore: store,
            handlerDeadlineAtMs: 225_000, nowMs: () => now,
        });
        expect(initial).toMatchObject({ status: 'continuation', remainingKeys: ['first', 'second'] });
        expect(first.run).not.toHaveBeenCalled();
        now = 0;
        const resumed = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks: [first, second], operationStore: store,
            handlerDeadlineAtMs: 1_000_000, nowMs: () => now,
        });
        expect(resumed.status).toBe('completed');
        expect(first.run).toHaveBeenCalledOnce();
        expect(second.run).toHaveBeenCalledOnce();
        const replay = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks: [first, second], operationStore: store,
            handlerDeadlineAtMs: 1_000_000, nowMs: () => now,
        });
        expect(replay.status).toBe('completed');
        expect(replay.completed.map(row => row.key)).toEqual(['first', 'second']);
        expect(first.run).toHaveBeenCalledOnce();
        expect(second.run).toHaveBeenCalledOnce();
    });

    it('fails closed after a provider response precedes a lost result commit', async () => {
        const states = new Map<string, 'claimed' | 'ready'>();
        const store = operationStore(states);
        vi.mocked(store.commitReady).mockRejectedValueOnce(new Error('COMMIT_RESPONSE_LOST'));
        const paidCall = vi.fn(async () => 'provider-response');
        const paidTask = task('paid', 'featureAnalysis', 0, paidCall);

        await expect(runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [paidTask],
            operationStore: store,
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        })).rejects.toThrow('COMMIT_RESPONSE_LOST');
        expect(states.get('paid')).toBe('claimed');
        expect(paidCall).toHaveBeenCalledOnce();

        await expect(runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [paidTask],
            operationStore: store,
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        })).resolves.toMatchObject({
            status: 'continuation',
            remainingKeys: ['paid'],
            recoveryPendingKeys: ['paid'],
        });
        expect(paidCall).toHaveBeenCalledOnce();
    });

    it('uses only checkpoint recovery when the durable claim proves a result exists', async () => {
        const run = vi.fn(async () => 'paid');
        const recover = vi.fn(async () => 'checkpoint');
        const commitReady = vi.fn();
        const result = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [{
                ...task('recoverable', 'genderTriage', 0, run),
                recover,
            }],
            operationStore: {
                claim: vi.fn(async () => ({
                    decision: 'execute' as const,
                    claimToken: 'recovery-claim',
                    recoveryOnly: true,
                })),
                commitReady,
            },
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        });

        expect(result).toMatchObject({
            status: 'completed',
            completed: [{ key: 'recoverable', value: 'checkpoint' }],
        });
        expect(run).not.toHaveBeenCalled();
        expect(recover).toHaveBeenCalledOnce();
        expect(commitReady).toHaveBeenCalledWith(expect.objectContaining({
            claimToken: 'recovery-claim',
            value: 'checkpoint',
        }));
    });

    it('keeps returned output in topology order even when provider completion is inverted', async () => {
        const releases: Array<() => void> = [];
        const delayed = (value: string) => vi.fn(async () => {
            await new Promise<void>(resolve => releases.push(resolve));
            return value;
        });
        const tasks = [
            task('a', 'genderTriage', 0, delayed('a')),
            task('b', 'featureAnalysis', 1, delayed('b')),
        ];
        const promise = runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks, operationStore: operationStore(),
            handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        });
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases[1]!();
        await Promise.resolve();
        releases[0]!();
        await expect(promise).resolves.toMatchObject({
            completed: [{ key: 'a' }, { key: 'b' }],
        });
    });

    it('isolates a terminal-unavailable fallback from healthy sibling operations', async () => {
        const healthy = task('healthy', 'genderTriage', 0);
        const unavailable = {
            ...task('unavailable', 'featureAnalysis', 1),
            terminalFallback: vi.fn(async () => {
                throw new AnalysisV2AiTerminalUnavailableError();
            }),
        };
        const result = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1',
            tasks: [healthy, unavailable],
            operationStore: {
                claim: vi.fn(async ({ key }) => key === 'unavailable'
                    ? {
                        decision: 'execute' as const,
                        claimToken: 'terminal-claim',
                        terminalUnavailable: true,
                    }
                    : {
                        decision: 'execute' as const,
                        claimToken: 'healthy-claim',
                    }),
                commitReady: vi.fn(),
            },
            handlerDeadlineAtMs: 1_000_000,
            nowMs: () => 0,
        });

        expect(result).toMatchObject({
            status: 'completed',
            completed: [{ key: 'healthy', value: 'healthy' }],
            terminalUnavailableKeys: ['unavailable'],
        });
        expect(unavailable.run).not.toHaveBeenCalled();
        expect(unavailable.terminalFallback).toHaveBeenCalledOnce();
    });
});
