import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';
import {
    isEarlybirdAutoAdmissionEligible,
    readEarlybirdAutoAdmissionConfig,
} from './auto-admission-config';
import { isEarlybirdCheckoutRecoverableAt } from './recovery-window';
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
    seller_reference_confirmed_at: z.string().datetime({ offset: true }).nullable(),
    actual_amount_krw: z.number().int().nonnegative().nullable(),
    status: earlybirdOrderSystemStatusSchema,
    paid_at: z.string().datetime({ offset: true }).nullable(),
    due_at: z.string().datetime({ offset: true }).nullable(),
    plan_sequence: z.number().int().min(1).max(10).nullable(),
    result_request_id: z.string().uuid().nullable(),
    created_at: z.string().datetime({ offset: true }),
});

const checkoutRecoverablePreflightSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    target_instagram_id: z.string().min(1).max(30),
    status: z.enum(['ready', 'expired']),
    expires_at: z.string().datetime({ offset: true }),
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
        .select('id, user_id, preflight_id, target_instagram_id, plan_id, pricing_version, seller_reference_confirmed_at, actual_amount_krw, status, paid_at, due_at, plan_sequence, result_request_id, created_at')
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
    if (
        order.status === 'payment_pending'
        && isEarlybirdCheckoutRecoverableAt(order.created_at)
    ) {
        // Recovery is a server-computed capability, not a client-side age
        // decision. Prove that this order still points at the same owner's
        // bound, non-blocked preflight for the exact target before exposing the
        // continuation CTA. The preflight's 30-minute TTL is not the checkout
        // recovery window: the durable order may be resumed for 24 hours.
        const preflight = await supabaseAdmin
            .from('analysis_preflights')
            .select('id, user_id, target_instagram_id, status, expires_at')
            .eq('id', order.preflight_id)
            .eq('user_id', userId)
            .eq('target_instagram_id', order.target_instagram_id)
            .maybeSingle();
        if (!preflight.error) {
            const parsedPreflight = checkoutRecoverablePreflightSchema.safeParse(
                preflight.data,
            );
            if (
                parsedPreflight.success
                && (
                    parsedPreflight.data.status === 'ready'
                    || parsedPreflight.data.status === 'expired'
                )
                && parsedPreflight.data.id === order.preflight_id
                && parsedPreflight.data.user_id === userId
                && parsedPreflight.data.target_instagram_id === order.target_instagram_id
                && order.seller_reference_confirmed_at === null
            ) {
                try {
                    checkoutRecoverable = !await earlybirdStore.isCheckoutLineageSuperseded({
                        userId,
                        preflightId: order.preflight_id,
                        targetInstagramId: order.target_instagram_id,
                    });
                } catch {
                    // A lineage read failure must never expose a recovery CTA.
                    checkoutRecoverable = false;
                }
            }
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
