import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isAnalysisV2WorkerAvailable } from '@/lib/services/analysis/v2-execution-gate';
import {
    AnalysisV2JobDispatchNotReadyError,
    AnalysisV2JobFenceError,
    AnalysisV2JobLeaseBusyError,
} from '@/lib/services/analysis/v2-job-store';
import {
    getAnalysisV2TasksConfig,
    parseAnalysisV2TaskPayload,
    verifyAnalysisV2TaskAuthorization,
} from '@/lib/services/analysis/v2-tasks';
import { processAnalysisV2TaskDelivery } from '@/lib/services/analysis/v2-worker';
import { isAnalysisV2WorkerErrorCode } from '@/lib/services/analysis/v2-worker-error-codes';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';

export const maxDuration = 300;

const OBSERVABLE_JOB_KEY_PATTERN = /^(?:coordinator:(?:bootstrap|candidate-screening|finalize|join:(?:primary-evidence|final-score))|track:(?:relationships:collect|target-evidence:collect|profiles:batch:[0-9]+|profile-ai:batch:[0-9]+|private-names:batch:[0-9]+|reverse-likes:collect|partner-safety:batch:0|narratives:batch:0))$/;

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
    let config;
    try {
        config = getAnalysisV2TasksConfig();
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
        delivery = parseAnalysisV2TaskPayload(body);
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

    const jobKey = observableJobKey(delivery.jobKey);
    const analysisRequestId = delivery.requestId;
    try {
        const outcome = await processAnalysisV2TaskDelivery(delivery);
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
            return NextResponse.json({ code: errorCode }, { status: 500 });
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
