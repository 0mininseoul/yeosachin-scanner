import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createProgressDisplayState,
    activeProgressTrackId,
    pauseProgressDisplay,
    nextProgressCheckpointBp,
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

    it('keeps initial basic-plan motion at 0 percent while bounded below its first checkpoint', () => {
        const tracks = {
            relationshipAi: {
                state: 'running' as const,
                done: 0,
                total: 24,
                stageCode: 'RELATIONSHIPS_COLLECTING',
            },
            interactions: {
                state: 'pending' as const,
                done: 0,
                total: 2,
                stageCode: 'INTERACTIONS_QUEUED',
            },
            finalization: {
                state: 'pending' as const,
                done: 0,
                total: 3,
                stageCode: 'FINALIZATION_QUEUED',
            },
        };
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 300,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'RELATIONSHIPS_COLLECTING',
                nowMs: 0,
            }),
        );
        const moving = updateProgressDisplay(initial, input({
            confirmedProgressBp: 0,
            nextCheckpointBp: 300,
            tracks,
            activeTrackId: 'relationshipAi',
            activeStageCode: 'RELATIONSHIPS_COLLECTING',
            nowMs: 1_000,
        }));

        expect(initial.displayProgressBp).toBe(0);
        expect(moving.displayProgressBp).toBeGreaterThan(initial.displayProgressBp);
        expect(moving.displayProgressBp).toBeLessThan(100);
        expect(moving.capProgressBp).toBeLessThan(300);
    });

    it('selects the actual active stage instead of the earliest previously-running track', () => {
        const tracks = {
            relationshipAi: {
                state: 'running' as const,
                done: 0,
                total: 100,
                stageCode: 'RELATIONSHIP_AI_RUNNING',
            },
            interactions: {
                state: 'running' as const,
                done: 0,
                total: 1,
                stageCode: 'TARGET_INTERACTIONS_COLLECTING',
            },
            finalization: {
                state: 'pending' as const,
                done: 0,
                total: 1,
                stageCode: 'FINALIZATION_QUEUED',
            },
        };

        expect(activeProgressTrackId(tracks)).toBe('interactions');
    });

    it('uses the sole running track for its next durable checkpoint', () => {
        const tracks = {
            relationshipAi: {
                state: 'pending' as const,
                done: 0,
                total: 100,
                stageCode: 'RELATIONSHIP_AI_QUEUED',
            },
            interactions: {
                state: 'running' as const,
                done: 0,
                total: 1,
                stageCode: 'TARGET_INTERACTIONS_COLLECTING',
            },
            finalization: {
                state: 'pending' as const,
                done: 0,
                total: 1,
                stageCode: 'FINALIZATION_QUEUED',
            },
        };

        expect(nextProgressCheckpointBp(tracks)).toBe(1_700);
    });

    it('guards reverse likes below a hidden partner safety checkpoint across running tracks', () => {
        const tracks = {
            relationshipAi: {
                state: 'running' as const,
                done: 23,
                total: 24,
                stageCode: 'RELATIONSHIP_AI_RUNNING',
            },
            interactions: {
                state: 'running' as const,
                done: 1,
                total: 2,
                stageCode: 'SHORTLIST_INTERACTIONS_COLLECTING',
            },
            finalization: {
                state: 'pending' as const,
                done: 0,
                total: 3,
                stageCode: 'FINALIZATION_QUEUED',
            },
        };
        const safeCheckpointBp = nextProgressCheckpointBp(tracks);
        const display = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 7_750,
                nextCheckpointBp: safeCheckpointBp,
                tracks,
                activeTrackId: 'interactions',
                activeStageCode: 'SHORTLIST_INTERACTIONS_COLLECTING',
                nowMs: 0,
            }),
        );

        expect(activeProgressTrackId(tracks)).toBe('interactions');
        expect(safeCheckpointBp).toBe(8_050);
        expect(display.capProgressBp).toBe(8_049);
        expect(display.targetProgressBp).toBe(8_049);
        expect(display.targetProgressBp).toBeLessThan(safeCheckpointBp!);
    });

    it('uses ordinal and call phase to raise a bounded provisional sub-checkpoint', () => {
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 1,
                totalCount: 30,
                callPhase: 'fetching',
                tracks: {
                    relationshipAi: {
                        state: 'running',
                        done: 0,
                        total: 1,
                    },
                    interactions: {
                        state: 'pending',
                        done: 0,
                        total: 1,
                    },
                    finalization: {
                        state: 'pending',
                        done: 0,
                        total: 1,
                    },
                },
                nowMs: 0,
            }),
        );
        const later = updateProgressDisplay(
            initial,
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 20,
                totalCount: 30,
                callPhase: 'analyzing',
                signalKey: 'profile:20:30:analyzing',
                tracks: {
                    relationshipAi: {
                        state: 'running',
                        done: 0,
                        total: 1,
                    },
                    interactions: {
                        state: 'pending',
                        done: 0,
                        total: 1,
                    },
                    finalization: {
                        state: 'pending',
                        done: 0,
                        total: 1,
                    },
                },
                nowMs: 0,
            }),
        );

        expect(later.provisionalTargetProgressBp).toBeGreaterThan(
            initial.provisionalTargetProgressBp
        );
        expect(later.targetProgressBp).toBeGreaterThan(initial.targetProgressBp);
        expect(initial.targetProgressBp).toBe(initial.provisionalTargetProgressBp);
        expect(later.targetProgressBp).toBe(later.provisionalTargetProgressBp);
        expect(later.displayProgressBp).toBe(initial.displayProgressBp);
        const eased = updateProgressDisplay(later, input({
            confirmedProgressBp: 0,
            nextCheckpointBp: 7_200,
            activeTrackId: 'relationshipAi',
            activeStageCode: 'PROFILE_SCREENING',
            currentOrdinal: 20,
            totalCount: 30,
            callPhase: 'analyzing',
            signalKey: 'profile:20:30:analyzing',
            tracks: {
                relationshipAi: {
                    state: 'running',
                    done: 0,
                    total: 1,
                },
                interactions: {
                    state: 'pending',
                    done: 0,
                    total: 1,
                },
                finalization: {
                    state: 'pending',
                    done: 0,
                    total: 1,
                },
            },
            nowMs: 1_000,
        }));
        expect(eased.displayProgressBp).toBeGreaterThan(later.displayProgressBp);
        expect(later.capProgressBp).toBeLessThan(7_200);
    });

    it('reanchors changed non-durable signals without a same-now display jump', () => {
        const tracks = {
            relationshipAi: { state: 'running' as const, done: 0, total: 1 },
            interactions: { state: 'pending' as const, done: 0, total: 1 },
            finalization: { state: 'pending' as const, done: 0, total: 1 },
        };
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 1,
                totalCount: 30,
                callPhase: 'fetching',
                nowMs: 0,
            }),
        );
        const changed = updateProgressDisplay(
            initial,
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 20,
                totalCount: 30,
                callPhase: 'analyzing',
                signalKey: 'profile:20:30:analyzing',
                nowMs: 0,
            }),
        );
        const eased = updateProgressDisplay(changed, {
            ...input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 20,
                totalCount: 30,
                callPhase: 'analyzing',
                signalKey: 'profile:20:30:analyzing',
                nowMs: 1_000,
            }),
        });

        expect(changed.displayProgressBp).toBe(initial.displayProgressBp);
        expect(changed.provisionalTargetProgressBp)
            .toBeGreaterThan(initial.provisionalTargetProgressBp);
        expect(changed.targetProgressBp).toBeGreaterThan(initial.targetProgressBp);
        expect(changed.targetProgressBp).toBe(changed.provisionalTargetProgressBp);
        expect(eased.displayProgressBp).toBeGreaterThan(changed.displayProgressBp);
        expect(eased.displayProgressBp).toBeLessThan(eased.capProgressBp);
    });

    it('makes each profile call phase a distinct bounded sub-checkpoint', () => {
        const tracks = {
            relationshipAi: { state: 'running' as const, done: 0, total: 1 },
            interactions: { state: 'pending' as const, done: 0, total: 1 },
            finalization: { state: 'pending' as const, done: 0, total: 1 },
        };
        const targets = (['fetching', 'analyzing', 'persisting'] as const).map(callPhase => (
            updateProgressDisplay(
                createProgressDisplayState(),
                input({
                    confirmedProgressBp: 0,
                    nextCheckpointBp: 7_200,
                    tracks,
                    activeTrackId: 'relationshipAi',
                    activeStageCode: 'PROFILE_SCREENING',
                    currentOrdinal: 1,
                    totalCount: 30,
                    callPhase,
                }),
            ).provisionalTargetProgressBp
        ));

        expect(targets[0]).toBeLessThan(targets[1]!);
        expect(targets[1]).toBeLessThan(targets[2]!);
    });

    it('does not regress or overshoot when a provisional denominator expands', () => {
        const tracks = {
            relationshipAi: { state: 'running' as const, done: 0, total: 1 },
            interactions: { state: 'pending' as const, done: 0, total: 1 },
            finalization: { state: 'pending' as const, done: 0, total: 1 },
        };
        const earlier = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 9,
                totalCount: 10,
                callPhase: 'analyzing',
            }),
        );
        const expanded = updateProgressDisplay(
            earlier,
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 7_200,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'PROFILE_SCREENING',
                currentOrdinal: 9,
                totalCount: 30,
                callPhase: 'analyzing',
            }),
        );

        expect(expanded.displayProgressBp).toBeGreaterThanOrEqual(earlier.displayProgressBp);
        expect(expanded.provisionalTargetProgressBp).toBeLessThan(7_200);
        expect(expanded.targetProgressBp).toBeGreaterThanOrEqual(expanded.displayProgressBp);
        expect(expanded.displayProgressBp).toBeLessThan(7_200);
    });

    it('uses the conservative cap for a generic long stage without structured signals', () => {
        const tracks = {
            relationshipAi: {
                state: 'running' as const,
                done: 0,
                total: 10,
                stageCode: 'RELATIONSHIPS_COLLECTING',
            },
            interactions: {
                state: 'pending' as const,
                done: 0,
                total: 2,
                stageCode: 'INTERACTIONS_QUEUED',
            },
            finalization: {
                state: 'pending' as const,
                done: 0,
                total: 3,
                stageCode: 'FINALIZATION_QUEUED',
            },
        };
        const initial = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 0,
                nextCheckpointBp: 1_700,
                tracks,
                activeTrackId: 'relationshipAi',
                activeStageCode: 'RELATIONSHIPS_COLLECTING',
                nowMs: 0,
            }),
        );
        const later = updateProgressDisplay(initial, input({
            confirmedProgressBp: 0,
            nextCheckpointBp: 1_700,
            tracks,
            activeTrackId: 'relationshipAi',
            activeStageCode: 'RELATIONSHIPS_COLLECTING',
            nowMs: 5_000,
        }));

        expect(initial.targetProgressBp).toBe(initial.capProgressBp);
        expect(later.targetProgressBp).toBe(later.capProgressBp);
        expect(later.displayProgressBp).toBeGreaterThan(initial.displayProgressBp);
        expect(later.displayProgressBp).toBeLessThan(1_700);
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
        expect(delayed.targetProgressBp).toBeLessThanOrEqual(4_999);
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

    it('preserves displayed progress while publication lag resets transient easing state', () => {
        const high = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                confirmedProgressBp: 9_900,
                nextCheckpointBp: 9_999,
                nowMs: 0,
            }),
        );
        const ordinaryQueued = updateProgressDisplay(high, input({
            status: 'queued',
            confirmedProgressBp: 0,
            nextCheckpointBp: undefined,
            nowMs: 100,
            signalKey: 'ordinary-queued',
        }));
        expect(ordinaryQueued.displayProgressBp).toBe(high.displayProgressBp);

        const reset = updateProgressDisplay(high, input({
            status: 'queued',
            confirmedProgressBp: 0,
            nextCheckpointBp: undefined,
            nowMs: 200,
            signalKey: 'publication-lag-reset',
            publicationLagReset: true,
        }));
        expect(high.displayProgressBp).toBe(9_900);
        expect(reset.displayProgressBp).toBe(high.displayProgressBp);
        expect(reset.displayProgressBp).toBeLessThan(10_000);
        expect(reset.targetProgressBp).toBe(reset.displayProgressBp);
        expect(reset.capProgressBp).toBe(reset.displayProgressBp);
        expect(reset.confirmedProgressBp).toBe(0);
        expect(reset.easingStartedAtMs).toBe(200);
        expect(reset.easingStartProgressBp).toBe(reset.displayProgressBp);
        expect(reset.provisionalTargetProgressBp).toBe(reset.displayProgressBp);
        expect(reset.easingRate).toBe(1);
        expect(reset.lastNowMs).toBe(200);

        const emptyReset = updateProgressDisplay(
            createProgressDisplayState(),
            input({
                status: 'queued',
                confirmedProgressBp: 0,
                nextCheckpointBp: undefined,
                nowMs: 200,
                signalKey: 'publication-lag-reset-without-progress',
                publicationLagReset: true,
            }),
        );
        expect(emptyReset.displayProgressBp).toBe(0);

        const resumed = updateProgressDisplay(reset, input({
            confirmedProgressBp: 100,
            nextCheckpointBp: 300,
            nowMs: 300,
            signalKey: 'resumed-processing',
        }));
        expect(resumed.displayProgressBp).toBe(reset.displayProgressBp);
        expect(resumed.displayProgressBp).toBeLessThan(10_000);

        const completed = updateProgressDisplay(resumed, input({
            status: 'completed',
            confirmedProgressBp: 10_000,
            nextCheckpointBp: undefined,
            nowMs: 400,
            signalKey: 'published-completion',
        }));
        expect(completed.displayProgressBp).toBe(10_000);
        expect(completed.targetProgressBp).toBe(10_000);
    });
});
