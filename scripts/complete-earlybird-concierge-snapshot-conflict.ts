import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { preflightTargetInputHash } from '@/lib/services/analysis/preflight-identity';
import {
    analysisV2JobStore,
    type AnalysisV2JobDispatchReservation,
} from '@/lib/services/analysis/v2-job-store';
import { processAnalysisV2TaskDelivery } from '@/lib/services/analysis/v2-worker';
import { analysisV2ResultStore } from '@/lib/services/analysis/v2-result-store';
import { resolveAnalysisResultOwner } from '@/lib/services/analysis/result-operator-access';
import {
    parseConciergeSnapshotConflictRecoveryArgs,
    recoverWithServiceRole,
    type ConciergeSnapshotConflictRecoveryInput,
} from './recover-earlybird-concierge-snapshot-conflict';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const timestampSchema = z.string().datetime({ offset: true });
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._]{1,30}$/);
const inputHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const runIdSchema = z.string().min(1).max(512);
const resultPathSchema = z.string().regex(/^\/result\/[0-9a-f-]{36}$/);
const outputSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready') }).strict(),
    z.object({ status: z.literal('completed') }).strict(),
]);

type CompletionMode = 'dry-run' | 'execute';
export type ConciergeSnapshotConflictCompletionInput =
    ConciergeSnapshotConflictRecoveryInput & { mode: CompletionMode };

type CompletionPrecheck = Readonly<{
    recovered: boolean;
    requestId: string | null;
    requestStatus: 'pending' | 'processing' | 'completed' | null;
    fulfillmentStatus:
        | 'manual_review'
        | 'retryable_failure'
        | 'analysis_in_progress'
        | 'completed';
}>;

type CreatedRequest = Readonly<{
    requestId: string;
    initialJobKey: 'coordinator:bootstrap';
}>;

export interface ConciergeSnapshotConflictCompletionDependencies {
    precheck(input: ConciergeSnapshotConflictRecoveryInput): Promise<CompletionPrecheck>;
    recover(input: ConciergeSnapshotConflictRecoveryInput): Promise<unknown>;
    createRequest(orderId: string, preflightId: string): Promise<CreatedRequest>;
    runRequest(
        orderId: string,
        requestId: string,
        initialJobKey: 'coordinator:bootstrap',
    ): Promise<void>;
    reconcileAndVerify(input: {
        orderId: string;
        preflightId: string;
        requestId: string;
        expectedManualReviewAt: string;
        expectedAdmissionRefreshedAt: string;
    }): Promise<void>;
    writeStdout(value: string): void;
}

export function parseConciergeSnapshotConflictCompletionArgs(
    args: readonly string[],
): ConciergeSnapshotConflictCompletionInput {
    const modes = args.filter(value => value === '--dry-run' || value === '--execute-once');
    if (modes.length !== 1) {
        throw new Error('exactly one of --dry-run or --execute-once is required');
    }
    const recovery = parseConciergeSnapshotConflictRecoveryArgs(
        args.filter(value => value !== '--dry-run' && value !== '--execute-once'),
    );
    return Object.freeze({
        ...recovery,
        mode: modes[0] === '--dry-run' ? 'dry-run' : 'execute',
    });
}

const orderSchema = z.object({
    user_id: uuidSchema,
    preflight_id: uuidSchema,
    target_instagram_id: usernameSchema,
    target_followers_count: z.literal(158),
    target_following_count: z.literal(361),
    plan_id: z.literal('basic'),
    status: z.enum(['paid', 'analysis_in_progress', 'completed']),
    payment_id: z.string().min(1).max(512),
    paid_at: timestampSchema,
    result_request_id: uuidSchema.nullable(),
    concierge_apify_credential_slot: z.literal('tertiary'),
}).strict();

const fulfillmentSchema = z.object({
    status: z.enum([
        'manual_review',
        'retryable_failure',
        'analysis_in_progress',
        'completed',
    ]),
    request_id: uuidSchema.nullable(),
    lease_token: uuidSchema.nullable(),
    lease_expires_at: timestampSchema.nullable(),
    manual_review_at: timestampSchema.nullable(),
    last_error_code: z.string().nullable(),
    attempt_count: z.number().int().min(1).max(10),
}).strict();

const preflightSchema = z.object({
    user_id: uuidSchema,
    target_instagram_id: usernameSchema,
    target_followers_count: z.literal(158),
    target_following_count: z.literal(361),
    target_is_private: z.literal(false),
    status: z.literal('ready'),
    consumed_request_id: uuidSchema.nullable(),
    admission_status: z.literal('ready'),
    admission_generation: z.literal(3),
    admission_refreshed_at: timestampSchema,
    admission_target_followers_count: z.literal(158),
    admission_target_following_count: z.literal(362),
    order_scoped_apify_credential_slot: z.literal('tertiary'),
}).strict();

const providerRunSchema = z.object({
    operation_key: z.enum([
        'target-profile-fresh-admission:g1',
        'target-profile-fresh-admission:g2',
        'target-profile-fresh-admission:g3',
    ]),
    input_hash: inputHashSchema,
    logical_provider: z.literal('apify'),
    actor_id: z.literal('apify/instagram-profile-scraper'),
    credential_slot: z.literal('tertiary'),
    status: z.literal('succeeded'),
    run_id: runIdSchema,
    terminalized_at: timestampSchema,
    actual_usage_usd: z.union([z.number(), z.string()]),
    usage_reconciled_at: timestampSchema,
    reusable_profile_schema_version: z.literal(1),
}).strict();

const executionInspectionRowSchema = z.object({
    recovered: z.boolean(),
    request_id: uuidSchema.nullable(),
    request_status: z.enum(['pending', 'processing', 'completed']).nullable(),
    fulfillment_status: z.enum([
        'manual_review',
        'retryable_failure',
        'analysis_in_progress',
        'completed',
    ]),
}).strict();

const executionInspectionRowsSchema = z.array(executionInspectionRowSchema).length(1);
const protectedPrecheckSchema = z.object({
    fulfillment: fulfillmentSchema,
    provider_runs: z.array(providerRunSchema).length(3),
    active_request_count: z.number().int().min(0).max(500),
    active_job_count: z.number().int().min(0).max(500),
}).strict();

function sameInstant(left: string, right: string): boolean {
    return Date.parse(left) === Date.parse(right);
}

async function exactIncidentPrecheck(
    input: ConciergeSnapshotConflictRecoveryInput,
): Promise<CompletionPrecheck> {
    if (!process.env.APIFY_TERTIARY_API_TOKEN?.trim()) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_TERTIARY_TOKEN_REQUIRED');
    }
    const [{ data: orderData, error: orderError }, {
        data: preflightData,
        error: preflightError,
    }] = await Promise.all([
        supabaseAdmin.from('earlybird_orders').select(
            'user_id,preflight_id,target_instagram_id,target_followers_count,'
            + 'target_following_count,plan_id,status,payment_id,paid_at,'
            + 'result_request_id,concierge_apify_credential_slot',
        ).eq('id', input.orderId).maybeSingle(),
        supabaseAdmin.from('analysis_preflights').select(
            'user_id,target_instagram_id,target_followers_count,target_following_count,'
            + 'target_is_private,status,consumed_request_id,admission_status,'
            + 'admission_generation,admission_refreshed_at,'
            + 'admission_target_followers_count,admission_target_following_count,'
            + 'order_scoped_apify_credential_slot',
        ).eq('id', input.preflightId).maybeSingle(),
    ]);
    if (orderError || preflightError) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_READ_FAILED');
    }
    const order = orderSchema.parse(orderData);
    const preflight = preflightSchema.parse(preflightData);
    const { data: inspectionData, error: inspectionError } = await supabaseAdmin.rpc(
        'inspect_earlybird_concierge_snapshot_recovery_execution',
        {
            p_order_id: input.orderId,
            p_preflight_id: input.preflightId,
            p_expected_manual_review_at: input.expectedManualReviewAt,
            p_expected_admission_refreshed_at: input.expectedAdmissionRefreshedAt,
        },
    );
    if (inspectionError) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_READ_FAILED');
    }
    const inspection = executionInspectionRowsSchema.parse(inspectionData)[0];
    const { data: protectedData, error: protectedError } = await supabaseAdmin.rpc(
        'inspect_earlybird_concierge_snapshot_conflict_precheck',
        {
            p_order_id: input.orderId,
            p_preflight_id: input.preflightId,
            p_expected_manual_review_at: input.expectedManualReviewAt,
            p_expected_admission_refreshed_at: input.expectedAdmissionRefreshedAt,
            p_request_id: inspection.request_id,
        },
    );
    if (protectedError) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_READ_FAILED');
    }
    const protectedSnapshot = protectedPrecheckSchema.parse(protectedData);
    const fulfillment = protectedSnapshot.fulfillment;
    const providerRuns = protectedSnapshot.provider_runs;
    const paidAt = Date.parse(order.paid_at);
    const incidentStart = Date.parse('2026-08-12T18:07:00+09:00');
    const incidentEnd = Date.parse('2026-08-12T18:08:00+09:00');
    const expectedInputHash = preflightTargetInputHash(preflight.target_instagram_id);
    if (
        order.preflight_id !== input.preflightId
        || order.user_id !== preflight.user_id
        || order.target_instagram_id !== preflight.target_instagram_id
        || paidAt < incidentStart
        || paidAt >= incidentEnd
        || (
            !inspection.recovered
            && (
                fulfillment.manual_review_at === null
                || !sameInstant(
                    fulfillment.manual_review_at,
                    input.expectedManualReviewAt,
                )
            )
        )
        || !sameInstant(
            preflight.admission_refreshed_at,
            input.expectedAdmissionRefreshedAt,
        )
        || new Set(providerRuns.map(row => row.operation_key)).size !== 3
        || providerRuns.some(row => row.input_hash !== expectedInputHash)
        || protectedSnapshot.active_request_count !== 0
        || protectedSnapshot.active_job_count !== 0
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_CONFLICT');
    }

    if (
        inspection.request_id !== order.result_request_id
        || inspection.request_id !== fulfillment.request_id
        || inspection.request_id !== preflight.consumed_request_id
        || inspection.fulfillment_status !== fulfillment.status
        || (
            inspection.request_id === null
            && inspection.request_status !== null
        )
        || (
            inspection.request_id !== null
            && inspection.request_status === null
        )
        || (
            !inspection.recovered
            && (
                order.status !== 'paid'
                || fulfillment.status !== 'manual_review'
                || fulfillment.lease_token !== null
                || fulfillment.lease_expires_at !== null
                || fulfillment.last_error_code !== 'SNAPSHOT_CONFLICT'
                || fulfillment.attempt_count !== 1
            )
        )
        || (
            inspection.recovered
            && inspection.request_id === null
            && (
                order.status !== 'paid'
                || fulfillment.status !== 'retryable_failure'
            )
        )
        || (
            inspection.request_id !== null
            && (
                !['analysis_in_progress', 'completed'].includes(order.status)
                || !['analysis_in_progress', 'completed'].includes(
                    fulfillment.status,
                )
            )
        )
        || (
            inspection.request_status !== null
            && inspection.request_status !== 'completed'
            && (
                order.status !== 'analysis_in_progress'
                || fulfillment.status !== 'analysis_in_progress'
            )
        )
        || (
            inspection.request_status === 'completed'
            && ((order.status === 'completed') !== (fulfillment.status === 'completed'))
        )
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_CONFLICT');
    }

    const [{ count: incidentCount, error: incidentError }, {
        count: requestCount,
        error: requestError,
    }, { count: refundCount, error: refundError }] = await Promise.all([
        supabaseAdmin.from('earlybird_orders').select('id', { count: 'exact', head: true })
            .eq('plan_id', 'basic')
            .gte('paid_at', '2026-08-12T18:07:00+09:00')
            .lt('paid_at', '2026-08-12T18:08:00+09:00'),
        supabaseAdmin.from('analysis_requests').select('id', { count: 'exact', head: true })
            .eq('preflight_id', input.preflightId),
        supabaseAdmin.from('earlybird_webhook_events')
            .select('event_id', { count: 'exact', head: true })
            .eq('payment_id', order.payment_id)
            .eq('event_type', 'payment.refunded'),
    ]);
    if (
        incidentError || requestError || refundError
        || incidentCount !== 1
        || requestCount !== (inspection.request_id === null ? 0 : 1)
        || refundCount !== 0
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_CONFLICT');
    }
    return Object.freeze({
        recovered: inspection.recovered,
        requestId: inspection.request_id,
        requestStatus: inspection.request_status,
        fulfillmentStatus: inspection.fulfillment_status,
    });
}

async function createExactRequest(
    orderId: string,
    preflightId: string,
): Promise<CreatedRequest> {
    const { data, error } = await supabaseAdmin.rpc(
        'create_earlybird_concierge_snapshot_recovery_request',
        {
            p_order_id: orderId,
            p_preflight_id: preflightId,
            p_lease_token: randomUUID(),
        },
    );
    if (error) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_REQUEST_CONFLICT');
    }
    const request = z.array(z.object({
        order_id: uuidSchema,
        fulfillment_status: z.literal('analysis_in_progress'),
        request_id: uuidSchema,
        created: z.boolean(),
        initial_job_key: z.literal('coordinator:bootstrap'),
    }).strict()).length(1).parse(data)[0];
    if (request.order_id !== orderId) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_REQUEST_CONFLICT');
    }
    return Object.freeze({
        requestId: request.request_id,
        initialJobKey: request.initial_job_key,
    });
}

type QueuedReservation = Readonly<{
    reservation: AnalysisV2JobDispatchReservation & {
        reserved: true;
        reservationToken: string;
    };
    readyAt: number;
}>;

const activeLocalJobSchema = z.object({
    job_key: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,159}$/),
    status: z.enum(['pending', 'processing']),
    dispatch_state: z.enum(['pending', 'reserved', 'enqueued', 'delivered']),
    dispatch_generation: z.number().int().min(0).max(1_000),
    dispatch_reservation_token: uuidSchema.nullable(),
    dispatch_task_name: z.string().nullable(),
    lease_expires_at: timestampSchema.nullable(),
}).strict();

type ActiveLocalJob = z.infer<typeof activeLocalJobSchema>;

function runnableReservation(
    reservation: AnalysisV2JobDispatchReservation,
    requestId: string,
): QueuedReservation['reservation'] {
    if (
        reservation.requestId !== requestId
        || !reservation.reserved
        || !['pending', 'processing'].includes(reservation.status)
        || !['reserved', 'enqueued', 'delivered'].includes(
            reservation.dispatchState,
        )
        || !reservation.reservationToken
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_JOB_SCOPE_CONFLICT');
    }
    return { ...reservation, reserved: true, reservationToken: reservation.reservationToken };
}

async function waitUntil(timestamp: number): Promise<void> {
    const remaining = timestamp - Date.now();
    if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining));
    }
}

export async function runExactConciergeRequestLocally(
    orderId: string,
    requestId: string,
    _initialJobKey: 'coordinator:bootstrap',
    dependencies: {
        store?: Pick<typeof analysisV2JobStore, 'reserveDispatch' | 'rearmDispatch'>;
        process?: typeof processAnalysisV2TaskDelivery;
        markLocalDispatch?: (
            orderId: string,
            reservation: QueuedReservation['reservation'],
        ) => Promise<void>;
        loadActiveJobs?: (requestId: string) => Promise<readonly ActiveLocalJob[]>;
        now?: () => number;
        wait?: (timestamp: number) => Promise<void>;
    } = {},
): Promise<void> {
    const store = dependencies.store ?? analysisV2JobStore;
    const processDelivery = dependencies.process ?? processAnalysisV2TaskDelivery;
    const now = dependencies.now ?? Date.now;
    const wait = dependencies.wait ?? waitUntil;
    const loadActiveJobs = dependencies.loadActiveJobs ?? (async exactRequestId => {
        const { data, error } = await supabaseAdmin
            .from('analysis_pipeline_jobs')
            .select(
                'job_key,status,dispatch_state,dispatch_generation,'
                + 'dispatch_reservation_token,dispatch_task_name,lease_expires_at',
            )
            .eq('request_id', exactRequestId)
            .in('status', ['pending', 'processing']);
        if (error) {
            throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_JOB_READ_FAILED');
        }
        return z.array(activeLocalJobSchema).max(500).parse(data);
    });
    const markLocalDispatch = dependencies.markLocalDispatch ?? (async (
        exactOrderId,
        reservation,
    ) => {
        const { data, error } = await supabaseAdmin.rpc(
            'mark_earlybird_concierge_snapshot_recovery_job_local',
            {
                p_order_id: exactOrderId,
                p_request_id: reservation.requestId,
                p_job_key: reservation.jobKey,
                p_dispatch_generation: reservation.generation,
                p_dispatch_token: reservation.reservationToken,
            },
        );
        if (error || typeof data !== 'boolean') {
            throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_LOCAL_DISPATCH_FAILED');
        }
    });
    const queue: QueuedReservation[] = [];
    const enqueueReservation = async (
        reservation: QueuedReservation['reservation'],
        readyAt: number,
    ) => {
        await markLocalDispatch(orderId, reservation);
        queue.push({ reservation, readyAt });
    };
    const enqueueIdentity = async (jobRequestId: string, jobKey: string) => {
        if (jobRequestId !== requestId) {
            throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_JOB_SCOPE_CONFLICT');
        }
        const reserved = runnableReservation(
            await store.reserveDispatch({ requestId, jobKey }),
            requestId,
        );
        await enqueueReservation(reserved, now());
        return 'enqueued' as const;
    };
    const activeJobs = await loadActiveJobs(requestId);
    if (activeJobs.length === 0) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_JOB_SCOPE_CONFLICT');
    }
    for (const job of activeJobs) {
        let reservation: QueuedReservation['reservation'];
        if (job.status === 'pending'
            && (job.dispatch_state === 'pending' || job.dispatch_state === 'reserved')) {
            reservation = runnableReservation(
                await store.reserveDispatch({ requestId, jobKey: job.job_key }),
                requestId,
            );
        } else {
            reservation = runnableReservation({
                requestId,
                jobKey: job.job_key,
                reserved: true,
                generation: job.dispatch_generation,
                reservationToken: job.dispatch_reservation_token,
                status: job.status,
                dispatchState: job.dispatch_state,
                taskName: job.dispatch_task_name,
            }, requestId);
        }
        const readyAt = job.status === 'processing' && job.lease_expires_at !== null
            ? Math.max(now(), Date.parse(job.lease_expires_at) + 100)
            : now();
        await enqueueReservation(reservation, readyAt);
    }

    let processed = 0;
    while (queue.length > 0) {
        if (processed >= 500) {
            throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_JOB_LIMIT');
        }
        queue.sort((left, right) => left.readyAt - right.readyAt);
        const queued = queue.shift();
        if (!queued) break;
        await wait(queued.readyAt);
        const delivery = {
            requestId,
            jobKey: queued.reservation.jobKey,
            generation: queued.reservation.generation,
            reservationToken: queued.reservation.reservationToken,
        };
        const outcome = await processDelivery(delivery, {
            handlerDeadlineAtMs: performance.now() + 540_000,
            jobLeaseSeconds: 600,
            analysisLifecycleEventEmitter: async () => false,
            dispatch: enqueueIdentity,
            async dispatchReservedContinuation(reservation, delaySeconds) {
                await enqueueReservation(
                    runnableReservation(reservation, requestId),
                    now() + delaySeconds * 1_000,
                );
            },
        });
        processed += 1;
        if (outcome.status === 'failed') {
            throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_JOB_FAILED');
        }
        if (outcome.status === 'retry') {
            const rearmed = runnableReservation(
                await store.rearmDispatch({
                    requestId,
                    jobKey: delivery.jobKey,
                    expectedGeneration: delivery.generation,
                    expectedReservationToken: delivery.reservationToken,
                }),
                requestId,
            );
            await enqueueReservation(rearmed, now() + 5_000);
        }
    }
}

async function reconcileAndVerifyExactRequest(input: {
    orderId: string;
    preflightId: string;
    requestId: string;
    expectedManualReviewAt: string;
    expectedAdmissionRefreshedAt: string;
}): Promise<void> {
    const { data: requestData, error: requestError } = await supabaseAdmin
        .from('analysis_requests')
        .select('id,user_id,preflight_id,status,pipeline_version')
        .eq('id', input.requestId)
        .maybeSingle();
    const request = z.object({
        id: uuidSchema,
        user_id: uuidSchema,
        preflight_id: uuidSchema,
        status: z.literal('completed'),
        pipeline_version: z.literal('v2'),
    }).strict().safeParse(requestData);
    if (
        requestError || !request.success || request.data.preflight_id !== input.preflightId
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_RESULT_CONFLICT');
    }

    const { data: completed, error: completionError } = await supabaseAdmin.rpc(
        'complete_earlybird_concierge_snapshot_recovery',
        {
            p_order_id: input.orderId,
            p_preflight_id: input.preflightId,
            p_request_id: input.requestId,
        },
    );
    if (completionError || typeof completed !== 'boolean') {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_RECONCILE_CONFLICT');
    }
    const { data: protectedData, error: protectedError } = await supabaseAdmin.rpc(
        'inspect_earlybird_concierge_snapshot_conflict_precheck',
        {
            p_order_id: input.orderId,
            p_preflight_id: input.preflightId,
            p_expected_manual_review_at: input.expectedManualReviewAt,
            p_expected_admission_refreshed_at: input.expectedAdmissionRefreshedAt,
            p_request_id: input.requestId,
        },
    );
    const protectedSnapshot = protectedPrecheckSchema.safeParse(protectedData);
    const [{ data: orderData, error: orderError }, { count: activeRequestCount, error: activeRequestError }, {
        count: activeJobCount,
        error: activeJobError,
    }] = await Promise.all([
        supabaseAdmin.from('earlybird_orders')
            .select('preflight_id,result_request_id,status')
            .eq('id', input.orderId)
            .maybeSingle(),
        supabaseAdmin.from('analysis_requests')
            .select('id', { count: 'exact', head: true })
            .eq('id', input.requestId)
            .in('status', ['pending', 'processing']),
        supabaseAdmin.from('analysis_pipeline_jobs')
            .select('request_id', { count: 'exact', head: true })
            .eq('request_id', input.requestId)
            .in('status', ['pending', 'processing']),
    ]);
    const order = z.object({
        preflight_id: uuidSchema,
        result_request_id: uuidSchema,
        status: z.literal('completed'),
    }).strict().safeParse(orderData);
    const fulfillment = z.object({
        request_id: uuidSchema,
        status: z.literal('completed'),
    }).strict().safeParse(protectedSnapshot.success
        ? protectedSnapshot.data.fulfillment
        : null);
    if (
        orderError || activeRequestError || activeJobError
        || protectedError || !protectedSnapshot.success
        || activeRequestCount !== 0 || activeJobCount !== 0
        || !order.success || !fulfillment.success
        || order.data.preflight_id !== input.preflightId
        || order.data.result_request_id !== input.requestId
        || fulfillment.data.request_id !== input.requestId
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_RESULT_CONFLICT');
    }

    const adminResolvedOwner = await resolveAnalysisResultOwner(input.requestId);
    if (!adminResolvedOwner || adminResolvedOwner !== request.data.user_id) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_ACCESS_CONFLICT');
    }
    const [ownerPage, adminPage] = await Promise.all([
        analysisV2ResultStore.loadPage({
            requestId: input.requestId,
            userId: request.data.user_id,
        }),
        analysisV2ResultStore.loadPage({
            requestId: input.requestId,
            userId: adminResolvedOwner,
        }),
    ]);
    if (!ownerPage || !adminPage || JSON.stringify(ownerPage) !== JSON.stringify(adminPage)) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_ACCESS_CONFLICT');
    }
    resultPathSchema.parse(`/result/${input.requestId}`);
}

function defaultDependencies(): ConciergeSnapshotConflictCompletionDependencies {
    return {
        precheck: exactIncidentPrecheck,
        recover: recoverWithServiceRole,
        createRequest: createExactRequest,
        runRequest: runExactConciergeRequestLocally,
        reconcileAndVerify: reconcileAndVerifyExactRequest,
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runConciergeSnapshotConflictCompletion(
    args: readonly string[],
    dependencies: ConciergeSnapshotConflictCompletionDependencies = defaultDependencies(),
) {
    const { mode, ...input } = parseConciergeSnapshotConflictCompletionArgs(args);
    const precheck = await dependencies.precheck(input);
    if (mode === 'dry-run') {
        const output = outputSchema.parse({ status: 'ready' });
        dependencies.writeStdout(`${JSON.stringify(output)}\n`);
        return Object.freeze(output);
    }
    const recovered = z.object({
        applied: z.boolean(),
        fulfillmentStatus: z.enum([
            'retryable_failure',
            'admission_pending',
            'analysis_in_progress',
            'completed',
        ]),
    }).strict().parse(await dependencies.recover(input));
    if (
        (!precheck.recovered
            && (!recovered.applied
                || recovered.fulfillmentStatus !== 'retryable_failure'))
        || (precheck.recovered
            && recovered.fulfillmentStatus !== precheck.fulfillmentStatus)
    ) {
        throw new Error('CONCIERGE_SNAPSHOT_COMPLETION_RECOVERY_STATE_INVALID');
    }
    let request: CreatedRequest;
    if (precheck.requestId === null) {
        request = await dependencies.createRequest(input.orderId, input.preflightId);
    } else {
        request = Object.freeze({
            requestId: precheck.requestId,
            initialJobKey: 'coordinator:bootstrap',
        });
    }
    if (precheck.requestStatus !== 'completed') {
        await dependencies.runRequest(
            input.orderId,
            request.requestId,
            request.initialJobKey,
        );
    }
    await dependencies.reconcileAndVerify({
        orderId: input.orderId,
        preflightId: input.preflightId,
        requestId: request.requestId,
        expectedManualReviewAt: input.expectedManualReviewAt,
        expectedAdmissionRefreshedAt: input.expectedAdmissionRefreshedAt,
    });
    const output = outputSchema.parse({ status: 'completed' });
    dependencies.writeStdout(`${JSON.stringify(output)}\n`);
    return Object.freeze(output);
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

async function directExecution(): Promise<void> {
    const originalConsole = {
        error: console.error,
        info: console.info,
        log: console.log,
        warn: console.warn,
    };
    console.error = () => undefined;
    console.info = () => undefined;
    console.log = () => undefined;
    console.warn = () => undefined;
    try {
        await runConciergeSnapshotConflictCompletion(process.argv.slice(2));
    } finally {
        Object.assign(console, originalConsole);
    }
}

if (isDirectExecution()) {
    directExecution().catch(() => {
        process.stderr.write(
            '{"status":"failed","errorCode":"CONCIERGE_SNAPSHOT_COMPLETION_FAILED"}\n',
        );
        process.exitCode = 1;
    });
}
