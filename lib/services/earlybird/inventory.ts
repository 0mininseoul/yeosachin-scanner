import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    PAID_EARLYBIRD_PLAN_IDS,
    type PaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';

export async function fetchEarlybirdRemainingSlots(): Promise<
    Partial<Record<PaidEarlybirdPlanId, number>>
> {
    try {
        const { data, error } = await supabaseAdmin.from('earlybird_plan_inventory')
            .select('plan_id, sale_limit, sold_count')
            .in('plan_id', PAID_EARLYBIRD_PLAN_IDS)
            .abortSignal(AbortSignal.timeout(1_500));
        if (error || !data) return {};
        return Object.fromEntries(
            data
                .filter((row): row is { plan_id: PaidEarlybirdPlanId; sale_limit: number; sold_count: number } =>
                    PAID_EARLYBIRD_PLAN_IDS.some(planId => planId === row.plan_id)
                    && Number.isSafeInteger(row.sale_limit)
                    && Number.isSafeInteger(row.sold_count))
                .map(row => [row.plan_id, Math.max(0, row.sale_limit - row.sold_count)])
        );
    } catch {
        return {};
    }
}
