import type {
    PreflightProcessObservation,
    PreflightWorkerFailureClassification,
} from '@/lib/services/analysis/preflight';

import type { OperationalRequestContext } from './request';
import { operationalLogger } from './server';
import {
    preflightFailureReason,
    recordPreflightFailure,
} from '@/lib/services/analysis/preflight-failure-ledger';

const PREFLIGHT_WORKER_ERROR_CODES: Record<
    PreflightWorkerFailureClassification['category'],
    string
> = {
    auth: 'PROVIDER_ERROR',
    circuit: 'PROVIDER_ERROR',
    http: 'PROVIDER_ERROR',
    rate_limit: 'RATE_LIMITED',
    schema: 'PROVIDER_ERROR',
    timeout: 'TIMEOUT',
    transport: 'PROVIDER_ERROR',
    configuration: 'JOB_DISPATCH_NOT_READY',
    persistence: 'PREFLIGHT_PERSISTENCE_ERROR',
    provider: 'PROVIDER_ERROR',
    run_pending: 'PROVIDER_ERROR',
    unknown: 'UNKNOWN',
};

export function preflightWorkerErrorCode(
    category: PreflightWorkerFailureClassification['category'],
): string {
    return PREFLIGHT_WORKER_ERROR_CODES[category];
}

function observationFields(
    context: OperationalRequestContext,
    observation: PreflightProcessObservation,
): Record<string, unknown> {
    return {
        ...context,
        user_id: observation.userId,
        preflight_id: observation.preflightId,
        target_instagram_id: observation.targetInstagramId,
        ...(observation.followersCount === undefined
            ? {}
            : { input_count: observation.followersCount }),
        ...(observation.followingCount === undefined
            ? {}
            : { output_count: observation.followingCount }),
        operation: 'profile',
    };
}

export function emitPreflightProcessObservation(
    context: OperationalRequestContext,
    observation: PreflightProcessObservation,
): void {
    const fields = observationFields(context, observation);
    if (observation.type === 'profile_collected') {
        operationalLogger.emit({
            event: 'preflight.profile_collected',
            severity: 'info',
            fields: {
                ...fields,
                disposition: 'success',
            },
        });
        return;
    }
    if (observation.type === 'completed') {
        // The terminal processor owns the one durable failure-ledger row for a
        // blocked preflight lineage. This observer may be replayed, so it must
        // remain observability-only for completed transitions.
        operationalLogger.emit({
            event: 'preflight.completed',
            severity: observation.outcome === 'ready' ? 'info' : 'warn',
            fields: {
                ...fields,
                ...(observation.requiredPlan ? { plan_id: observation.requiredPlan } : {}),
                ...(observation.failureCategory
                    ? { error_code: preflightWorkerErrorCode(observation.failureCategory) }
                    : observation.errorCode
                        ? { error_code: observation.errorCode }
                        : {}),
                disposition: observation.outcome,
            },
        });
        return;
    }
    void recordPreflightFailure({
        userId: observation.userId,
        preflightId: observation.preflightId,
        stage: 'profile',
        errorCode: preflightFailureReason(preflightWorkerErrorCode(observation.category)),
    });
    operationalLogger.emit({
        event: 'preflight.failed',
        severity: 'error',
        fields: {
            ...fields,
            disposition: 'failed',
            retryable: observation.retryable,
            ...(observation.httpStatus === null ? {} : { status: observation.httpStatus }),
            attempt: observation.workerAttemptCount,
            error_code: preflightWorkerErrorCode(observation.category),
        },
    });
}
