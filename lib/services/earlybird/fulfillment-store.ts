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
import { operationalLogger } from '@/lib/observability/server';
import type { OperationalEvent } from '@/lib/observability/schema';

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
const schemaFailureRecoveryRowSchema = z.object({
    order_id: uuidSchema,
    fulfillment_status: fulfillmentStatusSchema,
    preflight_id: uuidSchema,
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

export type EarlybirdSchemaFailureRecovery = Readonly<{
    orderId: string;
    status: EarlybirdFulfillmentStatus;
    preflightId: string;
}>;

export type EarlybirdFulfillmentReconciliation = Readonly<{
    scanned: number;
    completed: number;
    manualReview: number;
    retryable: number;
}>;

export interface EarlybirdFulfillmentStore {
    admit(orderId: string): Promise<EarlybirdFulfillmentIdentity>;
    autoAdmitEligible(limit: number): Promise<readonly EarlybirdFulfillmentIdentity[]>;
    listRecoverable(limit: number): Promise<readonly EarlybirdFulfillmentIdentity[]>;
    claim(orderId: string): Promise<EarlybirdFulfillmentClaim>;
    createOrReplayRequest(
        claim: EarlybirdFulfillmentClaim & { orderId: string }
    ): Promise<EarlybirdFulfillmentRequest>;
    markManualReview(
        orderId: string,
        code: EarlybirdFulfillmentManualReviewCode
    ): Promise<'manual_review'>;
    recoverSchemaFailed(
        orderId: string
    ): Promise<EarlybirdSchemaFailureRecovery>;
    recoverFreshAdmissionProviderFailure(
        orderId: string
    ): Promise<EarlybirdFulfillmentIdentity>;
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

export function isEarlybirdAutomaticFulfillmentEnabled(
    environment: Record<string, string | undefined> = process.env
): boolean {
    return environment.EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED === 'true';
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

        async autoAdmitEligible(limit) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                throw new EarlybirdFulfillmentError(
                    'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
                );
            }
            const { data, error } = await dependencies.rpc(
                'auto_admit_eligible_earlybird_fulfillments',
                { p_limit: limit }
            );
            if (error) persistenceError();
            const parsed = identityRowsSchema.safeParse(data);
            if (!parsed.success || parsed.data.some(
                row => row.fulfillment_status !== 'admission_pending'
            )) {
                persistenceError();
            }
            return Object.freeze(parsed.data.map(identityFromRow));
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

        async recoverSchemaFailed(orderId) {
            const parsedOrderId = validatedOrderId(orderId);
            const { data, error } = await dependencies.rpc(
                'recover_earlybird_schema_failed_fulfillment',
                { p_order_id: parsedOrderId }
            );
            if (error) persistenceError();
            const row = oneRow(data, schemaFailureRecoveryRowSchema);
            if (row.order_id !== parsedOrderId) persistenceError();
            return Object.freeze({
                orderId: row.order_id,
                status: row.fulfillment_status,
                preflightId: row.preflight_id,
            });
        },

        async recoverFreshAdmissionProviderFailure(orderId) {
            const parsedOrderId = validatedOrderId(orderId);
            const { data, error } = await dependencies.rpc(
                'recover_earlybird_fresh_admission_provider_failure',
                { p_order_id: parsedOrderId }
            );
            if (error) persistenceError();
            const row = oneRow(data, identityRowSchema);
            const isRecovered = row.fulfillment_status === 'retryable_failure'
                && row.request_id === null;
            const isIdempotentReplay = (
                row.fulfillment_status === 'analysis_in_progress'
                || row.fulfillment_status === 'completed'
            ) && row.request_id !== null;
            if (
                row.order_id !== parsedOrderId
                || (!isRecovered && !isIdempotentReplay)
            ) {
                persistenceError();
            }
            return identityFromRow(row);
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
    /**
     * Moves a paid order off a preflight that outlived its immutable
     * thirty-minute TTL and onto a fresh one, returning the preflight the order
     * points at afterwards. Returns the current preflight id unchanged when the
     * order is not in a shape the database is willing to rebind.
     */
    rebindExpiredPaidPreflight(orderId: string): Promise<string>;
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
    emitOperationalEvent?: (event: OperationalEvent) => void;
}

export async function rebindExpiredPaidEarlybirdPreflight(
    orderId: string,
    client: EarlybirdFulfillmentRpcClient = supabaseAdmin
): Promise<string> {
    const parsedOrderId = uuidSchema.safeParse(orderId);
    if (!parsedOrderId.success) {
        throw new EarlybirdFulfillmentError(
            'EARLYBIRD_FULFILLMENT_INPUT_INVALID'
        );
    }
    const { data, error } = await client.rpc(
        'rebind_expired_paid_earlybird_preflight',
        { p_order_id: parsedOrderId.data }
    );
    if (error) persistenceError();
    const parsed = uuidSchema.safeParse(data);
    if (!parsed.success) persistenceError();
    return parsed.data;
}

function defaultAdvanceDependencies(): EarlybirdFulfillmentAdvanceDependencies {
    return {
        store: earlybirdFulfillmentStore,
        rebindExpiredPaidPreflight: orderId => (
            rebindExpiredPaidEarlybirdPreflight(orderId)
        ),
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
        emitOperationalEvent: event => operationalLogger.emit(event),
    };
}

/**
 * `reserve_analysis_v2_preflight_admission` raises this the moment a preflight
 * outlives its immutable thirty-minute TTL. Matched structurally rather than by
 * class so an injected reservation double signals it the same way.
 */
function isPreflightExpiredError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return (error as { code?: unknown }).code === 'ANALYSIS_V2_PREFLIGHT_EXPIRED'
        || error.message === 'ANALYSIS_V2_PREFLIGHT_EXPIRED';
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
    const emitOperationalEvent = dependencies.emitOperationalEvent
        ?? (event => operationalLogger.emit(event));
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

    const admissionInput = (preflightId: string) => ({
        preflightId,
        userId: identity.userId,
        selectedPlanId: identity.planId,
        entitlementJtiHash: earlybirdFulfillmentAdmissionHash(
            identity.orderId
        ),
    });

    // Recovery reaches an already-admitted paid order through `listRecoverable`,
    // which never passes back through the `awaiting_operator` admission sweep
    // where rebinding already runs. A paid order whose preflight expired before
    // its analysis started therefore only ever surfaces here, as a reservation
    // that raises `ANALYSIS_V2_PREFLIGHT_EXPIRED` on every sweep forever.
    let activePreflightId = identity.preflightId;
    let admission: AnalysisV2FreshAdmissionReservation;
    try {
        admission = await dependencies.reserveFreshAdmission(
            supabaseAdmin,
            admissionInput(activePreflightId)
        );
    } catch (error) {
        if (!isPreflightExpiredError(error)) throw error;
        // Rebinding is best effort. When the database refuses, caps, or fails
        // outright, the original expiry stands and only this row counts as
        // failed, exactly as it did before — the rest of the sweep drains.
        let rebound: string | null = null;
        try {
            rebound = await dependencies.rebindExpiredPaidPreflight(
                identity.orderId
            );
        } catch {
            rebound = null;
        }
        if (rebound === null || rebound === activePreflightId) {
            // The strand is now permanent for this order: it has hit the rebind
            // cap, the database refused, or the call failed. Rethrowing alone
            // reports only the expiry, which is the symptom every sweep already
            // logs — say that rebinding is what gave up, or an operator chasing
            // a paid order has no way to tell the two apart.
            emitOperationalEvent({
                event: 'earlybird.paid_preflight_rebound',
                severity: 'warn',
                fields: {
                    user_id: identity.userId,
                    preflight_id: activePreflightId,
                    order_id: identity.orderId,
                    plan_id: identity.planId,
                    operation: 'fresh_admission',
                    disposition: 'failure',
                },
            });
            throw error;
        }
        activePreflightId = rebound;
        emitOperationalEvent({
            event: 'earlybird.paid_preflight_rebound',
            severity: 'warn',
            fields: {
                user_id: identity.userId,
                preflight_id: activePreflightId,
                order_id: identity.orderId,
                plan_id: identity.planId,
                operation: 'fresh_admission',
                disposition: 'retry',
            },
        });
        admission = await dependencies.reserveFreshAdmission(
            supabaseAdmin,
            admissionInput(activePreflightId)
        );
    }
    if (admission.state === 'pending') {
        if (
            admission.shouldEnqueue
            && admission.dispatchToken
        ) {
            const dispatchInput = {
                preflightId: activePreflightId,
                userId: identity.userId,
                generation: admission.generation,
                dispatchGeneration: admission.dispatchGeneration,
                dispatchToken: admission.dispatchToken,
            };
            try {
                await dependencies.enqueueFreshAdmission(
                    activePreflightId,
                    admission.generation,
                    admission.dispatchGeneration,
                    admission.dispatchToken
                );
                await dependencies.markFreshAdmissionDispatched(
                    supabaseAdmin,
                    dispatchInput
                );
                emitOperationalEvent({
                    event: 'analysis_v2.fresh_admission_enqueued',
                    severity: 'info',
                    fields: {
                        user_id: identity.userId,
                        preflight_id: activePreflightId,
                        order_id: identity.orderId,
                        plan_id: identity.planId,
                        operation: 'fresh_admission',
                        disposition: 'enqueued',
                    },
                });
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
    // The database may see the two-minute admission freshness boundary pass
    // between the successful reservation above and this leased create. That is
    // a retryable race, not an evidence conflict: wait for the next admission
    // refresh without dispatching or converting the paid order to manual review.
    if (request.status === 'retryable_failure') {
        return result(
            identity.orderId,
            'retryable_failure',
            null,
            'wait_for_fresh_admission'
        );
    }
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
    const dispatchOutcome = await dependencies.dispatchAnalysisJob(
        request.requestId,
        request.initialJobKey
    );
    emitOperationalEvent({
        event: 'analysis_v2.request_queued',
        severity: 'info',
        fields: {
            user_id: identity.userId,
            preflight_id: activePreflightId,
            order_id: identity.orderId,
            analysis_request_id: request.requestId,
            job_key: request.initialJobKey,
            plan_id: identity.planId,
            operation: 'enqueue',
            disposition: dispatchOutcome === 'already_dispatched' ? 'exists' : 'enqueued',
        },
    });
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

export async function recoverAndAdvanceEarlybirdSchemaFailedFulfillment(
    orderId: string,
    dependencies: EarlybirdFulfillmentAdvanceDependencies =
        defaultAdvanceDependencies()
): Promise<EarlybirdFulfillmentAdvanceResult> {
    await dependencies.store.recoverSchemaFailed(orderId);
    return admitAndAdvanceEarlybirdFulfillment(orderId, dependencies);
}

export async function recoverAndAdvanceEarlybirdFreshAdmissionProviderFailure(
    orderId: string,
    dependencies: EarlybirdFulfillmentAdvanceDependencies =
        defaultAdvanceDependencies()
): Promise<EarlybirdFulfillmentAdvanceResult> {
    const recovered = await dependencies.store
        .recoverFreshAdmissionProviderFailure(orderId);
    return advanceAdmittedEarlybirdFulfillment(recovered, dependencies);
}

export type EarlybirdFulfillmentRecoverySummary = Readonly<{
    reconciled: EarlybirdFulfillmentReconciliation;
    scanned: number;
    advanced: number;
    failed: number;
}>;

/**
 * Postgres errors surface their `P0001` message as `code`; application errors
 * carry the contract name on `code` too. Fall back to the message so a failure
 * is never reported as an unnamed one.
 */
function extractOperationalErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        const candidate = error as { code?: unknown; message?: unknown };
        if (typeof candidate.code === 'string' && candidate.code.length > 0) {
            return candidate.code;
        }
        if (typeof candidate.message === 'string' && candidate.message.length > 0) {
            return candidate.message;
        }
    }
    return 'UNKNOWN';
}

export async function recoverEarlybirdFulfillments(
    dependencies: {
        store?: EarlybirdFulfillmentStore;
        automaticFulfillmentEnabled?: boolean;
        advance?: (
            identity: EarlybirdFulfillmentIdentity
        ) => Promise<EarlybirdFulfillmentAdvanceResult>;
        limit?: number;
        concurrency?: number;
        emitOperationalEvent?: (event: OperationalEvent) => void;
    } = {}
): Promise<EarlybirdFulfillmentRecoverySummary> {
    const emitRecoveryEvent = dependencies.emitOperationalEvent
        ?? (event => operationalLogger.emit(event));
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
    let failed = 0;
    if (
        dependencies.automaticFulfillmentEnabled
        ?? isEarlybirdAutomaticFulfillmentEnabled()
    ) {
        try {
            await fulfillmentStore.autoAdmitEligible(limit);
        } catch {
            // A temporary admission sweep failure must not stop already-admitted work draining.
            failed += 1;
        }
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
    const worker = async () => {
        while (cursor < rows.length) {
            const row = rows[cursor++];
            try {
                await advance(row);
                advanced += 1;
            } catch (error) {
                failed += 1;
                // This counter is the only thing a swallowed advance used to
                // produce: the sweep returns a non-zero `failed`, the recovery
                // route turns that into a 500, and the reason never reaches a
                // log. A paid order can then retry for hours while every
                // signal says only "something failed". Name the failure.
                emitRecoveryEvent({
                    event: 'earlybird.advance_failed',
                    severity: 'error',
                    fields: {
                        order_id: row.orderId,
                        user_id: row.userId,
                        plan_id: row.planId,
                        preflight_id: row.preflightId,
                        operation: 'fresh_admission',
                        disposition: 'failure',
                        error_name: error instanceof Error
                            ? error.name
                            : typeof error,
                        error_code: extractOperationalErrorCode(error),
                    },
                });
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
