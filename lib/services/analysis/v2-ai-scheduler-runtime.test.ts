import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_SCHEDULER_V1_POLICY,
    runAnalysisV2FairAiScheduler,
    type AnalysisV2SchedulerTask,
} from './v2-ai-scheduler-runtime';

function checkpoint(committed = new Set<string>()) {
    return {
        hasCommitted: vi.fn(async (key: string) => committed.has(key)),
        commit: vi.fn(async ({ key }: { key: string }) => { committed.add(key); }),
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
            checkpoint: checkpoint(),
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
            capability: 'scheduler-v1', tasks, checkpoint: checkpoint(),
            handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        });
        const result = await promise;
        expect(result.status).toBe('completed');
        expect(peak).toBeLessThanOrEqual(ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency);
        expect(peakByStage.get('genderTriage')).toBeLessThanOrEqual(6);
        expect(peakByStage.get('featureAnalysis')).toBeLessThanOrEqual(3);
        expect(peakByStage.get('privateAccountName')).toBeLessThanOrEqual(2);
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
            capability: 'scheduler-v1', tasks, checkpoint: checkpoint(),
            handlerDeadlineAtMs: 1_000_000, nowMs: () => 0,
        });
        expect(started.slice(0, 6)).toEqual(['g0', 'f0', 'g1', 'f1', 'g2', 'f2']);
    });

    it('returns a successful continuation before the admission reserve and resumes without repeating committed work', async () => {
        let now = 0;
        const committed = new Set<string>();
        const store = checkpoint(committed);
        const first = task('first', 'genderTriage', 0);
        const second = task('second', 'featureAnalysis', 1);
        const initial = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks: [first, second], checkpoint: store,
            handlerDeadlineAtMs: 75_000, nowMs: () => now,
        });
        expect(initial).toMatchObject({ status: 'continuation', remainingKeys: ['first', 'second'] });
        expect(first.run).not.toHaveBeenCalled();
        now = 0;
        const resumed = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks: [first, second], checkpoint: store,
            handlerDeadlineAtMs: 1_000_000, nowMs: () => now,
        });
        expect(resumed.status).toBe('completed');
        expect(first.run).toHaveBeenCalledOnce();
        expect(second.run).toHaveBeenCalledOnce();
        const replay = await runAnalysisV2FairAiScheduler({
            capability: 'scheduler-v1', tasks: [first, second], checkpoint: store,
            handlerDeadlineAtMs: 1_000_000, nowMs: () => now,
        });
        expect(replay.status).toBe('completed');
        expect(first.run).toHaveBeenCalledOnce();
        expect(second.run).toHaveBeenCalledOnce();
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
            capability: 'scheduler-v1', tasks, checkpoint: checkpoint(),
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
