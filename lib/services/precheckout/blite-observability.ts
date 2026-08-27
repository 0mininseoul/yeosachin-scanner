import 'server-only';

import { operationalLogger } from '@/lib/observability/server';
import type {
    GeminiAttemptDisposition,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';

export type PrecheckoutBliteProfileFailureCategory =
    | 'configuration'
    | 'budget'
    | 'schema'
    | 'incomplete'
    | 'access'
    | 'pending'
    | 'actor_status'
    | 'transport'
    | 'quota'
    | 'start_rejected'
    | 'start_cancelled'
    | 'status_transport'
    | 'ambiguous_start'
    | 'scraping'
    | 'deadline'
    | 'provider';

export type PrecheckoutBliteInferenceFailureReason = 'provider' | 'timeout' | 'invalid';

export type PrecheckoutBliteFinalizerFailureReason = 'schema_cache_miss' | 'fence_lost';

interface CreatePrecheckoutBliteObservabilityOptions {
    preflightId: string;
    startedAtMs: number;
    now?: () => number;
}

function profileFailureErrorCode(
    category: PrecheckoutBliteProfileFailureCategory,
): 'VALIDATION_ERROR' | 'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_ERROR' {
    if (category === 'configuration' || category === 'schema') return 'VALIDATION_ERROR';
    if (category === 'deadline') return 'TIMEOUT';
    if (category === 'quota') return 'RATE_LIMITED';
    return 'PROVIDER_ERROR';
}

/** Map provider-owned failures to the closed B-lite profile taxonomy without retaining text. */
export function precheckoutBliteProfileFailureCategory(
    error: unknown,
): PrecheckoutBliteProfileFailureCategory | undefined {
    const message = error instanceof Error ? error.message : '';
    if (
        message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
        || message.startsWith('ANALYSIS_V2_PROGRESS_')
        || message.startsWith('ANALYSIS_V2_PROVIDER_')
        || message.startsWith('PREFLIGHT_PERSISTENCE_ERROR:')
        || message.startsWith('PREFLIGHT_PROVIDER_RUN_')
        || message.startsWith('SCRAPING_RUN_CHECKPOINT_ERROR:')
        || message.startsWith('SCRAPING_RUN_PENDING_ERROR:')
        || message.startsWith('SCRAPING_AMBIGUOUS_START_ERROR:')
        || message === 'SCRAPING_QUEUED_START_CANCELLED'
    ) return undefined;
    if (message.startsWith('SCRAPING_CONFIG_ERROR:')) return 'configuration';
    if (message.startsWith('SCRAPING_BUDGET_ERROR:')) return 'budget';
    if (message.startsWith('SCRAPING_SCHEMA_ERROR:')) return 'schema';
    if (message.startsWith('SCRAPING_INCOMPLETE_ERROR:') && message.includes('deadline')) {
        return 'deadline';
    }
    if (message.startsWith('SCRAPING_INCOMPLETE_ERROR:')) return 'incomplete';
    if (message.startsWith('SCRAPING_ACCESS_ERROR:')) return 'access';
    if (
        message.includes('actor 실행 실패')
        || message.includes('actor status=')
        || message.includes('Actor status=')
    ) {
        return 'actor_status';
    }
    if (message.includes('transport request failed')) return 'transport';
    if (message === 'SCRAPING_PROVIDER_QUOTA_ERROR') return 'quota';
    if (message === 'SCRAPING_PROVIDER_START_REJECTED_ERROR') return 'start_rejected';
    if (message.includes('run status request failed')) return 'status_transport';
    if (message.startsWith('SCRAPING_ERROR:')) return 'scraping';
    if (message === 'SCRAPING_INVOCATION_DEADLINE_ERROR') return 'deadline';
    return 'provider';
}

function inferenceFailureDisposition(
    reason: PrecheckoutBliteInferenceFailureReason,
): { disposition: 'failure'; errorCode: 'VALIDATION_ERROR' | 'TIMEOUT' | 'PROVIDER_ERROR' } {
    if (reason === 'timeout') return { disposition: 'failure', errorCode: 'TIMEOUT' };
    if (reason === 'invalid') return { disposition: 'failure', errorCode: 'VALIDATION_ERROR' };
    return { disposition: 'failure', errorCode: 'PROVIDER_ERROR' };
}

function inferenceFailureErrorCode(
    disposition: Exclude<GeminiAttemptDisposition, 'success'>,
): 'VALIDATION_ERROR' | 'RATE_LIMITED' | 'PROVIDER_ERROR' {
    if (disposition === 'response_rejected') return 'VALIDATION_ERROR';
    if (disposition === 'rate_limited') return 'RATE_LIMITED';
    return 'PROVIDER_ERROR';
}

export function createPrecheckoutBliteObservability({
    preflightId,
    startedAtMs,
    now = Date.now,
}: CreatePrecheckoutBliteObservabilityOptions) {
    let terminalEmitted = false;
    let demoOutcomeEmitted = false;

    const emitTerminal = (
        event: 'precheckout_blite.completed'
            | 'precheckout_blite.profile_collection_failed'
            | 'precheckout_blite.inference_failed',
        provider: 'apify' | 'gemini',
        severity: 'info' | 'error',
        disposition: GeminiAttemptDisposition | 'failure',
        errorCode?: 'VALIDATION_ERROR' | 'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_ERROR',
        attemptFields: Record<string, unknown> = {},
    ): void => {
        if (terminalEmitted) return;
        terminalEmitted = true;
        try {
            operationalLogger.emit({
                event,
                severity,
                fields: {
                    preflight_id: preflightId,
                    provider,
                    operation: 'precheckout_blite',
                    duration_ms: Math.max(0, now() - startedAtMs),
                    disposition,
                    ...(errorCode ? { error_code: errorCode } : {}),
                    ...attemptFields,
                },
            });
        } catch {
            // Observability must never change the precheckout response.
        }
    };

    const emitOutcome = (
        event:
            | 'precheckout_blite.demo_completed'
            | 'precheckout_blite.demo_failed',
        severity: 'info' | 'error',
        disposition: 'completed' | 'failed',
    ): void => {
        try {
            operationalLogger.emit({
                event,
                severity,
                fields: {
                    preflight_id: preflightId,
                    operation: 'precheckout_blite',
                    duration_ms: Math.max(0, now() - startedAtMs),
                    disposition,
                },
            });
        } catch {
            // Observability must never change the precheckout response.
        }
    };

    return {
        completed(): void {
            emitTerminal('precheckout_blite.completed', 'gemini', 'info', 'success');
        },
        profileCollectionFailed(category: PrecheckoutBliteProfileFailureCategory): void {
            if (category === 'access') return;
            emitTerminal(
                'precheckout_blite.profile_collection_failed',
                'apify',
                'error',
                'failure',
                profileFailureErrorCode(category),
            );
        },
        inferenceFailed(reason: PrecheckoutBliteInferenceFailureReason = 'provider'): void {
            const failure = inferenceFailureDisposition(reason);
            emitTerminal(
                'precheckout_blite.inference_failed',
                'gemini',
                'error',
                failure.disposition,
                failure.errorCode,
            );
        },
        sourceFinalizerFailed(reason: PrecheckoutBliteFinalizerFailureReason): void {
            try {
                operationalLogger.emit({
                    event: 'precheckout_blite.finalizer_failed',
                    severity: 'warn',
                    fields: {
                        preflight_id: preflightId,
                        provider: 'supabase',
                        operation: 'precheckout_blite',
                        phase: 'finalize',
                        duration_ms: Math.max(0, now() - startedAtMs),
                        disposition: 'fallback',
                        error_code: 'PREFLIGHT_PERSISTENCE_ERROR',
                        correlation: reason,
                    },
                });
            } catch {
                // Observability must never change the preflight outcome.
            }
        },
        inferenceAttempt(telemetry: GeminiAttemptTelemetry): void {
            if (telemetry.disposition === 'success') return;
            if (telemetry.disposition === 'rate_limited' && telemetry.attempt < 4) return;

            emitTerminal(
                'precheckout_blite.inference_failed',
                'gemini',
                'error',
                telemetry.disposition,
                inferenceFailureErrorCode(telemetry.disposition),
                {
                    model: telemetry.modelName,
                    thinking_level: telemetry.thinkingLevel?.toLowerCase(),
                    prompt_tokens: telemetry.tokenUsage?.promptTokens,
                    completion_tokens: telemetry.tokenUsage?.completionTokens,
                    thinking_tokens: telemetry.tokenUsage?.thinkingTokens,
                    estimated_cost_usd: telemetry.estimatedCostUsd,
                    attempt: telemetry.attempt,
                },
            );
        },
        demoCompleted(): void {
            if (demoOutcomeEmitted) return;
            demoOutcomeEmitted = true;
            emitOutcome('precheckout_blite.demo_completed', 'info', 'completed');
        },
        demoFailed(): void {
            if (demoOutcomeEmitted) return;
            demoOutcomeEmitted = true;
            emitOutcome('precheckout_blite.demo_failed', 'error', 'failed');
        },
    };
}

type PrecheckoutBliteObservabilityImplementation =
    ReturnType<typeof createPrecheckoutBliteObservability>;

/** Optional keeps injected legacy sinks source-compatible while the default sink records it. */
export type PrecheckoutBliteObservability = Omit<
    PrecheckoutBliteObservabilityImplementation,
    'sourceFinalizerFailed'
> & {
    sourceFinalizerFailed?: (
        reason: PrecheckoutBliteFinalizerFailureReason,
    ) => void;
};
