import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
    classifyPreflightWorkerFailure,
    processPreflight,
    type PreflightProcessObservation,
} from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getPreflightTasksConfig,
    verifyPreflightTaskAuthorization,
} from '@/lib/services/analysis/preflight-tasks';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';
import {
    emitPreflightProcessObservation,
    preflightWorkerErrorCode,
} from '@/lib/observability/preflight-events';

const workerRequestSchema = z.union([
    z.object({
        preflightId: z.string().uuid(),
    }).strict(),
    z.object({
        preflightId: z.string().uuid(),
        kind: z.literal('fresh_admission'),
        generation: z.number().int().min(1).max(100),
        dispatchGeneration: z.number().int().min(1).max(100),
        dispatchToken: z.string().uuid(),
    }).strict(),
]);

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const reject = (status: number, errorCode: string): NextResponse => {
        operationalLogger.emit({
            event: 'preflight.failed',
            severity: status >= 500 ? 'error' : 'warn',
            fields: {
                ...context,
                operation: 'preflight',
                disposition: status >= 500 ? 'failed' : 'rejected',
                error_code: errorCode,
            },
        });
        return NextResponse.json({
            code: status === 401
                ? 'UNAUTHORIZED'
                : status === 400 ? 'INVALID_REQUEST' : 'QUEUE_UNAVAILABLE',
        }, { status });
    };

    let config;
    try {
        config = getPreflightTasksConfig();
    } catch {
        return reject(503, 'JOB_DISPATCH_NOT_READY');
    }
    if (!config || !await verifyPreflightTaskAuthorization(
        request.headers.get('authorization'),
        { config }
    )) {
        return reject(401, 'UNAUTHORIZED');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return reject(400, 'INVALID_REQUEST');
    }
    const parsed = workerRequestSchema.safeParse(body);
    if (!parsed.success) {
        return reject(400, 'INVALID_REQUEST');
    }

    const task = parsed.data;
    const isFreshAdmission = 'kind' in task;
    let profileFailureObserved = false;
    try {
        let outcome: 'noop' | 'ready' | 'blocked';
        if ('kind' in task) {
            outcome = await processAnalysisV2FreshAdmission(supabaseAdmin, {
                preflightId: task.preflightId,
                generation: task.generation,
                dispatchGeneration: task.dispatchGeneration,
                dispatchToken: task.dispatchToken,
            });
        } else {
            outcome = await processPreflight(task.preflightId, {
                observer(observation: PreflightProcessObservation) {
                    if (observation.type === 'failed') profileFailureObserved = true;
                    emitPreflightProcessObservation(context, observation);
                },
            });
        }
        const operation = isFreshAdmission ? 'fresh_admission' : 'profile';
        const disposition = outcome === 'noop' ? 'exists' : outcome;
        if (isFreshAdmission || outcome === 'noop') {
            operationalLogger.emit({
                event: 'preflight.completed',
                severity: outcome === 'blocked' ? 'warn' : 'info',
                fields: {
                    ...context,
                    preflight_id: task.preflightId,
                    operation,
                    disposition,
                },
            });
        }
        return NextResponse.json({ status: outcome });
    } catch (error) {
        const failure = classifyPreflightWorkerFailure(error);
        console.error(JSON.stringify({
            event: 'preflight_worker_failed',
            operation: isFreshAdmission ? 'fresh_admission' : 'profile',
            category: failure.category,
            retryable: failure.retryable,
            httpStatus: failure.httpStatus,
            workerAttemptCount: failure.workerAttemptCount,
        }));
        if (isFreshAdmission || !profileFailureObserved) {
            operationalLogger.emit({
                event: 'preflight.failed',
                severity: 'error',
                fields: {
                    ...context,
                    preflight_id: task.preflightId,
                    operation: isFreshAdmission ? 'fresh_admission' : 'profile',
                    disposition: 'failed',
                    retryable: failure.retryable,
                    ...(failure.httpStatus === null ? {} : { status: failure.httpStatus }),
                    ...(failure.workerAttemptCount === null
                        ? {}
                        : { attempt: failure.workerAttemptCount }),
                    error_code: preflightWorkerErrorCode(failure.category),
                },
            });
        }
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/analysis/preflight/worker',
        context => handlePOST(request, context),
    );
}
