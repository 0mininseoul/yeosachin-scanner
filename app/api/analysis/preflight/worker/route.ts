import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
    classifyPreflightWorkerFailure,
    prepareBetaPreflightDispatch,
    preflightStore,
    processPreflight,
    type PreflightProcessObservation,
} from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getPreflightTasksConfig,
    enqueuePrecheckoutBliteTask,
    enqueuePreflightTask,
    lookupPrecheckoutBliteTask,
    lookupPreflightTask,
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
    refreshBetaApifyCreditSnapshots,
    settleBetaApifyPreflightCredit,
} from '@/lib/services/analysis/beta-apify-credit-settlement-runtime';
import { settleBlockedFreshAdmission } from '@/lib/services/analysis/fresh-admission-worker-runtime';
import {
    CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING,
    trustedCloudTasksRetryCount,
} from '@/lib/services/analysis/pipeline-retry';
import { runPrecheckoutBlite } from '@/lib/services/precheckout/blite-runner';
import {
    assertAnalysisTaskWorkloadRole,
    assertAnalysisWorkerWorkloadRole,
} from '@/lib/services/analysis/workload-role';
import { isAnalysisBetaPrepareEnabled } from '@/lib/services/analysis/betatest-access';

// B-lite finishes its durable terminal checkpoint after the UI's T+90 guard; it must not
// extend the preflight or provider deadline to consume this route-level cleanup margin.
export const maxDuration = 105;

const workerRequestSchema = z.union([
    z.object({
        preflightId: z.string().uuid(),
        workloadRole: z.enum(['preflight', 'paid']).optional(),
        generation: z.number().int().min(1).max(100).optional(),
        reservationToken: z.string().uuid().optional(),
    }).strict().superRefine((value, context) => {
        if ((value.generation === undefined) !== (value.reservationToken === undefined)) {
            context.addIssue({
                code: 'custom',
                message: 'Preflight dispatch generation/token must be supplied together.',
            });
        }
    }),
    z.object({
        preflightId: z.string().uuid(),
        workloadRole: z.enum(['preflight', 'paid']).optional(),
        kind: z.literal('beta_prepare'),
        userId: z.string().uuid(),
        prepareGeneration: z.number().int().min(1).max(100),
        prepareToken: z.string().uuid(),
    }).strict(),
    z.object({
        preflightId: z.string().uuid(),
        workloadRole: z.enum(['preflight', 'paid']).optional(),
        kind: z.literal('fresh_admission'),
        generation: z.number().int().min(1).max(100),
        dispatchGeneration: z.number().int().min(1).max(100),
        dispatchToken: z.string().uuid(),
    }).strict(),
    z.object({
        preflightId: z.string().uuid(),
        workloadRole: z.enum(['preflight', 'paid']).optional(),
        kind: z.literal('precheckout_blite'),
        dispatchGeneration: z.number().int().min(1).max(100).optional(),
        dispatchToken: z.string().uuid().optional(),
    }).strict().superRefine((value, context) => {
        if ((value.dispatchGeneration === undefined) !== (value.dispatchToken === undefined)) {
            context.addIssue({
                code: 'custom',
                message: 'B-lite dispatch generation/token must be supplied together.',
            });
        }
    }),
]);

async function rearmBliteDispatchAfterCapacity(input: {
    preflightId: string;
    dispatchGeneration?: number;
    dispatchToken?: string;
    config: NonNullable<ReturnType<typeof getPreflightTasksConfig>>;
}): Promise<void> {
    // New tasks carry a durable dispatch fence. Legacy roleless B-lite tasks remain readable,
    // but cannot safely rotate a successor without that fence and therefore rely on bounded
    // maintenance recovery rather than guessing at the current generation.
    if (input.dispatchGeneration === undefined || input.dispatchToken === undefined) return;
    const rearm = preflightStore.rearmBliteDispatch;
    if (!rearm) throw new Error('PRECHECKOUT_BLITE_DISPATCH_REARM_UNAVAILABLE');
    const reservation = await rearm({
        preflightId: input.preflightId,
        expectedGeneration: input.dispatchGeneration,
        expectedDispatchToken: input.dispatchToken,
    });
    if (!reservation.shouldEnqueue) return;
    if (!reservation.dispatchToken) {
        throw new Error('PRECHECKOUT_BLITE_DISPATCH_REARM_TOKEN_MISSING');
    }
    let taskConfirmed = false;
    try {
        await enqueuePrecheckoutBliteTask(input.preflightId, {
            config: input.config,
            dispatchGeneration: reservation.dispatchGeneration,
            dispatchToken: reservation.dispatchToken,
        });
        taskConfirmed = true;
    } catch (error) {
        // A retryable/unknown create response cannot safely release the reservation: the
        // deterministic task may have been accepted before the response was lost.  A bounded
        // lookup is the only safe way to prove the enqueue and preserve its generation/token.
        if (await lookupPrecheckoutBliteTask(input.preflightId, {
            config: input.config,
            dispatchGeneration: reservation.dispatchGeneration,
        }) === 'exists') {
            taskConfirmed = true;
        }
        if (!taskConfirmed) {
            // Keep enqueuing/reserved ownership for maintenance recovery.  In particular, do not
            // turn an ambiguous response into an idle row that could race a committed task.
            throw error;
        }
    }
    if (!taskConfirmed) {
        throw new Error('PRECHECKOUT_BLITE_DISPATCH_TASK_UNCONFIRMED');
    }
    if (!preflightStore.markBliteDispatchEnqueued) {
        throw new Error('PRECHECKOUT_BLITE_DISPATCH_MARK_UNAVAILABLE');
    }
    try {
        const marked = await preflightStore.markBliteDispatchEnqueued({
            preflightId: input.preflightId,
            dispatchGeneration: reservation.dispatchGeneration,
            dispatchToken: reservation.dispatchToken,
        });
        if (marked) return;
        // A false result is a safe replay only when the exact deterministic task exists.  The
        // row may already have transitioned before a lost mark response.
        if (await lookupPrecheckoutBliteTask(input.preflightId, {
            config: input.config,
            dispatchGeneration: reservation.dispatchGeneration,
        }) === 'exists') return;
        throw new Error('PRECHECKOUT_BLITE_DISPATCH_MARK_FENCE_MISMATCH');
    } catch (error) {
        // Mark may have committed before its response was lost.  Preserve the row and retry the
        // exact mark only after confirming the task; never run failure cleanup here.
        if (await lookupPrecheckoutBliteTask(input.preflightId, {
            config: input.config,
            dispatchGeneration: reservation.dispatchGeneration,
        }) === 'exists') {
            const marked = await preflightStore.markBliteDispatchEnqueued({
                preflightId: input.preflightId,
                dispatchGeneration: reservation.dispatchGeneration,
                dispatchToken: reservation.dispatchToken,
            });
            if (marked) return;
        }
        throw error;
    }
}

async function rearmPreflightDispatchAfterCapacity(input: {
    preflightId: string;
    generation?: number;
    reservationToken?: string;
    config: NonNullable<ReturnType<typeof getPreflightTasksConfig>>;
}): Promise<void> {
    // Roleless legacy deliveries remain drain-compatible, but only a new fenced task can
    // safely rotate its successor after Cloud Tasks exhausts transport attempts.
    if (input.generation === undefined || input.reservationToken === undefined) return;
    const rearm = preflightStore.rearmProviderCapacityDispatch;
    if (!rearm || !preflightStore.markProviderCapacityDispatch) {
        throw new Error('PREFLIGHT_DISPATCH_REARM_UNAVAILABLE');
    }
    const reservation = await rearm({
        preflightId: input.preflightId,
        expectedGeneration: input.generation,
        expectedReservationToken: input.reservationToken,
    });
    if (!reservation.shouldEnqueue) return;
    if (!reservation.reservationToken) {
        throw new Error('PREFLIGHT_DISPATCH_REARM_TOKEN_MISSING');
    }
    let taskConfirmed = false;
    try {
        await enqueuePreflightTask(input.preflightId, reservation.generation, {
            config: input.config,
            reservationToken: reservation.reservationToken,
        });
        taskConfirmed = true;
    } catch (error) {
        // Even a known terminal refusal retains this generation/token. The historical dispatch
        // constraint only permits generation zero for unreserved rows, and resetting it could
        // collide with a legacy deterministic g1 task. Maintenance retries this exact identity.
        if (await lookupPreflightTask(input.preflightId, reservation.generation, {
            config: input.config,
        }) === 'exists') {
            taskConfirmed = true;
        }
        if (!taskConfirmed) throw error;
    }
    try {
        const marked = await preflightStore.markProviderCapacityDispatch({
            preflightId: input.preflightId,
            generation: reservation.generation,
            reservationToken: reservation.reservationToken,
        });
        if (marked) return;
        throw new Error('PREFLIGHT_DISPATCH_REARM_MARK_FENCE_MISMATCH');
    } catch (error) {
        // Preserve the reservation when the mark response is ambiguous.  Confirming the exact
        // task lets a replayed mark converge without creating a second terminal effect.
        if (await lookupPreflightTask(input.preflightId, reservation.generation, {
            config: input.config,
        }) === 'exists') {
            const marked = await preflightStore.markProviderCapacityDispatch({
                preflightId: input.preflightId,
                generation: reservation.generation,
                reservationToken: reservation.reservationToken,
            });
            if (marked) return;
        }
        throw error;
    }
}

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
        assertAnalysisWorkerWorkloadRole('preflight');
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
    const isBetaPrepare = 'kind' in task && task.kind === 'beta_prepare';
    // Beta preparation is a retired producer in the active exact-three
    // rollout. Reject before constructing/claiming the beta coordinator so a
    // disabled worker cannot reach the historical six-slot/provider path.
    if (isBetaPrepare && !isAnalysisBetaPrepareEnabled()) {
        return reject(503, 'BETA_PREPARE_DISABLED');
    }
    // The OIDC check above has already authenticated the task caller.  Only the
    // Cloud Tasks header on that authenticated request is eligible to trigger a
    // durable successor; missing/untrusted retry metadata stays on the normal
    // 503 backoff path.
    const retryCount = trustedCloudTasksRetryCount(request.headers, true);
    const isFreshAdmission = 'kind' in task && task.kind === 'fresh_admission';
    try {
        assertAnalysisTaskWorkloadRole(task.workloadRole, 'preflight');
    } catch {
        return reject(503, 'ANALYSIS_WORKLOAD_ROLE_MISMATCH');
    }
    // Fresh admissions created after the split belong exclusively to the paid
    // queue. The preflight route only drains roleless legacy fresh payloads;
    // accepting an explicit role here would let a producer bypass isolation.
    if (isFreshAdmission && task.workloadRole !== undefined) {
        return reject(503, 'ANALYSIS_WORKLOAD_ROLE_MISMATCH');
    }
    const isPrecheckoutBlite = 'kind' in task && task.kind === 'precheckout_blite';
    const betaCreditCoordinator = createBetaApifyPreflightCoordinator({
        store: createBetaApifyCreditPoolStore(supabaseAdmin),
        clientForSlot: createServerBetaApifyCreditClientFactory(),
    });
    let profileFailureObserved = false;
    try {
        let outcome: 'noop' | 'ready' | 'blocked' | 'prepared' | 'pending' | 'capacity_pending' | 'complete' | 'failed';
        if (isPrecheckoutBlite) {
                outcome = task.dispatchGeneration === undefined
                    ? await runPrecheckoutBlite(task.preflightId)
                    : await runPrecheckoutBlite(task.preflightId, {
                        dispatchGeneration: task.dispatchGeneration,
                        dispatchToken: task.dispatchToken,
                    });
        } else if (isFreshAdmission) {
            outcome = await processAnalysisV2FreshAdmission(supabaseAdmin, {
                preflightId: task.preflightId,
                generation: task.generation,
                dispatchGeneration: task.dispatchGeneration,
                dispatchToken: task.dispatchToken,
            }, {
                betaCreditCoordinator,
                ...(task.workloadRole === undefined ? { legacyDrain: true } : {}),
            });
        } else if (isBetaPrepare) {
            outcome = await prepareBetaPreflightDispatch({
                preflightId: task.preflightId,
                userId: task.userId,
                prepareGeneration: task.prepareGeneration,
                prepareToken: task.prepareToken,
                deliveryRetryCount: trustedCloudTasksRetryCount(request.headers, true),
                coordinator: betaCreditCoordinator,
                enqueue: (preflightId, generation, reservationToken) => enqueuePreflightTask(
                    preflightId,
                    generation,
                    { config, reservationToken },
                ),
            });
        } else if (!('kind' in task)) {
            // Construction is server-only and lazy: no token is read and no network starts
            // until a claimed row identifies itself as the dedicated beta channel.
            outcome = await processPreflight(task.preflightId, {
                betaCreditCoordinator,
                settleBetaCredit: preflightId => settleBetaApifyPreflightCredit(
                    supabaseAdmin, preflightId, { telemetry: operationalLogger }
                ),
                refreshBetaCredit: () => refreshBetaApifyCreditSnapshots(
                    supabaseAdmin, { telemetry: operationalLogger }
                ),
                enqueueBliteInference: (preflightId, dispatchGeneration, dispatchToken) => (
                    enqueuePrecheckoutBliteTask(
                        preflightId,
                        {
                            config,
                            ...(dispatchGeneration === undefined
                                ? {}
                                : { dispatchGeneration }),
                            ...(dispatchToken === undefined ? {} : { dispatchToken }),
                        },
                    )
                ),
                ...(task.generation !== undefined && task.reservationToken !== undefined
                    ? {
                        dispatchFence: {
                            generation: task.generation,
                            reservationToken: task.reservationToken,
                        },
                    }
                    : {}),
                observer(observation: PreflightProcessObservation) {
                    if (observation.type === 'failed') profileFailureObserved = true;
                    emitPreflightProcessObservation(context, observation);
                },
            });
        } else {
            return reject(400, 'INVALID_REQUEST');
        }
        if (
            isPrecheckoutBlite
            && (outcome === 'capacity_pending' || outcome === 'pending')
        ) {
            // Durable cache defer (or an unknown terminal checkpoint) must never be acknowledged
            // as a successful Cloud Task while the dispatch row still points at this delivery.
            // Preserve Cloud Tasks' bounded exponential backoff while capacity
            // remains unavailable.  Rotate a fenced successor only at the
            // safety ceiling so a 20-delivery outage cannot burn generations
            // in a hot loop.  Plain duplicate pending never rotates here.
            if (
                outcome === 'capacity_pending'
                && retryCount !== null
                && retryCount >= CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
            ) {
                await rearmBliteDispatchAfterCapacity({
                    preflightId: task.preflightId,
                    ...('dispatchGeneration' in task
                        ? { dispatchGeneration: task.dispatchGeneration }
                        : {}),
                    ...('dispatchToken' in task ? { dispatchToken: task.dispatchToken } : {}),
                    config,
                });
            }
            operationalLogger.emit({
                event: 'preflight.failed',
                severity: 'warn',
                fields: {
                    ...context,
                    preflight_id: task.preflightId,
                    operation: 'precheckout_blite',
                    disposition: 'capacity_pending',
                    retryable: true,
                    error_code: 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING',
                },
            });
            return NextResponse.json(
                { code: 'CAPACITY_PENDING', status: 'pending' },
                { status: 503 },
            );
        }
        if (outcome === 'capacity_pending') {
            if (
                retryCount !== null
                && retryCount >= CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
            ) {
                await rearmPreflightDispatchAfterCapacity({
                    preflightId: task.preflightId,
                    ...('generation' in task ? { generation: task.generation } : {}),
                    ...('reservationToken' in task ? { reservationToken: task.reservationToken } : {}),
                    config,
                });
            }
            operationalLogger.emit({
                event: 'preflight.failed',
                severity: 'warn',
                fields: {
                    ...context,
                    preflight_id: task.preflightId,
                    operation: 'profile',
                    disposition: 'capacity_pending',
                    retryable: true,
                    error_code: 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING',
                },
            });
            return NextResponse.json(
                { code: 'CAPACITY_PENDING', status: 'pending' },
                { status: 503 },
            );
        }
        if (outcome === 'blocked' && isFreshAdmission) {
            await settleBlockedFreshAdmission(
                supabaseAdmin,
                task.preflightId,
                operationalLogger,
            );
        }
        const operation = isPrecheckoutBlite
            ? 'precheckout_blite'
            : isFreshAdmission
            ? 'fresh_admission'
            : isBetaPrepare ? 'beta_prepare' : 'profile';
        const disposition = outcome === 'noop' ? 'exists' : outcome;
        if (isFreshAdmission || isPrecheckoutBlite || outcome === 'noop') {
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
            operation: isPrecheckoutBlite
                ? 'precheckout_blite'
                : isFreshAdmission ? 'fresh_admission' : 'profile',
            category: failure.category,
            retryable: failure.retryable,
            httpStatus: failure.httpStatus,
            workerAttemptCount: failure.workerAttemptCount,
            ...(failure.persistenceOperation
                ? { persistenceOperation: failure.persistenceOperation }
                : {}),
            ...(failure.persistenceCode
                ? { persistenceCode: failure.persistenceCode }
                : {}),
        }));
        if (isFreshAdmission || isPrecheckoutBlite || !profileFailureObserved) {
            operationalLogger.emit({
                event: 'preflight.failed',
                severity: 'error',
                fields: {
                    ...context,
                    preflight_id: task.preflightId,
                    operation: isPrecheckoutBlite
                        ? 'precheckout_blite'
                        : isFreshAdmission
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
        { flush: 'await' },
    );
}
