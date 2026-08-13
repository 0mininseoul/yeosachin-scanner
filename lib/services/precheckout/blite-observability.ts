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
        inferenceFailed(): void {
            emitTerminal(
                'precheckout_blite.inference_failed',
                'gemini',
                'error',
                'failure',
                'PROVIDER_ERROR',
            );
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
    };
}

export type PrecheckoutBliteObservability = ReturnType<typeof createPrecheckoutBliteObservability>;
