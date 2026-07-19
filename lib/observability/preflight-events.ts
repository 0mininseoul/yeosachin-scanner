import type {
    PreflightProcessObservation,
    PreflightWorkerFailureClassification,
} from '@/lib/services/analysis/preflight';

import type { OperationalRequestContext } from './request';
import { operationalLogger } from './server';

export function preflightWorkerErrorCode(
    category: PreflightWorkerFailureClassification['category'],
): string {
    if (category === 'rate_limit') return 'RATE_LIMITED';
    if (category === 'timeout') return 'TIMEOUT';
    if (category === 'configuration') return 'JOB_DISPATCH_NOT_READY';
    if (category === 'persistence') return 'INTERNAL_ERROR';
    if (category === 'unknown') return 'UNKNOWN';
    return 'PROVIDER_ERROR';
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
        operationalLogger.emit({
            event: 'preflight.completed',
            severity: observation.outcome === 'ready' ? 'info' : 'warn',
            fields: {
                ...fields,
                ...(observation.requiredPlan ? { plan_id: observation.requiredPlan } : {}),
                ...(observation.errorCode ? { error_code: observation.errorCode } : {}),
                disposition: observation.outcome,
            },
        });
        return;
    }
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
