import { describe, expect, it, vi } from 'vitest';
import {
    advanceAdmittedEarlybirdFulfillment,
    createEarlybirdFulfillmentStore,
    earlybirdFulfillmentAdmissionHash,
    recoverEarlybirdFulfillments,
    type EarlybirdFulfillmentIdentity,
    type EarlybirdFulfillmentStore,
} from './fulfillment-store';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';
const PREFLIGHT = '223e4567-e89b-42d3-a456-426614174001';
const USER = '323e4567-e89b-42d3-a456-426614174001';
const CLAIM = '423e4567-e89b-42d3-a456-426614174001'; // gitleaks:allow
const REQUEST = '523e4567-e89b-42d3-a456-426614174001';

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
        const result = await advanceAdmittedEarlybirdFulfillment(identity(), {
            store: fulfillmentStore,
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

        await expect(advanceAdmittedEarlybirdFulfillment(identity(), {
            store: orderStore,
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
    });

    it('sends blocked or newly ineligible paid work to manual review', async () => {
        const orderStore = store();
        await expect(advanceAdmittedEarlybirdFulfillment(identity(), {
            store: orderStore,
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
    });
});
