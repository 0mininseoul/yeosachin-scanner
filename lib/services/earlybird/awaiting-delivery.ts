import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Mirrors the paid/analysis_in_progress window during which an earlybird
// order has no analysis_requests row yet: fulfillment creates that row later,
// so this is the only signal the archive has for "결과 대기 중" cards.
const AWAITING_DELIVERY_STATUSES = ['paid', 'analysis_in_progress'] as const;

const awaitingOrderRowSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    target_instagram_id: z.string().min(1).max(30),
    plan_id: z.enum(['basic', 'standard']),
    result_request_id: z.string().uuid().nullable(),
    paid_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
});

export interface AwaitingEarlybirdDelivery {
    orderId: string;
    targetInstagramId: string;
    planId: 'basic' | 'standard';
    createdAt: string | null;
    resultRequestId: string | null;
}

export class AwaitingEarlybirdDeliveryLookupError extends Error {
    constructor() {
        super('AWAITING_EARLYBIRD_DELIVERY_LOOKUP_FAILED');
        this.name = 'AwaitingEarlybirdDeliveryLookupError';
    }
}

export async function listAwaitingEarlybirdDeliveries(
    userId: string
): Promise<readonly AwaitingEarlybirdDelivery[]> {
    const { data, error } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id, user_id, target_instagram_id, plan_id, result_request_id, paid_at, created_at')
        .eq('user_id', userId)
        .in('status', AWAITING_DELIVERY_STATUSES);

    if (error) throw new AwaitingEarlybirdDeliveryLookupError();
    if (!data) return [];

    const deliveries: AwaitingEarlybirdDelivery[] = [];
    for (const row of data) {
        const parsed = awaitingOrderRowSchema.safeParse(row);
        // supabaseAdmin bypasses RLS, so the .eq('user_id', ...) filter above is
        // only a query hint, not a security boundary. This per-row recheck is
        // the real boundary — mirrors loadLatestEarlybirdOrder in order-status.ts.
        if (!parsed.success || parsed.data.user_id !== userId) continue;

        const order = parsed.data;
        deliveries.push(Object.freeze({
            orderId: order.id,
            targetInstagramId: order.target_instagram_id,
            planId: order.plan_id,
            createdAt: order.paid_at ?? order.created_at,
            resultRequestId: order.result_request_id,
        }));
    }
    return deliveries;
}
