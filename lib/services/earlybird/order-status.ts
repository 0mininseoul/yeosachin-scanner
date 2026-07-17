import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

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
    target_instagram_id: z.string().min(1).max(30),
    plan_id: z.enum(['basic', 'standard']),
    actual_amount_krw: z.number().int().positive().nullable(),
    status: earlybirdOrderSystemStatusSchema,
    paid_at: z.string().datetime({ offset: true }).nullable(),
    due_at: z.string().datetime({ offset: true }).nullable(),
    plan_sequence: z.number().int().min(1).max(10).nullable(),
    result_request_id: z.string().uuid().nullable(),
    created_at: z.string().datetime({ offset: true }),
});

const resultRowSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    status: z.literal('completed'),
});

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
    targetInstagramId: string;
    planId: 'basic' | 'standard';
    planName: 'Basic' | 'Standard';
    actualAmountKrw: number | null;
    acceptedAt: string | null;
    dueAt: string | null;
    planSequence: number | null;
    systemStatus: EarlybirdOrderSystemStatus;
    displayStatus: string;
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
        .select('id, user_id, target_instagram_id, plan_id, actual_amount_krw, status, paid_at, due_at, plan_sequence, result_request_id, created_at')
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
            resultUrl = `/result/${encodeURIComponent(parsedResult.data.id)}`;
        }
    }

    return Object.freeze({
        orderId: order.id,
        targetInstagramId: order.target_instagram_id,
        planId: order.plan_id,
        planName: PLAN_NAMES[order.plan_id],
        actualAmountKrw: order.actual_amount_krw,
        acceptedAt: order.paid_at,
        dueAt: order.due_at,
        planSequence: order.plan_sequence,
        systemStatus: order.status,
        displayStatus: DISPLAY_STATUS[order.status],
        resultUrl,
    });
}
