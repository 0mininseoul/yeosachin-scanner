import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
    classifyPreflightWorkerFailure,
    prepareBetaPreflightDispatch,
    processPreflight,
    type PreflightProcessObservation,
} from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getPreflightTasksConfig,
    enqueuePreflightTask,
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
import {
    createBetaApifyCreditPoolStore,
} from '@/lib/services/analysis/beta-apify-credit-runtime';
import {
    createBetaApifyPreflightCoordinator,
    createServerBetaApifyCreditClientFactory,
} from '@/lib/services/analysis/beta-apify-preflight-coordinator';
import {
    bestEffortBetaApifyRefresh,
    bestEffortBetaApifySettlement,
    refreshBetaApifyCreditSnapshots,
    settleBetaApifyPreflightCredit,
} from '@/lib/services/analysis/beta-apify-credit-settlement-runtime';
import { trustedCloudTasksRetryCount } from '@/lib/services/analysis/pipeline-retry';

const workerRequestSchema = z.union([
    z.object({
        preflightId: z.string().uuid(),
    }).strict(),
    z.object({
        preflightId: z.string().uuid(),
        kind: z.literal('beta_prepare'),
        userId: z.string().uuid(),
        prepareGeneration: z.number().int().min(1).max(100),
        prepareToken: z.string().uuid(),
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
    const isFreshAdmission = 'kind' in task && task.kind === 'fresh_admission';
    const isBetaPrepare = 'kind' in task && task.kind === 'beta_prepare';
    const betaCreditCoordinator = createBetaApifyPreflightCoordinator({
        store: createBetaApifyCreditPoolStore(supabaseAdmin),
        clientForSlot: createServerBetaApifyCreditClientFactory(),
    });
    let profileFailureObserved = false;
    try {
        let outcome: 'noop' | 'ready' | 'blocked' | 'prepared';
        if (isFreshAdmission) {
            outcome = await processAnalysisV2FreshAdmission(supabaseAdmin, {
                preflightId: task.preflightId,
                generation: task.generation,
                dispatchGeneration: task.dispatchGeneration,
                dispatchToken: task.dispatchToken,
            }, { betaCreditCoordinator });
        } else if (isBetaPrepare) {
            outcome = await prepareBetaPreflightDispatch({
                preflightId: task.preflightId,
                userId: task.userId,
                prepareGeneration: task.prepareGeneration,
                prepareToken: task.prepareToken,
                deliveryRetryCount: trustedCloudTasksRetryCount(request.headers, true),
                coordinator: betaCreditCoordinator,
                enqueue: (preflightId, generation) => enqueuePreflightTask(
                    preflightId, generation, { config }
                ),
            });
        } else {
            // Construction is server-only and lazy: no token is read and no network starts
            // until a claimed row identifies itself as the dedicated beta channel.
            outcome = await processPreflight(task.preflightId, {
                betaCreditCoordinator,
                settleBetaCredit: preflightId => settleBetaApifyPreflightCredit(
                    supabaseAdmin, preflightId
                ),
                refreshBetaCredit: () => refreshBetaApifyCreditSnapshots(
                    supabaseAdmin, { telemetry: operationalLogger }
                ),
                observer(observation: PreflightProcessObservation) {
                    if (observation.type === 'failed') profileFailureObserved = true;
                    emitPreflightProcessObservation(context, observation);
                },
            });
        }
        if (outcome === 'blocked' && isFreshAdmission) {
            await bestEffortBetaApifySettlement(async () => {
                const processed = await settleBetaApifyPreflightCredit(
                    supabaseAdmin, task.preflightId
                );
                if (processed) {
                    await bestEffortBetaApifyRefresh(() => (
                        refreshBetaApifyCreditSnapshots(
                            supabaseAdmin, { telemetry: operationalLogger }
                        )
                    ));
                }
            });
        }
        const operation = isFreshAdmission
            ? 'fresh_admission'
            : isBetaPrepare ? 'beta_prepare' : 'profile';
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
                    operation: isFreshAdmission
                        ? 'fresh_admission'
                        : isBetaPrepare ? 'beta_prepare' : 'profile',
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
