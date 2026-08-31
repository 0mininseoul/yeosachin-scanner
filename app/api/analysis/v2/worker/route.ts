import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isAnalysisV2WorkerAvailable } from '@/lib/services/analysis/v2-execution-gate';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import {
    classifyPreflightWorkerFailure,
} from '@/lib/services/analysis/preflight';
import { preflightWorkerErrorCode } from '@/lib/observability/preflight-events';
import { settleBlockedFreshAdmission } from '@/lib/services/analysis/fresh-admission-worker-runtime';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    createBetaApifyCreditPoolStore,
} from '@/lib/services/analysis/beta-apify-credit-runtime';
import {
    createBetaApifyPreflightCoordinator,
    createServerBetaApifyCreditClientFactory,
} from '@/lib/services/analysis/beta-apify-preflight-coordinator';
import {
    AnalysisV2JobDispatchNotReadyError,
    AnalysisV2JobFenceError,
    AnalysisV2JobLeaseBusyError,
    analysisV2JobStore,
    type AnalysisV2TaskDelivery,
} from '@/lib/services/analysis/v2-job-store';
import {
    getAnalysisV2TasksConfig,
    enqueueAnalysisV2FreshAdmissionTask,
    lookupAnalysisV2FreshAdmissionTask,
    parseAnalysisV2WorkerTaskPayload,
    rearmAnalysisV2JobAfterCapacity,
    verifyAnalysisV2TaskAuthorization,
} from '@/lib/services/analysis/v2-tasks';
import {
    rearmAnalysisV2FreshAdmissionDispatch,
} from '@/lib/services/analysis/fresh-plan-admission';
import { processAnalysisV2TaskDelivery } from '@/lib/services/analysis/v2-worker';
import {
    CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING,
    trustedCloudTasksRetryCount,
} from '@/lib/services/analysis/pipeline-retry';
import {
    ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER,
    analysisV2WorkerTaskContractFromHeader,
} from '@/lib/services/analysis/v2-worker-task-contract';
import { isAnalysisV2WorkerErrorCode } from '@/lib/services/analysis/v2-worker-error-codes';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';
import {
    assertAnalysisTaskWorkloadRole,
    assertAnalysisWorkerWorkloadRole,
} from '@/lib/services/analysis/workload-role';

// Keep the Vercel build declaration within the Hobby ceiling. Cloud Tasks invokes only the
// canonical Cloud Run worker, whose independently configured request timeout is 600 seconds.
export const maxDuration = 300;

const OBSERVABLE_JOB_KEY_PATTERN = /^(?:coordinator:(?:bootstrap|candidate-screening|finalize|join:(?:primary-evidence|final-score))|track:(?:relationships:collect|target-evidence:collect|profiles:batch:[0-9]+|profile-ai:batch:[0-9]+|private-names:batch:[0-9]+|reverse-likes:collect|partner-safety:batch:0|narratives:batch:0))$/;
const CAPACITY_WAIT_ERROR_CODES = new Set([
    'ANALYSIS_V2_AI_CAPACITY_PENDING',
    'ANALYSIS_V2_PROVIDER_ADMISSION_CAPACITY_PENDING',
    'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
    'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
    'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING',
]);

function safeErrorCode(value: unknown, fallback: string): string {
    return isAnalysisV2WorkerErrorCode(value)
        ? value
        : fallback;
}

function observableJobKey(value: unknown): string | null {
    return typeof value === 'string' && OBSERVABLE_JOB_KEY_PATTERN.test(value)
        ? value
        : null;
}

function emitWorkerOutcome(input: {
    context: OperationalRequestContext;
    event: 'analysis_v2.worker_completed' | 'analysis_v2.worker_retry' | 'analysis_v2.worker_failed';
    analysisRequestId?: string;
    jobKey: string | null;
    disposition: string;
    retryable?: boolean;
    errorCode?: string;
}): void {
    try {
        operationalLogger.emit({
            event: input.event,
            severity: input.event === 'analysis_v2.worker_completed'
                ? 'info'
                : input.event === 'analysis_v2.worker_retry' ? 'warn' : 'error',
            fields: {
                ...input.context,
                ...(input.analysisRequestId
                    ? { analysis_request_id: input.analysisRequestId }
                    : {}),
                ...(input.jobKey ? { job_key: input.jobKey } : {}),
                operation: 'worker',
                disposition: input.disposition,
                ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
                ...(input.errorCode ? { error_code: input.errorCode } : {}),
            },
        });
    } catch {
        // Worker acknowledgement and retry semantics must not depend on telemetry delivery.
    }
}

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    // Account for authentication and parsing latency inside the task's immutable time budget.
    const startedAtMs = performance.now();
    let config;
    try {
        config = getAnalysisV2TasksConfig();
        assertAnalysisWorkerWorkloadRole('paid');
    } catch {
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_failed',
            jobKey: null,
            disposition: 'failure',
            retryable: false,
            errorCode: 'JOB_DISPATCH_NOT_READY',
        });
        return NextResponse.json({ code: 'QUEUE_UNAVAILABLE' }, { status: 503 });
    }
    if (!config || !await verifyAnalysisV2TaskAuthorization(
        request.headers.get('authorization'),
        { config }
    )) {
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_failed',
            jobKey: null,
            disposition: 'rejected',
            retryable: false,
            errorCode: 'UNAUTHORIZED',
        });
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }
    // The OIDC check above authenticated this task.  A successor generation
    // may be rotated only when the authenticated Cloud Tasks retry header has
    // reached the bounded safety ceiling; all earlier capacity responses use
    // the queue's normal backoff.
    const retryCount = trustedCloudTasksRetryCount(request.headers, true);
    if (!isAnalysisV2WorkerAvailable()) {
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_failed',
            jobKey: null,
            disposition: 'blocked',
            retryable: true,
            errorCode: 'JOB_DISPATCH_NOT_READY',
        });
        return NextResponse.json({ code: 'V2_PIPELINE_UNAVAILABLE' }, { status: 503 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_failed',
            jobKey: null,
            disposition: 'rejected',
            retryable: false,
            errorCode: 'INVALID_REQUEST',
        });
        return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
    }

    let delivery;
    try {
        delivery = parseAnalysisV2WorkerTaskPayload(body);
    } catch (error) {
        if (error instanceof ZodError) {
            emitWorkerOutcome({
                context,
                event: 'analysis_v2.worker_failed',
                jobKey: null,
                disposition: 'rejected',
                retryable: false,
                errorCode: 'INVALID_REQUEST',
            });
            return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
        }
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_retry',
            jobKey: null,
            disposition: 'transient',
            retryable: true,
            errorCode: 'ANALYSIS_V2_WORKER_UNHANDLED_ERROR',
        });
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }

    try {
        assertAnalysisTaskWorkloadRole(delivery.workloadRole, 'paid');
    } catch {
        const requestId = 'kind' in delivery ? delivery.preflightId : delivery.requestId;
        const jobKey = 'kind' in delivery ? null : observableJobKey(delivery.jobKey);
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_failed',
            analysisRequestId: requestId,
            jobKey,
            disposition: 'rejected',
            retryable: false,
            errorCode: 'ANALYSIS_V2_WORKLOAD_ROLE_MISMATCH',
        });
        return NextResponse.json({ code: 'WORKLOAD_ROLE_MISMATCH' }, { status: 503 });
    }

    // New fresh-admission tasks must carry the explicit paid role. Ordinary
    // pre-existing V2 deliveries remain roleless-compatible during drain, but
    // a roleless fresh payload is ambiguous and must not cross the split.
    if ('kind' in delivery
        && delivery.kind === 'fresh_admission'
        && delivery.workloadRole !== 'paid') {
        emitWorkerOutcome({
            context,
            analysisRequestId: delivery.preflightId,
            jobKey: null,
            event: 'analysis_v2.worker_failed',
            disposition: 'rejected',
            retryable: false,
            errorCode: 'ANALYSIS_V2_WORKLOAD_ROLE_MISMATCH',
        });
        return NextResponse.json({ code: 'WORKLOAD_ROLE_MISMATCH' }, { status: 503 });
    }

    const taskContract = analysisV2WorkerTaskContractFromHeader(
        request.headers.get(ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER),
    );
    if ('kind' in delivery && delivery.kind === 'fresh_admission') {
        try {
            const outcome = await processAnalysisV2FreshAdmission(
                supabaseAdmin,
                {
                    preflightId: delivery.preflightId,
                    generation: delivery.generation,
                    dispatchGeneration: delivery.dispatchGeneration,
                    dispatchToken: delivery.dispatchToken,
                },
                {
                    betaCreditCoordinator: createBetaApifyPreflightCoordinator({
                        store: createBetaApifyCreditPoolStore(supabaseAdmin),
                        clientForSlot: createServerBetaApifyCreditClientFactory(),
                    }),
                },
            );
            if (outcome === 'capacity_pending') {
                if (
                    retryCount !== null
                    && retryCount >= CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
                ) {
                    await rearmAnalysisV2FreshAdmissionDispatch(
                        supabaseAdmin,
                        {
                            preflightId: delivery.preflightId,
                            generation: delivery.generation,
                            dispatchGeneration: delivery.dispatchGeneration,
                            dispatchToken: delivery.dispatchToken,
                        },
                        {
                            enqueue: payload => enqueueAnalysisV2FreshAdmissionTask(
                                payload,
                                { config },
                            ),
                            lookup: input => lookupAnalysisV2FreshAdmissionTask(input, { config }),
                        },
                    );
                }
                emitWorkerOutcome({
                    context,
                    analysisRequestId: delivery.preflightId,
                    jobKey: null,
                    event: 'analysis_v2.worker_retry',
                    disposition: 'capacity_pending',
                    retryable: true,
                    errorCode: 'ANALYSIS_V2_PROVIDER_ADMISSION_CAPACITY_PENDING',
                });
                return NextResponse.json(
                    { code: 'ANALYSIS_V2_PROVIDER_ADMISSION_CAPACITY_PENDING' },
                    { status: 503 },
                );
            }
            if (outcome === 'blocked') {
                await settleBlockedFreshAdmission(
                    supabaseAdmin,
                    delivery.preflightId,
                    operationalLogger,
                );
            }
            emitWorkerOutcome({
                context,
                analysisRequestId: delivery.preflightId,
                jobKey: null,
                event: 'analysis_v2.worker_completed',
                disposition: outcome,
            });
            return NextResponse.json({ status: outcome });
        } catch (error) {
            const failure = classifyPreflightWorkerFailure(error);
            const errorCode = preflightWorkerErrorCode(failure.category);
            emitWorkerOutcome({
                context,
                analysisRequestId: delivery.preflightId,
                jobKey: null,
                event: 'analysis_v2.worker_retry',
                disposition: 'transient',
                retryable: failure.retryable,
                errorCode,
            });
            return NextResponse.json(
                { code: 'ANALYSIS_FAILED' },
                { status: failure.httpStatus ?? 500 },
            );
        }
    }
    const paidDelivery = delivery as import('@/lib/services/analysis/v2-job-store').AnalysisV2TaskDelivery;
    const jobKey = observableJobKey(paidDelivery.jobKey);
    const analysisRequestId = paidDelivery.requestId;
    try {
        const outcome = await processAnalysisV2TaskDelivery(paidDelivery, {
            handlerDeadlineAtMs: startedAtMs + taskContract.handlerWindowMs,
            jobLeaseSeconds: taskContract.jobLeaseSeconds,
        });
        if (outcome.status === 'retry') {
            const errorCode = safeErrorCode(
                outcome.errorCode,
                'ANALYSIS_V2_JOB_HANDLER_FAILED'
            );
            emitWorkerOutcome({
                context,
                event: 'analysis_v2.worker_retry',
                analysisRequestId,
                jobKey,
                disposition: 'transient',
                retryable: true,
                errorCode,
            });
            const isCapacityWait = errorCode === 'ANALYSIS_V2_AI_CAPACITY_PENDING'
                || errorCode === 'ANALYSIS_V2_PROVIDER_ADMISSION_CAPACITY_PENDING';
            if (isCapacityWait) {
                if (
                    retryCount !== null
                    && retryCount >= CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
                ) {
                    try {
                        await rearmAnalysisV2JobAfterCapacity(
                            paidDelivery as AnalysisV2TaskDelivery,
                            { config, store: analysisV2JobStore },
                        );
                    } catch {
                        // The old delivery remains retryable; a failed rearm must never ack work
                        // without either a successor task or the original dispatch fence.
                        return NextResponse.json({ code: errorCode }, { status: 503 });
                    }
                }
            }
            return NextResponse.json(
                { code: errorCode },
                { status: isCapacityWait ? 503 : 500 },
            );
        }
        if (outcome.status === 'failed') {
            const errorCode = safeErrorCode(
                outcome.errorCode,
                'ANALYSIS_V2_JOB_HANDLER_FAILED'
            );
            emitWorkerOutcome({
                context,
                event: 'analysis_v2.worker_failed',
                analysisRequestId,
                jobKey,
                disposition: 'permanent',
                retryable: false,
                errorCode,
            });
            return NextResponse.json({ status: 'failed', errorCode });
        }
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_completed',
            analysisRequestId,
            jobKey,
            disposition: outcome.status,
        });
        return NextResponse.json(outcome);
    } catch (error) {
        if (error instanceof AnalysisV2JobFenceError) {
            emitWorkerOutcome({
                context,
                event: 'analysis_v2.worker_completed',
                analysisRequestId,
                jobKey,
                disposition: 'stale_delivery',
                errorCode: 'ANALYSIS_V2_JOB_FENCE_MISMATCH',
            });
            return NextResponse.json({ status: 'stale_delivery' });
        }
        if (error instanceof AnalysisV2JobDispatchNotReadyError) {
            emitWorkerOutcome({
                context,
                event: 'analysis_v2.worker_retry',
                analysisRequestId,
                jobKey,
                disposition: 'transient',
                retryable: true,
                errorCode: 'JOB_DISPATCH_NOT_READY',
            });
            return NextResponse.json({ code: 'JOB_DISPATCH_NOT_READY' }, { status: 409 });
        }
        if (error instanceof AnalysisV2JobLeaseBusyError) {
            emitWorkerOutcome({
                context,
                event: 'analysis_v2.worker_retry',
                analysisRequestId,
                jobKey,
                disposition: 'transient',
                retryable: true,
                errorCode: 'JOB_LEASE_BUSY',
            });
            return NextResponse.json({ code: 'JOB_LEASE_BUSY' }, { status: 409 });
        }
        emitWorkerOutcome({
            context,
            event: 'analysis_v2.worker_retry',
            analysisRequestId,
            jobKey,
            disposition: 'transient',
            retryable: true,
            errorCode: 'ANALYSIS_V2_WORKER_UNHANDLED_ERROR',
        });
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/analysis/v2/worker',
        context => handlePOST(request, context),
    );
}
