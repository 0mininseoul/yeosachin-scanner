import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createProgressDisplayState,
    pauseProgressDisplay,
    updateProgressDisplay,
    type ProgressDisplayInput,
} from './v2-progress-display';

function input(overrides: Partial<ProgressDisplayInput> = {}): ProgressDisplayInput {
    return {
        confirmedProgressBp: 4_500,
        nextCheckpointBp: 5_000,
        status: 'processing',
        nowMs: 0,
        visible: true,
        signalKey: 'profile:1:30:fetching',
        ...overrides,
    };
}

describe('V2 progress display easing', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('moves during a long visible plateau but decelerates before the next checkpoint', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({ nowMs: Date.now() }),
        );
        vi.advanceTimersByTime(5_000);
        const first = updateProgressDisplay(initial, input({ nowMs: Date.now() }));
        vi.advanceTimersByTime(5_000);
        const second = updateProgressDisplay(first, input({ nowMs: Date.now() }));
        const cap = 4_999;

        expect(first.displayProgressBp).toBeGreaterThan(initial.displayProgressBp);
        expect(second.displayProgressBp).toBeGreaterThan(first.displayProgressBp);
        expect(second.displayProgressBp - first.displayProgressBp)
            .toBeLessThan(first.displayProgressBp - initial.displayProgressBp);
        expect(second.displayProgressBp).toBeLessThanOrEqual(cap);
    });

    it('never reaches a non-terminal next checkpoint cap even after an extreme delay', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({ nowMs: Date.now() }),
        );
        vi.advanceTimersByTime(86_400_000);
        const delayed = updateProgressDisplay(initial, input({ nowMs: Date.now() }));

        expect(delayed.displayProgressBp).toBeLessThan(5_000);
        expect(delayed.displayProgressBp).toBeLessThanOrEqual(4_999);
    });

    it('keeps malformed pre-terminal input below completion as a final display guard', () => {
        const display = updateProgressDisplay(
            createProgressDisplayState(),
            input({ confirmedProgressBp: 10_000, nextCheckpointBp: undefined }),
        );

        expect(display.displayProgressBp).toBeLessThan(10_000);
        expect(display.capProgressBp).toBeLessThan(10_000);
    });

    it('pauses hidden time so visibility restore does not create a fake jump', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({ nowMs: Date.now() }),
        );
        vi.advanceTimersByTime(2_000);
        const beforeHidden = updateProgressDisplay(initial, input({ nowMs: Date.now() }));
        const paused = pauseProgressDisplay(beforeHidden, Date.now());
        vi.advanceTimersByTime(58_000);
        const restored = updateProgressDisplay(paused, input({ nowMs: Date.now() }));

        expect(restored.displayProgressBp).toBe(paused.displayProgressBp);
        vi.advanceTimersByTime(1_000);
        const resumed = updateProgressDisplay(restored, input({ nowMs: Date.now() }));
        expect(resumed.displayProgressBp).toBeGreaterThan(restored.displayProgressBp);
    });

    it('raises the display to a newer durable checkpoint without regressing', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({ nowMs: Date.now() }),
        );
        vi.advanceTimersByTime(1_000);
        const jumped = updateProgressDisplay(initial, input({
            confirmedProgressBp: 6_200,
            nextCheckpointBp: 6_800,
            nowMs: Date.now(),
            signalKey: 'profile:2:30:fetching',
        }));

        expect(jumped.displayProgressBp).toBeGreaterThanOrEqual(6_200);
        expect(jumped.displayProgressBp).toBeGreaterThanOrEqual(initial.displayProgressBp);
        expect(jumped.targetProgressBp).toBeGreaterThan(jumped.displayProgressBp);
    });

    it('only reaches 100 percent on durable terminal completion and freezes failures', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({ nowMs: Date.now() }),
        );
        vi.advanceTimersByTime(30_000);
        const failed = updateProgressDisplay(initial, input({
            status: 'failed',
            confirmedProgressBp: 4_600,
            nextCheckpointBp: undefined,
            nowMs: Date.now(),
        }));
        vi.advanceTimersByTime(1_000);
        const completed = updateProgressDisplay(failed, input({
            status: 'completed',
            confirmedProgressBp: 10_000,
            nextCheckpointBp: undefined,
            nowMs: Date.now(),
        }));

        expect(failed.displayProgressBp).toBeLessThan(10_000);
        expect(completed.displayProgressBp).toBe(10_000);
        expect(completed.targetProgressBp).toBe(10_000);
    });
});
