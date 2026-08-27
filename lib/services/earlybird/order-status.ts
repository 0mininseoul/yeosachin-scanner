import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';
import {
    isEarlybirdAutoAdmissionEligible,
    readEarlybirdAutoAdmissionConfig,
} from './auto-admission-config';
import {
    isEarlybirdCheckoutRecordRecoverable,
    loadCurrentEarlybirdCheckoutPhone,
} from './checkout';
import { earlybirdStore } from './store';

export const earlybirdOrderSystemStatusSchema = z.enum([
    'payment_pending',
    'payment_failed',
    'paid',
    'analysis_in_progress',
    'completed',
    'overflow_refund_required',
    'cancelled',
    'refund_pending',
    'refunded',
]);

export type EarlybirdOrderSystemStatus = z.infer<typeof earlybirdOrderSystemStatusSchema>;

const orderRowSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    preflight_id: z.string().uuid(),
    target_instagram_id: z.string().min(1).max(30),
    plan_id: z.enum(['basic', 'standard']),
    pricing_version: z.string().min(1).max(64),
    expected_amount_krw: z.number().int().positive(),
    expected_groble_product_id: z.string().min(1).max(128),
    buyer_match_policy: z.string().min(1).max(64),
    expected_buyer_phone_number_normalized: z.string().min(1).max(32).nullable(),
    expected_buyer_phone_verification_source: z.string().min(1).max(64).nullable(),
    disclosure_version: z.string().min(1).max(64),
    disclosure_text: z.string().min(1).max(1_000),
    disclosure_accepted_at: z.string().datetime({ offset: true }),
    groble_seller_reference: z.string().regex(/^ord\.[a-f0-9]{32}$/).nullable(),
    seller_reference_confirmed_at: z.string().datetime({ offset: true }).nullable(),
    actual_groble_product_id: z.string().min(1).max(128).nullable(),
    payment_id: z.string().nullable(),
    actual_amount_krw: z.number().int().nonnegative().nullable(),
    status: earlybirdOrderSystemStatusSchema,
    paid_at: z.string().datetime({ offset: true }).nullable(),
    due_at: z.string().datetime({ offset: true }).nullable(),
    plan_sequence: z.number().int().min(1).max(10).nullable(),
    result_request_id: z.string().uuid().nullable(),
    checkout_blocked_at: z.string().datetime({ offset: true }).nullable(),
    checkout_blocked_reason: z.literal('SUPERSEDED_LINEAGE').nullable(),
    created_at: z.string().datetime({ offset: true }),
});

const resultRowSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    status: z.enum(['pending', 'processing', 'completed', 'failed']),
});

const fulfillmentStatusSchema = z.enum([
    'awaiting_operator',
    'admission_pending',
    'analysis_in_progress',
    'completed',
    'retryable_failure',
    'manual_review',
]);

const AUTOMATIC_FULFILLMENT_STATUSES = new Set([
    'admission_pending',
    'analysis_in_progress',
    'retryable_failure',
]);

export const earlybirdDeliveryModeSchema = z.enum([
    'automatic',
    'concierge',
    'support',
]);

export type EarlybirdDeliveryMode = z.infer<typeof earlybirdDeliveryModeSchema>;

const DISPLAY_STATUS: Readonly<Record<EarlybirdOrderSystemStatus, string>> = {
    payment_pending: '결제 확인',
    payment_failed: '결제 확인 실패',
    paid: '판독 대기',
    analysis_in_progress: '판독 중',
    completed: '결과 전달 완료',
    overflow_refund_required: '환불 확인 필요',
    cancelled: '취소됨',
    refund_pending: '환불 처리 중',
    refunded: '환불 완료',
};

const PLAN_NAMES = { basic: 'Basic', standard: 'Standard' } as const;

export interface EarlybirdOrderStatusDto {
    orderId: string;
    preflightId: string;
    targetInstagramId: string;
    planId: 'basic' | 'standard';
    planName: 'Basic' | 'Standard';
    actualAmountKrw: number | null;
    acceptedAt: string | null;
    dueAt: string | null;
    planSequence: number | null;
    systemStatus: EarlybirdOrderSystemStatus;
    displayStatus: string;
    requiresSupport: boolean;
    deliveryMode: EarlybirdDeliveryMode;
    checkoutRecoverable: boolean;
    progressUrl: string | null;
    resultUrl: string | null;
}

export class EarlybirdOrderLookupError extends Error {
    constructor() {
        super('EARLYBIRD_ORDER_LOOKUP_FAILED');
        this.name = 'EarlybirdOrderLookupError';
    }
}

export async function loadLatestEarlybirdOrder(
    userId: string,
    planId?: 'basic' | 'standard'
): Promise<EarlybirdOrderStatusDto | null> {
    let query = supabaseAdmin
        .from('earlybird_orders')
        .select('id, user_id, preflight_id, target_instagram_id, plan_id, pricing_version, expected_amount_krw, expected_groble_product_id, buyer_match_policy, expected_buyer_phone_number_normalized, expected_buyer_phone_verification_source, disclosure_version, disclosure_text, disclosure_accepted_at, groble_seller_reference, seller_reference_confirmed_at, actual_groble_product_id, payment_id, actual_amount_krw, status, paid_at, due_at, plan_sequence, result_request_id, checkout_blocked_at, checkout_blocked_reason, created_at')
        .eq('user_id', userId);
    if (planId) query = query.eq('plan_id', planId);
    const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw new EarlybirdOrderLookupError();
    if (!data) return null;

    const parsed = orderRowSchema.safeParse(data);
    if (!parsed.success || parsed.data.user_id !== userId) {
        throw new EarlybirdOrderLookupError();
    }
    const order = parsed.data;
    let checkoutRecoverable = false;
    if (order.status === 'payment_pending') {
        // Keep this capability exactly aligned with the redirect/recovery
        // authority. In particular, do not derive it from the mutable
        // preflight TTL or a browser navigation hint.
        try {
            const superseded = await earlybirdStore.isCheckoutLineageSuperseded({
                userId,
                preflightId: order.preflight_id,
                targetInstagramId: order.target_instagram_id,
                checkoutBlockedAt: order.checkout_blocked_at,
                checkoutBlockedReason: order.checkout_blocked_reason,
            });
            if (!superseded) {
                const currentPhone = await loadCurrentEarlybirdCheckoutPhone(userId);
                checkoutRecoverable = isEarlybirdCheckoutRecordRecoverable({
                    orderId: order.id,
                    userId: order.user_id,
                    preflightId: order.preflight_id,
                    targetInstagramId: order.target_instagram_id,
                    planId: order.plan_id,
                    pricingVersion: order.pricing_version,
                    expectedAmountKrw: order.expected_amount_krw,
                    expectedProductId: order.expected_groble_product_id,
                    buyerMatchPolicy: order.buyer_match_policy,
                    expectedBuyerPhoneNumberNormalized:
                        order.expected_buyer_phone_number_normalized,
                    expectedBuyerPhoneVerificationSource:
                        order.expected_buyer_phone_verification_source,
                    disclosureVersion: order.disclosure_version,
                    disclosureText: order.disclosure_text,
                    disclosureAcceptedAt: order.disclosure_accepted_at,
                    sellerReference: order.groble_seller_reference,
                    sellerReferenceConfirmedAt: order.seller_reference_confirmed_at,
                    status: order.status,
                    paymentId: order.payment_id,
                    actualGrobleProductId: order.actual_groble_product_id,
                    actualAmountKrw: order.actual_amount_krw,
                    paidAt: order.paid_at,
                    checkoutBlockedAt: order.checkout_blocked_at,
                    checkoutBlockedReason: order.checkout_blocked_reason,
                    createdAt: order.created_at,
                }, {
                    userId,
                    planId: order.plan_id,
                    targetInstagramId: order.target_instagram_id,
                    currentPhone,
                });
            }
        } catch {
            // A phone, marker, or authoritative gate read failure must never
            // expose a recovery CTA.
            checkoutRecoverable = false;
        }
    }

    let requiresSupport = false;
    let deliveryMode: EarlybirdDeliveryMode = 'concierge';
    let publicationLag = false;
    if (order.status === 'paid' || order.status === 'analysis_in_progress') {
        const fulfillment = await supabaseAdmin.rpc(
            'load_earlybird_fulfillment_status',
            { p_order_id: order.id }
        );
        // A fulfillment-state lookup must never leave a paid customer in an
        // infinite return-page refresh. The fallback is deliberately generic:
        // no internal failure state reaches the owner-facing DTO.
        if (fulfillment.error) {
            requiresSupport = true;
            deliveryMode = 'support';
        } else {
            const parsedFulfillmentStatus = fulfillmentStatusSchema.safeParse(
                fulfillment.data
            );
            if (!parsedFulfillmentStatus.success) {
                requiresSupport = true;
                deliveryMode = 'support';
            } else if (parsedFulfillmentStatus.data === 'manual_review') {
                requiresSupport = true;
                deliveryMode = 'support';
            } else if (
                AUTOMATIC_FULFILLMENT_STATUSES.has(parsedFulfillmentStatus.data)
            ) {
                deliveryMode = 'automatic';
            } else if (parsedFulfillmentStatus.data === 'completed') {
                // The completion publisher can commit fulfillment before the
                // order projection catches up. Keep that observable lag in
                // the owner-scoped automatic progress UX.
                deliveryMode = 'automatic';
            } else if (parsedFulfillmentStatus.data === 'awaiting_operator') {
                try {
                    const autoAdmissionConfig = readEarlybirdAutoAdmissionConfig();
                    if (isEarlybirdAutoAdmissionEligible(
                        order.paid_at,
                        autoAdmissionConfig,
                    )) {
                        // The payment finalizer commits awaiting_operator before
                        // the webhook's synchronous admission call. Keep this
                        // eligible handoff in the automatic polling UX.
                        deliveryMode = 'automatic';
                    }
                } catch {
                    // An invalid gate must never silently widen automatic
                    // admission. Stop polling and use the generic support UX.
                    requiresSupport = true;
                    deliveryMode = 'support';
                }
            }
        }
    }

    let effectiveStatus = order.status;
    let resultUrl: string | null = null;
    if (order.status === 'completed' && order.result_request_id) {
        const result = await supabaseAdmin
            .from('analysis_requests')
            .select('id, user_id, status')
            .eq('id', order.result_request_id)
            .eq('user_id', userId)
            .eq('status', 'completed')
            .maybeSingle();
        if (result.error) throw new EarlybirdOrderLookupError();
        const parsedResult = resultRowSchema.safeParse(result.data);
        if (parsedResult.success && parsedResult.data.user_id === userId) {
            const published = parsedResult.data.status === 'completed'
                && await isAnalysisResultAuthoritativelyPublished(parsedResult.data.id);
            if (published) {
                resultUrl = `/result/${encodeURIComponent(parsedResult.data.id)}`;
            } else {
                // The persisted order can lag the fulfillment publication
                // contract. Keep this owner-facing snapshot in the waiting
                // UX until the request is authoritatively published.
                effectiveStatus = 'analysis_in_progress';
                publicationLag = true;
            }
        } else {
            effectiveStatus = 'analysis_in_progress';
            publicationLag = true;
        }
    }

    const progressUrl = (deliveryMode === 'automatic' || publicationLag)
        && !requiresSupport
        && (effectiveStatus === 'paid' || effectiveStatus === 'analysis_in_progress')
        && order.result_request_id
        ? `/progress/${encodeURIComponent(order.result_request_id)}`
        : null;

    return Object.freeze({
        orderId: order.id,
        preflightId: order.preflight_id,
        targetInstagramId: order.target_instagram_id,
        planId: order.plan_id,
        planName: PLAN_NAMES[order.plan_id],
        actualAmountKrw: order.actual_amount_krw,
        acceptedAt: order.paid_at,
        dueAt: order.due_at,
        planSequence: order.plan_sequence,
        systemStatus: effectiveStatus,
        displayStatus: DISPLAY_STATUS[effectiveStatus],
        requiresSupport,
        deliveryMode,
        checkoutRecoverable,
        progressUrl,
        resultUrl,
    });
}
