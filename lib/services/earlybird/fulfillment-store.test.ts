import { describe, expect, it, vi } from 'vitest';
import { AnalysisV2FreshAdmissionError } from '@/lib/services/analysis/fresh-plan-admission';
import {
    advanceAdmittedEarlybirdFulfillment,
    createEarlybirdFulfillmentStore,
    earlybirdFulfillmentAdmissionHash,
    isEarlybirdAutomaticFulfillmentEnabled,
    recoverEarlybirdFulfillments,
    type EarlybirdFulfillmentIdentity,
    type EarlybirdFulfillmentStore,
} from './fulfillment-store';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';
const PREFLIGHT = '223e4567-e89b-42d3-a456-426614174001';
const USER = '323e4567-e89b-42d3-a456-426614174001';
const CLAIM = '423e4567-e89b-42d3-a456-426614174001'; // gitleaks:allow
const REQUEST = '523e4567-e89b-42d3-a456-426614174001';
const REBOUND_PREFLIGHT = '623e4567-e89b-42d3-a456-426614174001';
const OTHER_ORDER = '723e4567-e89b-42d3-a456-426614174001';

function identity(
    overrides: Partial<EarlybirdFulfillmentIdentity> = {}
): EarlybirdFulfillmentIdentity {
    return {
        orderId: ORDER,
        status: 'admission_pending',
        preflightId: PREFLIGHT,
        userId: USER,
        planId: 'basic',
        requestId: null,
        ...overrides,
    };
}

function rpcResult(data: unknown, error: unknown = null) {
    return Promise.resolve({ data, error });
}

function store(
    overrides: Partial<EarlybirdFulfillmentStore> = {}
): EarlybirdFulfillmentStore {
    return {
        admit: vi.fn(async () => identity()),
        autoAdmitEligible: vi.fn(async () => []),
        listRecoverable: vi.fn(async () => [identity()]),
        claim: vi.fn(async () => ({
            claimed: true,
            status: 'admission_pending' as const,
            claimToken: CLAIM,
            fence: 1,
            attemptCount: 1,
        })),
        createOrReplayRequest: vi.fn(async () => ({
            orderId: ORDER,
            status: 'analysis_in_progress' as const,
            requestId: REQUEST,
            created: true,
            initialJobKey: 'coordinator:bootstrap' as const,
        })),
        markManualReview: vi.fn(async () => 'manual_review' as const),
        recoverSchemaFailed: vi.fn(async () => ({
            orderId: ORDER,
            status: 'admission_pending' as const,
            preflightId: PREFLIGHT,
        })),
        reconcile: vi.fn(async () => ({
            scanned: 0,
            completed: 0,
            manualReview: 0,
            retryable: 0,
        })),
        ...overrides,
    };
}

describe('earlybird fulfillment store', () => {
    it('opens automatic fulfillment only for the exact true flag', () => {
        expect(isEarlybirdAutomaticFulfillmentEnabled({})).toBe(false);
        expect(isEarlybirdAutomaticFulfillmentEnabled({
            EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED: 'TRUE',
        })).toBe(false);
        expect(isEarlybirdAutomaticFulfillmentEnabled({
            EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED: 'true',
        })).toBe(true);
    });

    it('admits only opaque identities selected by the bounded automatic RPC', async () => {
        const rpc = vi.fn((name: string, params: Record<string, unknown>) => {
            expect(name).toBe('auto_admit_eligible_earlybird_fulfillments');
            expect(params).toEqual({ p_limit: 7 });
            return rpcResult([{
                order_id: ORDER,
                fulfillment_status: 'admission_pending',
                preflight_id: PREFLIGHT,
                user_id: USER,
                plan_id: 'basic',
                request_id: null,
            }]);
        });
        const fulfillmentStore = createEarlybirdFulfillmentStore({
            rpc,
            randomUuid: () => CLAIM,
        });

        await expect(fulfillmentStore.autoAdmitEligible(7)).resolves.toEqual([
            identity(),
        ]);
    });

    it('parses strict service-role RPC rows and never accepts extra buyer data', async () => {
        const rpc = vi.fn((name: string) => {
            if (name === 'admit_earlybird_fulfillment') {
                return rpcResult([{
                    order_id: ORDER,
                    fulfillment_status: 'admission_pending',
                    preflight_id: PREFLIGHT,
                    user_id: USER,
                    plan_id: 'basic',
                    request_id: null,
                }]);
            }
            if (name === 'list_recoverable_earlybird_fulfillments') {
                return rpcResult([]);
            }
            throw new Error(`unexpected ${name}`);
        });
        const fulfillmentStore = createEarlybirdFulfillmentStore({
            rpc,
            randomUuid: () => CLAIM,
        });
        await expect(fulfillmentStore.admit(ORDER)).resolves.toEqual(
            identity()
        );
        expect(rpc).toHaveBeenCalledWith('admit_earlybird_fulfillment', {
            p_order_id: ORDER,
        });

        const leaking = createEarlybirdFulfillmentStore({
            rpc: () => rpcResult([{
                order_id: ORDER,
                fulfillment_status: 'admission_pending',
                preflight_id: PREFLIGHT,
                user_id: USER,
                plan_id: 'basic',
                request_id: null,
                buyer_email: 'private@example.com',
            }]),
            randomUuid: () => CLAIM,
        });
        await expect(leaking.admit(ORDER)).rejects.toThrow(
            'EARLYBIRD_FULFILLMENT_PERSISTENCE_ERROR'
        );
    });

    it('derives one opaque admission identity without buyer or Instagram data', () => {
        expect(earlybirdFulfillmentAdmissionHash(ORDER)).toBe(
            '4f83b4613965a320bca79bb11a504ce5ebc79c1a80b2d97d4b3de82c4c8c4162'
        );
        expect(earlybirdFulfillmentAdmissionHash(ORDER)).not.toContain(
            'sample'
        );
    });

    it('queues fresh admission but does not claim or create analysis while it is pending', async () => {
        const fulfillmentStore = store();
        const enqueueFreshAdmission = vi.fn(async () => 'enqueued' as const);
        const markFreshAdmissionDispatched = vi.fn(async () => 'marked' as const);
        const emitOperationalEvent = vi.fn();
        const result = await advanceAdmittedEarlybirdFulfillment(identity(), {
            store: fulfillmentStore,
            rebindExpiredPaidPreflight: vi.fn(async () => PREFLIGHT),
            reserveFreshAdmission: vi.fn(async () => ({
                state: 'pending' as const,
                shouldEnqueue: true,
                generation: 2,
                dispatchGeneration: 1,
                dispatchToken: CLAIM,
            })),
            enqueueFreshAdmission,
            markFreshAdmissionDispatched,
            releaseFreshAdmissionDispatch: vi.fn(),
            dispatchAnalysisJob: vi.fn(),
            emitOperationalEvent,
        });

        expect(result).toEqual({
            orderId: ORDER,
            status: 'admission_pending',
            requestId: null,
            nextAction: 'wait_for_fresh_admission',
        });
        expect(enqueueFreshAdmission).toHaveBeenCalledWith(
            PREFLIGHT,
            2,
            1,
            CLAIM
        );
        expect(markFreshAdmissionDispatched).toHaveBeenCalledWith(
            expect.anything(),
            {
                preflightId: PREFLIGHT,
                userId: USER,
                generation: 2,
                dispatchGeneration: 1,
                dispatchToken: CLAIM,
            }
        );
        expect(fulfillmentStore.claim).not.toHaveBeenCalled();
        expect(emitOperationalEvent).toHaveBeenCalledWith({
            event: 'analysis_v2.fresh_admission_enqueued',
            severity: 'info',
            fields: {
                user_id: USER,
                preflight_id: PREFLIGHT,
                order_id: ORDER,
                plan_id: 'basic',
                operation: 'fresh_admission',
                disposition: 'enqueued',
            },
        });
    });

    it('claims only after fresh admission and creates before dispatching one request', async () => {
        const orderStore = store();
        const sequence: string[] = [];
        orderStore.claim = vi.fn(async () => {
            sequence.push('claim');
            return {
                claimed: true,
                status: 'admission_pending' as const,
                claimToken: CLAIM,
                fence: 1,
                attemptCount: 1,
            };
        });
        orderStore.createOrReplayRequest = vi.fn(async () => {
            sequence.push('create');
            return {
                orderId: ORDER,
                status: 'analysis_in_progress' as const,
                requestId: REQUEST,
                created: true,
                initialJobKey: 'coordinator:bootstrap' as const,
            };
        });
        const dispatchAnalysisJob = vi.fn(async () => {
            sequence.push('dispatch');
            return 'enqueued' as const;
        });
        const emitOperationalEvent = vi.fn();

        await expect(advanceAdmittedEarlybirdFulfillment(identity(), {
            store: orderStore,
            rebindExpiredPaidPreflight: vi.fn(async () => PREFLIGHT),
            reserveFreshAdmission: vi.fn(async () => ({
                state: 'ready' as const,
                generation: 2,
                selectedPlanAllowed: true,
                admissionToken: CLAIM,
                snapshot: {
                    followersCount: 120,
                    followingCount: 140,
                    capacityRequiredPlanId: 'basic' as const,
                    requiredPlanId: 'basic' as const,
                    selectedPlanId: 'basic' as const,
                    plans: [],
                    pricingVersion: 'deferred',
                    refreshedAt: '2026-07-24T00:00:00.000Z',
                },
            })),
            enqueueFreshAdmission: vi.fn(),
            markFreshAdmissionDispatched: vi.fn(),
            releaseFreshAdmissionDispatch: vi.fn(),
            dispatchAnalysisJob,
            emitOperationalEvent,
        })).resolves.toEqual({
            orderId: ORDER,
            status: 'analysis_in_progress',
            requestId: REQUEST,
            nextAction: 'monitor_analysis',
        });
        expect(sequence).toEqual(['claim', 'create', 'dispatch']);
        expect(dispatchAnalysisJob).toHaveBeenCalledWith(
            REQUEST,
            'coordinator:bootstrap'
        );
        expect(emitOperationalEvent).toHaveBeenCalledWith({
            event: 'analysis_v2.request_queued',
            severity: 'info',
            fields: {
                user_id: USER,
                preflight_id: PREFLIGHT,
                order_id: ORDER,
                analysis_request_id: REQUEST,
                job_key: 'coordinator:bootstrap',
                plan_id: 'basic',
                operation: 'enqueue',
                disposition: 'enqueued',
            },
        });
    });

    it('sends blocked or newly ineligible paid work to manual review', async () => {
        const orderStore = store();
        await expect(advanceAdmittedEarlybirdFulfillment(identity(), {
            store: orderStore,
            rebindExpiredPaidPreflight: vi.fn(async () => PREFLIGHT),
            reserveFreshAdmission: vi.fn(async () => ({
                state: 'blocked' as const,
                generation: 2,
                errorCode: 'ANALYSIS_V2_TARGET_PRIVATE' as const,
                snapshot: null,
            })),
            enqueueFreshAdmission: vi.fn(),
            markFreshAdmissionDispatched: vi.fn(),
            releaseFreshAdmissionDispatch: vi.fn(),
            dispatchAnalysisJob: vi.fn(),
        })).resolves.toMatchObject({
            status: 'manual_review',
            nextAction: 'manual_review',
        });
        expect(orderStore.markManualReview).toHaveBeenCalledWith(
            ORDER,
            'TARGET_UNAVAILABLE'
        );
        expect(orderStore.claim).not.toHaveBeenCalled();
    });

    it('recovery reconciles and advances admitted rows without calling operator admission', async () => {
        const orderStore = store();
        const advance = vi.fn(async () => ({
            orderId: ORDER,
            status: 'admission_pending' as const,
            requestId: null,
            nextAction: 'wait_for_fresh_admission' as const,
        }));
        await expect(recoverEarlybirdFulfillments({
            store: orderStore,
            advance,
            limit: 20,
            concurrency: 2,
            automaticFulfillmentEnabled: false,
        })).resolves.toEqual({
            reconciled: {
                scanned: 0,
                completed: 0,
                manualReview: 0,
                retryable: 0,
            },
            scanned: 1,
            advanced: 1,
            failed: 0,
        });
        expect(orderStore.listRecoverable).toHaveBeenCalledWith(20);
        expect(orderStore.admit).not.toHaveBeenCalled();
        expect(orderStore.autoAdmitEligible).not.toHaveBeenCalled();
    });

    it('recovery admits bounded confirmed paid work only when automatic fulfillment is enabled', async () => {
        const orderStore = store({
            autoAdmitEligible: vi.fn(async () => [identity()]),
            listRecoverable: vi.fn(async () => [identity()]),
        });
        const advance = vi.fn(async () => ({
            orderId: ORDER,
            status: 'admission_pending' as const,
            requestId: null,
            nextAction: 'wait_for_fresh_admission' as const,
        }));

        await recoverEarlybirdFulfillments({
            store: orderStore,
            advance,
            limit: 7,
            automaticFulfillmentEnabled: true,
        });

        expect(orderStore.autoAdmitEligible).toHaveBeenCalledWith(7);
        expect(orderStore.admit).not.toHaveBeenCalled();
        expect(advance).toHaveBeenCalledWith(identity());
    });

    it('rebinds an expired paid preflight during recovery and drives the replacement', async () => {
        const orderStore = store();
        const rebindExpiredPaidPreflight = vi.fn(async () => REBOUND_PREFLIGHT);
        const dispatchAnalysisJob = vi.fn(async () => 'enqueued' as const);
        const emitOperationalEvent = vi.fn();
        const reserveFreshAdmission = vi.fn(async (
            _client: unknown,
            input: { preflightId: string }
        ) => {
            if (input.preflightId !== REBOUND_PREFLIGHT) {
                throw new AnalysisV2FreshAdmissionError(
                    'ANALYSIS_V2_PREFLIGHT_EXPIRED'
                );
            }
            return {
                state: 'ready' as const,
                generation: 1,
                selectedPlanAllowed: true,
                admissionToken: CLAIM,
                snapshot: {
                    followersCount: 120,
                    followingCount: 140,
                    capacityRequiredPlanId: 'basic' as const,
                    requiredPlanId: 'basic' as const,
                    selectedPlanId: 'basic' as const,
                    plans: [],
                    pricingVersion: 'deferred',
                    refreshedAt: '2026-07-31T00:00:00.000Z',
                },
            };
        });

        await expect(recoverEarlybirdFulfillments({
            store: orderStore,
            advance: row => advanceAdmittedEarlybirdFulfillment(row, {
                store: orderStore,
                rebindExpiredPaidPreflight,
                reserveFreshAdmission,
                enqueueFreshAdmission: vi.fn(),
                markFreshAdmissionDispatched: vi.fn(),
                releaseFreshAdmissionDispatch: vi.fn(),
                dispatchAnalysisJob,
                emitOperationalEvent,
            }),
            automaticFulfillmentEnabled: false,
        })).resolves.toMatchObject({
            scanned: 1,
            advanced: 1,
            failed: 0,
        });

        expect(rebindExpiredPaidPreflight).toHaveBeenCalledWith(ORDER);
        expect(reserveFreshAdmission).toHaveBeenCalledTimes(2);
        expect(reserveFreshAdmission.mock.calls[0][1]).toMatchObject({
            preflightId: PREFLIGHT,
        });
        expect(reserveFreshAdmission.mock.calls[1][1]).toMatchObject({
            preflightId: REBOUND_PREFLIGHT,
        });
        expect(dispatchAnalysisJob).toHaveBeenCalledWith(
            REQUEST,
            'coordinator:bootstrap'
        );
        expect(emitOperationalEvent).toHaveBeenCalledWith({
            event: 'earlybird.paid_preflight_rebound',
            severity: 'warn',
            fields: {
                user_id: USER,
                preflight_id: REBOUND_PREFLIGHT,
                order_id: ORDER,
                plan_id: 'basic',
                operation: 'fresh_admission',
                disposition: 'retry',
            },
        });
        // The replacement preflight, not the retired one, is what the queued
        // analysis is reported against.
        expect(emitOperationalEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'analysis_v2.request_queued',
                fields: expect.objectContaining({
                    preflight_id: REBOUND_PREFLIGHT,
                }),
            })
        );
    });

    it('keeps draining the sweep when one row cannot be rebound', async () => {
        const strandedIdentity = identity({ orderId: OTHER_ORDER });
        const orderStore = store({
            listRecoverable: vi.fn(async () => [strandedIdentity, identity()]),
        });
        const rebindExpiredPaidPreflight = vi.fn(async (orderId: string) => {
            if (orderId === OTHER_ORDER) {
                throw new Error('EARLYBIRD_FULFILLMENT_PERSISTENCE_ERROR');
            }
            return PREFLIGHT;
        });
        const reserveFreshAdmission = vi.fn(async () => {
            throw new AnalysisV2FreshAdmissionError(
                'ANALYSIS_V2_PREFLIGHT_EXPIRED'
            );
        });

        await expect(recoverEarlybirdFulfillments({
            store: orderStore,
            advance: row => advanceAdmittedEarlybirdFulfillment(row, {
                store: orderStore,
                rebindExpiredPaidPreflight,
                reserveFreshAdmission: row.orderId === OTHER_ORDER
                    ? reserveFreshAdmission
                    : vi.fn(async () => ({
                        state: 'pending' as const,
                        shouldEnqueue: false,
                        generation: 1,
                        dispatchGeneration: 0,
                        dispatchToken: null,
                    })),
                enqueueFreshAdmission: vi.fn(),
                markFreshAdmissionDispatched: vi.fn(),
                releaseFreshAdmissionDispatch: vi.fn(),
                dispatchAnalysisJob: vi.fn(),
            }),
            concurrency: 1,
            automaticFulfillmentEnabled: false,
        })).resolves.toMatchObject({
            scanned: 2,
            advanced: 1,
            failed: 1,
        });

        expect(rebindExpiredPaidPreflight).toHaveBeenCalledWith(OTHER_ORDER);
        expect(rebindExpiredPaidPreflight).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original expiry, not the rebind refusal, when nothing is rebound', async () => {
        const orderStore = store();
        await expect(advanceAdmittedEarlybirdFulfillment(identity(), {
            store: orderStore,
            // The database returns the preflight the order already points at
            // whenever it refuses to rebind, including past the retry cap.
            rebindExpiredPaidPreflight: vi.fn(async () => PREFLIGHT),
            reserveFreshAdmission: vi.fn(async () => {
                throw new AnalysisV2FreshAdmissionError(
                    'ANALYSIS_V2_PREFLIGHT_EXPIRED'
                );
            }),
            enqueueFreshAdmission: vi.fn(),
            markFreshAdmissionDispatched: vi.fn(),
            releaseFreshAdmissionDispatch: vi.fn(),
            dispatchAnalysisJob: vi.fn(),
        })).rejects.toThrow('ANALYSIS_V2_PREFLIGHT_EXPIRED');
        expect(orderStore.claim).not.toHaveBeenCalled();
    });

    it('does not rebind an admission that failed for any other reason', async () => {
        const rebindExpiredPaidPreflight = vi.fn(async () => REBOUND_PREFLIGHT);
        await expect(advanceAdmittedEarlybirdFulfillment(identity(), {
            store: store(),
            rebindExpiredPaidPreflight,
            reserveFreshAdmission: vi.fn(async () => {
                throw new AnalysisV2FreshAdmissionError(
                    'ANALYSIS_V2_PREFLIGHT_NOT_FOUND'
                );
            }),
            enqueueFreshAdmission: vi.fn(),
            markFreshAdmissionDispatched: vi.fn(),
            releaseFreshAdmissionDispatch: vi.fn(),
            dispatchAnalysisJob: vi.fn(),
        })).rejects.toThrow('ANALYSIS_V2_PREFLIGHT_NOT_FOUND');
        expect(rebindExpiredPaidPreflight).not.toHaveBeenCalled();
    });
});
