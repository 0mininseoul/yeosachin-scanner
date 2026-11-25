import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { VertexDispatchAuthorizationError } from '@/lib/services/ai/vertex-dispatch-window';
import { AnalysisV2SchedulerContinuationError } from '@/lib/services/analysis/v2-ai-scheduler-continuation';
import type { AnalysisV2StageExecutor, AnalysisV2StageExecutorContext } from '@/lib/services/analysis/v2-worker';
import { devStandardProfileReadyReuseEnabled } from './live-budget';
import { DevLiveVertexBudgetReservationPendingError } from './live-budget-signals';

type Phase = 'producer' | 'readyRead' | 'prepare' | 'analysis' | 'checkpoint';
export interface DevStandardProfileDelivery {
    enter(phase: Phase): void;
    readyRows: number;
    readyHits: number;
    claimRpc(): () => void;
}

function outcome(error: unknown) {
    if (error instanceof DevLiveVertexBudgetReservationPendingError
        || (error instanceof VertexDispatchAuthorizationError && error.reason === 'db_contention')) return 'deferred_capacity';
    if (error instanceof AnalysisV2SchedulerContinuationError) {
        switch (error.reason) {
        case 'ANALYSIS_V2_AI_CAPACITY_PENDING': return 'deferred_capacity';
        case 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE': return 'deferred_quarantine';
        case 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT': return 'deferred_deadline';
        case 'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING': return 'deferred_recovery';
        case 'ANALYSIS_V2_PROFILE_CONSUMER_READ_TIMEOUT': return 'deferred_profile_read';
        }
    }
    return 'failed';
}

/** One aggregate per opted-in executor invocation. It never serializes context, outcomes or errors. */
export function observeDevStandardProfileDelivery(run: (
    context: AnalysisV2StageExecutorContext<'profile_ai'>, delivery?: DevStandardProfileDelivery,
) => ReturnType<AnalysisV2StageExecutor<'profile_ai'>>): AnalysisV2StageExecutor<'profile_ai'> {
    return async context => {
        if (context.state.planId !== 'standard' || context.aiStagePolicyVersion !== AI_STAGE_POLICY_V211_VERSION
            || context.schedulerCapability !== 'scheduler-v1' || !devStandardProfileReadyReuseEnabled()) return run(context);
        const started = performance.now();
        let phaseStart = started;
        let phase: Phase = 'producer';
        const durations = { producer: 0, readyRead: 0, prepare: 0, analysis: 0, checkpoint: 0 };
        let individualClaimRpcs = 0;
        let firstClaimMs: number | null = null;
        let maxClaimRpcMs: number | null = null;
        let previousClaimMs: number | null = null;
        let maxClaimStartGapMs: number | null = null;
        const delivery: DevStandardProfileDelivery = {
            readyRows: 0,
            readyHits: 0,
            enter(next) {
                const now = performance.now();
                durations[phase] += Math.round(now - phaseStart);
                phaseStart = now;
                phase = next;
            },
            claimRpc() {
                const claimStart = performance.now();
                const elapsed = Math.round(claimStart - started);
                firstClaimMs ??= elapsed;
                if (previousClaimMs !== null) maxClaimStartGapMs = Math.max(maxClaimStartGapMs ?? 0, elapsed - previousClaimMs);
                previousClaimMs = elapsed;
                individualClaimRpcs++;
                return () => { maxClaimRpcMs = Math.max(maxClaimRpcMs ?? 0, Math.round(performance.now() - claimStart)); };
            },
        };
        let result = 'completed';
        try {
            return await run(context, delivery);
        } catch (error) {
            result = outcome(error);
            throw error;
        } finally {
            const ended = performance.now();
            durations[phase] += Math.round(ended - phaseStart);
            try {
                console.info(JSON.stringify({
                    event: 'dev_standard.profile_ai_delivery',
                    batch: Number.isSafeInteger(context.job.batch) ? context.job.batch : null,
                    generation: Number.isSafeInteger(context.claim.generation) ? context.claim.generation : null,
                    result, lastPhase: phase, totalMs: Math.round(ended - started), phaseMs: durations,
                    readyRows: delivery.readyRows, readyHits: delivery.readyHits, individualClaimRpcs,
                    firstClaimMs, maxClaimStartGapMs, maxClaimRpcMs,
                }));
            } catch { /* Diagnostics cannot change a delivery's disposition. */ }
        }
    };
}
