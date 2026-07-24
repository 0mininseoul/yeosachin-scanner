import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    markAnalysisV2FreshAdmissionDispatched,
    releaseAnalysisV2FreshAdmissionDispatch,
    reserveAnalysisV2FreshAdmission,
    type AnalysisV2FreshAdmissionReservation,
    type AnalysisV2FreshAdmissionRpcClient,
} from '@/lib/services/analysis/fresh-plan-admission';
import { enqueueFreshAdmissionTask } from '@/lib/services/analysis/preflight-tasks';
import { dispatchAnalysisV2Job } from '@/lib/services/analysis/v2-tasks';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const fulfillmentStatusSchema = z.enum([
    'awaiting_operator',
    'admission_pending',
    'analysis_in_progress',
    'completed',
    'retryable_failure',
    'manual_review',
]);
const identityRowSchema = z.object({
    order_id: uuidSchema,
    fulfillment_status: fulfillmentStatusSchema,
    preflight_id: uuidSchema,
    user_id: uuidSchema,
    plan_id: z.enum(['basic', 'standard']),
    request_id: uuidSchema.nullable(),
}).strict();
const identityRowsSchema = z.array(identityRowSchema).max(100);
const claimRowSchema = z.object({
    claimed: z.boolean(),
    fulfillment_status: fulfillmentStatusSchema,
    lease_token: uuidSchema.nullable(),
    lease_fence: z.number().int().min(0).safe(),
    attempt_count: z.number().int().min(0).max(10),
}).strict();
const requestRowSchema = z.object({
    order_id: uuidSchema,
    fulfillment_status: fulfillmentStatusSchema,
    request_id: uuidSchema.nullable(),
    created: z.boolean(),
    initial_job_key: z.literal('coordinator:bootstrap').nullable(),
}).strict();
const reconcileRowSchema = z.object({
    scanned: z.number().int().nonnegative().max(500),
    completed: z.number().int().nonnegative().max(500),
    manual_review: z.number().int().nonnegative().max(500),
    retryable: z.number().int().nonnegative().max(500),
}).strict();
const manualReviewCodeSchema = z.enum([
    'TARGET_UNAVAILABLE',
    'PLAN_NOT_ALLOWED',
    'PAYMENT_STATE',
    'SNAPSHOT_CONFLICT',
    'REQUEST_CONFLICT',
    'ACTIVE_REQUEST_CONFLICT',
    'ATTEMPT_EXHAUSTED',
]);

interface RpcResult {
    data: unknown;
    error: unknown;
}

export interface EarlybirdFulfillmentRpcClient {
    rpc(
        name: string,
        params: Record<string, unknown>
    ): PromiseLike<RpcResult>;
}

export type EarlybirdFulfillmentStatus = z.infer<
    typeof fulfillmentStatusSchema
>;
export type EarlybirdFulfillmentManualReviewCode = z.infer<
    typeof manualReviewCodeSchema
>;

export type EarlybirdFulfillmentIdentity = Readonly<{
    orderId: string;
    status: EarlybirdFulfillmentStatus;
    preflightId: string;
    userId: string;
    planId: 'basic' | 'standard';
    requestId: string | null;
}>;

export type EarlybirdFulfillmentClaim = Readonly<{
    claimed: boolean;
    status: EarlybirdFulfillmentStatus;
    claimToken: string | null;
    fence: number;
    attemptCount: number;
}>;

export type EarlybirdFulfillmentRequest = Readonly<{
    orderId: string;
    status: EarlybirdFulfillmentStatus;
    requestId: string | null;
    created: boolean;
    initialJobKey: 'coordinator:bootstrap' | null;
}>;

export type EarlybirdFulfillmentReconciliation = Readonly<{
    scanned: number;
    completed: number;
    manualReview: number;
    retryable: number;
}>;

export interface EarlybirdFulfillmentStore {
    admit(orderId: string): Promise<EarlybirdFulfillmentIdentity>;
    listRecoverable(limit: number): Promise<readonly EarlybirdFulfillmentIdentity[]>;
    claim(orderId: string): Promise<EarlybirdFulfillmentClaim>;
    createOrReplayRequest(
        claim: EarlybirdFulfillmentClaim & { orderId: string }
    ): Promise<EarlybirdFulfillmentRequest>;
    markManualReview(
        orderId: string,
        code: EarlybirdFulfillmentManualReviewCode
    ): Promise<'manual_review'>;
    reconcile(limit: number): Promise<EarlybirdFulfillmentReconciliation>;
}

export class EarlybirdFulfillmentError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = 'EarlybirdFulfillmentError';
        this.code = code;
    }
}

function persistenceError(): never {
    throw new EarlybirdFulfillmentError(
        'EARLYBIRD_FULFILLMENT_PERSISTENCE_ERROR'
    );
}

function oneRow<T>(
    data: unknown,
    schema: z.ZodType<T>
): T {
    const parsed = z.array(schema).length(1).safeParse(data);
    if (!parsed.success) persistenceError();
    return parsed.data[0];
}

function identityFromRow(
    row: z.infer<typeof identityRowSchema>
): EarlybirdFulfillmentIdentity {
    return Object.freeze({
        orderId: row.order_id,
        status: row.fulfillment_status,
        preflightId: row.preflight_id,
        userId: row.user_id,
        planId: row.plan_id,
        requestId: row.request_id,
    });
}

export function earlybirdFulfillmentAdmissionHash(orderId: string): string {
    const parsed = uuidSchema.safeParse(orderId);
    if (!parsed.success) {
        throw new EarlybirdFulfillmentError(
            'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
        );
    }
    return createHash('sha256')
        .update(
            `earlybird-fulfillment-admission-v1\n${parsed.data}`,
            'utf8'
        )
        .digest('hex');
}

export function createEarlybirdFulfillmentStore(
    dependencies: {
        rpc: EarlybirdFulfillmentRpcClient['rpc'];
        randomUuid: () => string;
    } = {
        rpc: (name, params) => supabaseAdmin.rpc(name, params),
        randomUuid: randomUUID,
    }
): EarlybirdFulfillmentStore {
    const validatedOrderId = (value: string) => {
        const parsed = uuidSchema.safeParse(value);
        if (!parsed.success) {
            throw new EarlybirdFulfillmentError(
                'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
            );
        }
        return parsed.data;
    };

    return {
        async admit(orderId) {
            const { data, error } = await dependencies.rpc(
                'admit_earlybird_fulfillment',
                { p_order_id: validatedOrderId(orderId) }
            );
            if (error) persistenceError();
            return identityFromRow(oneRow(data, identityRowSchema));
        },

        async listRecoverable(limit) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                throw new EarlybirdFulfillmentError(
                    'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
                );
            }
            const { data, error } = await dependencies.rpc(
                'list_recoverable_earlybird_fulfillments',
                { p_limit: limit }
            );
            if (error) persistenceError();
            const parsed = identityRowsSchema.safeParse(data);
            if (!parsed.success) persistenceError();
            return Object.freeze(parsed.data.map(identityFromRow));
        },

        async claim(orderId) {
            const proposedToken = uuidSchema.safeParse(
                dependencies.randomUuid()
            );
            if (!proposedToken.success) persistenceError();
            const { data, error } = await dependencies.rpc(
                'claim_earlybird_fulfillment',
                {
                    p_order_id: validatedOrderId(orderId),
                    p_lease_token: proposedToken.data,
                    p_lease_seconds: 300,
                }
            );
            if (error) persistenceError();
            const row = oneRow(data, claimRowSchema);
            if (
                row.claimed
                && (
                    row.fulfillment_status !== 'admission_pending'
                    || row.lease_token !== proposedToken.data
                    || row.lease_fence < 1
                    || row.attempt_count < 1
                )
            ) {
                persistenceError();
            }
            if (
                !row.claimed
                && (
                    row.fulfillment_status !== 'manual_review'
                    || row.lease_token !== null
                )
            ) {
                persistenceError();
            }
            return Object.freeze({
                claimed: row.claimed,
                status: row.fulfillment_status,
                claimToken: row.lease_token,
                fence: row.lease_fence,
                attemptCount: row.attempt_count,
            });
        },

        async createOrReplayRequest(claim) {
            if (
                !claim.claimed
                || !claim.claimToken
                || claim.fence < 1
            ) {
                throw new EarlybirdFulfillmentError(
                    'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
                );
            }
            const { data, error } = await dependencies.rpc(
                'create_or_replay_earlybird_fulfillment_request',
                {
                    p_order_id: validatedOrderId(claim.orderId),
                    p_lease_token: uuidSchema.parse(claim.claimToken),
                    p_lease_fence: claim.fence,
                }
            );
            if (error) persistenceError();
            const row = oneRow(data, requestRowSchema);
            if (
                row.order_id !== claim.orderId.toLowerCase()
                || (
                    row.fulfillment_status === 'analysis_in_progress'
                    && (!row.request_id || !row.initial_job_key)
                )
                || (
                    row.fulfillment_status === 'manual_review'
                    && (row.request_id !== null || row.initial_job_key !== null)
                )
            ) {
                persistenceError();
            }
            return Object.freeze({
                orderId: row.order_id,
                status: row.fulfillment_status,
                requestId: row.request_id,
                created: row.created,
                initialJobKey: row.initial_job_key,
            });
        },

        async markManualReview(orderId, code) {
            const parsedCode = manualReviewCodeSchema.safeParse(code);
            if (!parsedCode.success) {
                throw new EarlybirdFulfillmentError(
                    'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
                );
            }
            const { data, error } = await dependencies.rpc(
                'mark_earlybird_fulfillment_manual_review',
                {
                    p_order_id: validatedOrderId(orderId),
                    p_error_code: parsedCode.data,
                }
            );
            if (error || data !== 'manual_review') persistenceError();
            return 'manual_review';
        },

        async reconcile(limit) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
                throw new EarlybirdFulfillmentError(
                    'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
                );
            }
            const { data, error } = await dependencies.rpc(
                'reconcile_earlybird_fulfillments',
                { p_limit: limit }
            );
            if (error) persistenceError();
            const row = oneRow(data, reconcileRowSchema);
            if (
                row.completed + row.manual_review + row.retryable
                > row.scanned
            ) {
                persistenceError();
            }
            return Object.freeze({
                scanned: row.scanned,
                completed: row.completed,
                manualReview: row.manual_review,
                retryable: row.retryable,
            });
        },
    };
}

export const earlybirdFulfillmentStore =
    createEarlybirdFulfillmentStore();

export type EarlybirdFulfillmentAdvanceResult = Readonly<{
    orderId: string;
    status: EarlybirdFulfillmentStatus;
    requestId: string | null;
    nextAction:
        | 'wait_for_fresh_admission'
        | 'monitor_analysis'
        | 'completed'
        | 'manual_review';
}>;

export interface EarlybirdFulfillmentAdvanceDependencies {
    store: EarlybirdFulfillmentStore;
    reserveFreshAdmission(
        client: AnalysisV2FreshAdmissionRpcClient,
        input: {
            preflightId: string;
            userId: string;
            selectedPlanId: 'basic' | 'standard';
            entitlementJtiHash: string;
        }
    ): Promise<AnalysisV2FreshAdmissionReservation>;
    enqueueFreshAdmission(
        preflightId: string,
        generation: number,
        dispatchGeneration: number,
        dispatchToken: string
    ): Promise<unknown>;
    markFreshAdmissionDispatched(
        client: AnalysisV2FreshAdmissionRpcClient,
        input: {
            preflightId: string;
            userId: string;
            generation: number;
            dispatchGeneration: number;
            dispatchToken: string;
        }
    ): Promise<unknown>;
    releaseFreshAdmissionDispatch(
        client: AnalysisV2FreshAdmissionRpcClient,
        input: {
            preflightId: string;
            userId: string;
            generation: number;
            dispatchGeneration: number;
            dispatchToken: string;
        }
    ): Promise<unknown>;
    dispatchAnalysisJob(
        requestId: string,
        jobKey: string
    ): Promise<unknown>;
}

function defaultAdvanceDependencies(): EarlybirdFulfillmentAdvanceDependencies {
    return {
        store: earlybirdFulfillmentStore,
        reserveFreshAdmission: (client, input) => (
            reserveAnalysisV2FreshAdmission(client, input)
        ),
        enqueueFreshAdmission: (
            preflightId,
            generation,
            dispatchGeneration,
            dispatchToken
        ) => enqueueFreshAdmissionTask(
            preflightId,
            generation,
            dispatchGeneration,
            dispatchToken
        ),
        markFreshAdmissionDispatched: (client, input) => (
            markAnalysisV2FreshAdmissionDispatched(client, input)
        ),
        releaseFreshAdmissionDispatch: (client, input) => (
            releaseAnalysisV2FreshAdmissionDispatch(client, input)
        ),
        dispatchAnalysisJob: (requestId, jobKey) => (
            dispatchAnalysisV2Job(requestId, jobKey)
        ),
    };
}

function result(
    orderId: string,
    status: EarlybirdFulfillmentStatus,
    requestId: string | null,
    nextAction: EarlybirdFulfillmentAdvanceResult['nextAction']
): EarlybirdFulfillmentAdvanceResult {
    return Object.freeze({ orderId, status, requestId, nextAction });
}

export async function advanceAdmittedEarlybirdFulfillment(
    identity: EarlybirdFulfillmentIdentity,
    dependencies: EarlybirdFulfillmentAdvanceDependencies =
        defaultAdvanceDependencies()
): Promise<EarlybirdFulfillmentAdvanceResult> {
    if (identity.status === 'completed') {
        return result(
            identity.orderId,
            'completed',
            identity.requestId,
            'completed'
        );
    }
    if (identity.status === 'analysis_in_progress') {
        return result(
            identity.orderId,
            identity.status,
            identity.requestId,
            'monitor_analysis'
        );
    }
    if (identity.status === 'manual_review') {
        return result(
            identity.orderId,
            identity.status,
            identity.requestId,
            'manual_review'
        );
    }
    if (
        identity.status !== 'admission_pending'
        && identity.status !== 'retryable_failure'
    ) {
        throw new EarlybirdFulfillmentError(
            'EARLYBIRD_FULFILLMENT_OPERATOR_ADMISSION_REQUIRED'
        );
    }

    const admission = await dependencies.reserveFreshAdmission(
        supabaseAdmin,
        {
            preflightId: identity.preflightId,
            userId: identity.userId,
            selectedPlanId: identity.planId,
            entitlementJtiHash: earlybirdFulfillmentAdmissionHash(
                identity.orderId
            ),
        }
    );
    if (admission.state === 'pending') {
        if (
            admission.shouldEnqueue
            && admission.dispatchToken
        ) {
            const dispatchInput = {
                preflightId: identity.preflightId,
                userId: identity.userId,
                generation: admission.generation,
                dispatchGeneration: admission.dispatchGeneration,
                dispatchToken: admission.dispatchToken,
            };
            try {
                await dependencies.enqueueFreshAdmission(
                    identity.preflightId,
                    admission.generation,
                    admission.dispatchGeneration,
                    admission.dispatchToken
                );
                await dependencies.markFreshAdmissionDispatched(
                    supabaseAdmin,
                    dispatchInput
                );
            } catch (error) {
                await dependencies.releaseFreshAdmissionDispatch(
                    supabaseAdmin,
                    dispatchInput
                );
                throw error;
            }
        }
        return result(
            identity.orderId,
            'admission_pending',
            null,
            'wait_for_fresh_admission'
        );
    }
    if (
        admission.state === 'blocked'
        || !admission.selectedPlanAllowed
    ) {
        await dependencies.store.markManualReview(
            identity.orderId,
            admission.state === 'blocked'
                ? 'TARGET_UNAVAILABLE'
                : 'PLAN_NOT_ALLOWED'
        );
        return result(
            identity.orderId,
            'manual_review',
            null,
            'manual_review'
        );
    }

    const claim = await dependencies.store.claim(identity.orderId);
    if (!claim.claimed || !claim.claimToken) {
        return result(
            identity.orderId,
            'manual_review',
            null,
            'manual_review'
        );
    }
    const request = await dependencies.store.createOrReplayRequest({
        ...claim,
        orderId: identity.orderId,
    });
    if (
        request.status === 'manual_review'
        || !request.requestId
        || !request.initialJobKey
    ) {
        return result(
            identity.orderId,
            'manual_review',
            null,
            'manual_review'
        );
    }
    if (request.status === 'completed') {
        return result(
            identity.orderId,
            'completed',
            request.requestId,
            'completed'
        );
    }
    await dependencies.dispatchAnalysisJob(
        request.requestId,
        request.initialJobKey
    );
    return result(
        identity.orderId,
        'analysis_in_progress',
        request.requestId,
        'monitor_analysis'
    );
}

export async function admitAndAdvanceEarlybirdFulfillment(
    orderId: string,
    dependencies: EarlybirdFulfillmentAdvanceDependencies =
        defaultAdvanceDependencies()
): Promise<EarlybirdFulfillmentAdvanceResult> {
    const admitted = await dependencies.store.admit(orderId);
    return advanceAdmittedEarlybirdFulfillment(admitted, dependencies);
}

export type EarlybirdFulfillmentRecoverySummary = Readonly<{
    reconciled: EarlybirdFulfillmentReconciliation;
    scanned: number;
    advanced: number;
    failed: number;
}>;

export async function recoverEarlybirdFulfillments(
    dependencies: {
        store?: EarlybirdFulfillmentStore;
        advance?: (
            identity: EarlybirdFulfillmentIdentity
        ) => Promise<EarlybirdFulfillmentAdvanceResult>;
        limit?: number;
        concurrency?: number;
    } = {}
): Promise<EarlybirdFulfillmentRecoverySummary> {
    const fulfillmentStore = dependencies.store
        ?? earlybirdFulfillmentStore;
    const limit = dependencies.limit ?? 20;
    const concurrency = dependencies.concurrency ?? 2;
    if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 100
        || !Number.isSafeInteger(concurrency)
        || concurrency < 1
        || concurrency > 10
    ) {
        throw new EarlybirdFulfillmentError(
            'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
        );
    }
    const reconciled = await fulfillmentStore.reconcile(100);
    const rows = await fulfillmentStore.listRecoverable(limit);
    const advance = dependencies.advance
        ?? (identity => advanceAdmittedEarlybirdFulfillment(identity, {
            ...defaultAdvanceDependencies(),
            store: fulfillmentStore,
        }));
    let cursor = 0;
    let advanced = 0;
    let failed = 0;
    const worker = async () => {
        while (cursor < rows.length) {
            const row = rows[cursor++];
            try {
                await advance(row);
                advanced += 1;
            } catch {
                failed += 1;
            }
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, rows.length) },
            () => worker()
        )
    );
    return Object.freeze({
        reconciled,
        scanned: rows.length,
        advanced,
        failed,
    });
}
