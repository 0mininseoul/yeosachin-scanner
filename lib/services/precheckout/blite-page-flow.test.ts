import { describe, expect, it } from 'vitest';
import {
    initialBlitePageState,
    reduceBlitePage,
    type BlitePageState,
} from './blite-page-flow';

function pendingState(submittedAtMs = 1_700_000_000_000): BlitePageState {
    return {
        view: 'blite_pending',
        pathLatch: null,
        submittedAtMs,
        demoStartedAtMs: null,
        demoStatus: 'idle',
    };
}

describe('reduceBlitePage', () => {
    it('moves an eligible pending request to normal-ready exactly once', () => {
        const ready = reduceBlitePage(pendingState(), {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_047_999,
        });

        expect(ready).toEqual({
            view: 'blite_ready',
            pathLatch: 'normal',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: null,
            demoStatus: 'idle',
        });
        expect(reduceBlitePage(ready, {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_048_000,
        })).toBe(ready);
    });

    it('latches an early terminal failure immediately and records its demo start', () => {
        expect(reduceBlitePage(pendingState(), {
            type: 'BLITE_FAILED',
            atMs: 1_700_000_017_250,
        })).toEqual({
            view: 'fallback_demo',
            pathLatch: 'fallback',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_017_250,
            demoStatus: 'running',
        });
    });

    it('latches unresolved pending work once at T+48', () => {
        const fallback = reduceBlitePage(pendingState(), {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_048_000,
        });

        expect(fallback).toEqual({
            view: 'fallback_demo',
            pathLatch: 'fallback',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_048_000,
            demoStatus: 'running',
        });
        expect(reduceBlitePage(fallback, {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_049_000,
        })).toBe(fallback);
    });

    it('enforces the original T+48 cutoff when a late complete arrives before the timer event', () => {
        const pending = pendingState();
        const lateComplete = reduceBlitePage(pending, {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_048_001,
        });

        expect(lateComplete).toEqual({
            view: 'fallback_demo',
            pathLatch: 'fallback',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_048_000,
            demoStatus: 'running',
        });
        expect(reduceBlitePage(lateComplete, {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_048_002,
        })).toBe(lateComplete);
    });

    it('enforces the original T+48 cutoff when a late durable failure arrives before the timer event', () => {
        const lateFailure = reduceBlitePage(pendingState(), {
            type: 'BLITE_FAILED',
            atMs: 1_700_000_049_000,
        });

        expect(lateFailure).toEqual({
            view: 'fallback_demo',
            pathLatch: 'fallback',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_048_000,
            demoStatus: 'running',
        });
    });

    it('rejects a late success after fallback and never swaps the winning path', () => {
        const fallback = reduceBlitePage(pendingState(), {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_048_000,
        });

        expect(reduceBlitePage(fallback, {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_049_000,
        })).toBe(fallback);
        expect(reduceBlitePage(fallback, {
            type: 'BLITE_FAILED',
            atMs: 1_700_000_049_000,
        })).toBe(fallback);
    });

    it('does not fallback after normal success, including while the user is inactive', () => {
        const ready = reduceBlitePage(pendingState(), {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_047_999,
        });
        expect(reduceBlitePage(ready, {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_048_000,
        })).toBe(ready);
        expect(reduceBlitePage(ready, {
            type: 'BLITE_FAILED',
            atMs: 1_700_000_049_000,
        })).toBe(ready);

        const demo = reduceBlitePage(ready, {
            type: 'SUCCESS_CTA',
            atMs: 1_700_000_065_000,
        });
        expect(demo).toEqual({
            view: 'success_demo',
            pathLatch: 'normal',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_065_000,
            demoStatus: 'running',
        });
        expect(reduceBlitePage(demo, {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_066_000,
        })).toBe(demo);
        expect(reduceBlitePage(demo, {
            type: 'SUCCESS_CTA',
            atMs: 1_700_000_067_000,
        })).toBe(demo);
    });

    it('does not turn an explicit business/preflight failure into a demo', () => {
        const businessFailure: BlitePageState = {
            view: 'preflight_failed',
            pathLatch: null,
            submittedAtMs: null,
            demoStartedAtMs: null,
            demoStatus: 'idle',
        };

        expect(reduceBlitePage(businessFailure, {
            type: 'BLITE_FAILED',
            atMs: 1_700_000_010_000,
        })).toBe(businessFailure);
        expect(reduceBlitePage(businessFailure, {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_048_000,
        })).toBe(businessFailure);
    });

    it('rejects timed transitions that do not have a finite non-negative timestamp', () => {
        const pending = pendingState();
        const invalidEvents = [
            { type: 'BLITE_FAILED', atMs: Number.NaN },
            { type: 'FALLBACK_AT_48', atMs: Number.POSITIVE_INFINITY },
            { type: 'SUCCESS_CTA', atMs: -1 },
        ] as const;

        for (const event of invalidEvents) {
            expect(reduceBlitePage(pending, event)).toBe(pending);
        }
        expect(reduceBlitePage(pending, { type: 'BLITE_FAILED' } as never)).toBe(pending);
    });

    it('rejects timestamps from a different or pre-submission clock', () => {
        const pending = pendingState();
        expect(reduceBlitePage(pending, {
            type: 'BLITE_COMPLETE',
            atMs: 48_000,
        })).toBe(pending);
        expect(reduceBlitePage(pending, {
            type: 'BLITE_FAILED',
            atMs: pending.submittedAtMs! - 1,
        })).toBe(pending);
    });

    it('reveals the legacy plans state after normal demo completion without changing the latch', () => {
        const ready = reduceBlitePage(pendingState(), {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_047_999,
        });
        const demo = reduceBlitePage(ready, {
            type: 'SUCCESS_CTA',
            atMs: 1_700_000_065_000,
        });
        const complete = reduceBlitePage(demo, { type: 'DEMO_COMPLETE' });

        expect(complete).toEqual({
            view: 'legacy',
            pathLatch: 'normal',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_065_000,
            demoStatus: 'complete',
        });
        expect(reduceBlitePage(complete, { type: 'DEMO_COMPLETE' })).toBe(complete);
        expect(reduceBlitePage(complete, { type: 'DEMO_ERROR' })).toBe(complete);
        expect(reduceBlitePage(complete, {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_066_000,
        })).toBe(complete);
    });

    it('fails open from a normal demo error without changing the normal latch', () => {
        const ready = reduceBlitePage(pendingState(), {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_047_999,
        });
        const demo = reduceBlitePage(ready, {
            type: 'SUCCESS_CTA',
            atMs: 1_700_000_065_000,
        });

        expect(reduceBlitePage(demo, { type: 'DEMO_ERROR' })).toEqual({
            view: 'fallback_legacy',
            pathLatch: 'normal',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_065_000,
            demoStatus: 'error',
        });
    });

    it('fails open from fallback demo on completion or demo error', () => {
        const fallback = reduceBlitePage(pendingState(), {
            type: 'BLITE_FAILED',
            atMs: 1_700_000_012_000,
        });

        expect(reduceBlitePage(fallback, { type: 'DEMO_COMPLETE' })).toEqual({
            view: 'fallback_legacy',
            pathLatch: 'fallback',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_012_000,
            demoStatus: 'complete',
        });
        expect(reduceBlitePage(fallback, { type: 'DEMO_ERROR' })).toEqual({
            view: 'fallback_legacy',
            pathLatch: 'fallback',
            submittedAtMs: 1_700_000_000_000,
            demoStartedAtMs: 1_700_000_012_000,
            demoStatus: 'error',
        });
    });

    it('keeps duplicate/remount events idempotent and leaves legacy unchanged', () => {
        expect(reduceBlitePage(initialBlitePageState, {
            type: 'BLITE_COMPLETE',
            atMs: 1_700_000_047_999,
        })).toBe(initialBlitePageState);
        expect(reduceBlitePage(initialBlitePageState, { type: 'DEMO_COMPLETE' })).toBe(initialBlitePageState);

        const fallback = reduceBlitePage(pendingState(), {
            type: 'FALLBACK_AT_48',
            atMs: 1_700_000_048_000,
        });
        const complete = reduceBlitePage(fallback, { type: 'DEMO_COMPLETE' });
        expect(reduceBlitePage(complete, { type: 'DEMO_COMPLETE' })).toBe(complete);
        expect(reduceBlitePage(complete, { type: 'DEMO_ERROR' })).toBe(complete);
    });
});
