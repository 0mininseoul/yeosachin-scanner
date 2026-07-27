import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_SCHEDULER_V1_POLICY,
    runAnalysisV2FairAiScheduler,
    type AnalysisV2SchedulerOperationStore,
    type AnalysisV2SchedulerTask,
} from './v2-ai-scheduler-runtime';

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
});
