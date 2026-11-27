// This real Supabase client is selected only by the standalone QA worker bundle.
import { supabaseAdmin as actual } from '@/lib/supabase/admin';
import { qaDelivery } from './scope';

const scopedRpc: Readonly<Record<string, string>> = Object.freeze({
    reserve_vertex_ai_budget: 'reserve_dev_cloud_six_vertex_budget_v1',
    settle_vertex_ai_budget: 'settle_dev_cloud_six_vertex_budget_v1',
    cancel_vertex_ai_budget: 'cancel_dev_cloud_six_vertex_budget_v1',
    handoff_ready_signed_paid_fulfillment_v1: 'handoff_dev_cloud_six_fulfillment_v1',
    complete_published_capacity_order_v1: 'complete_dev_cloud_six_order_v1',
    paid_standard_capacity_approved_v1: 'dev_cloud_six_capacity_approved_v1',
    paid_standard_capacity_lineage_v1: 'dev_cloud_six_capacity_lineage_v1',
    acquire_paid_standard_gemini_lease_v1: 'acquire_dev_cloud_six_gemini_lease_v1',
    acquire_paid_standard_provider_admission_v1: 'acquire_dev_cloud_six_provider_admission_v1',
    authorize_paid_standard_vertex_dispatch_v1: 'authorize_dev_cloud_six_vertex_dispatch_v1',
    reserve_paid_standard_ai_attempt_v1: 'reserve_dev_cloud_six_ai_attempt_v1',
});
export const supabaseAdmin = new Proxy(actual, {
    get(target, property) {
        if (property !== 'rpc') return Reflect.get(target, property);
        return (name: string, args: Record<string, unknown> = {}, options?: Parameters<typeof actual.rpc>[2]) => {
            // A model delivery has no use for a day-wide balance snapshot.
            if (name === 'snapshot_vertex_ai_budget') throw new Error('DEV_STANDARD_QA_SCOPE_REJECTED');
            const replacement = Object.hasOwn(scopedRpc, name) ? scopedRpc[name] : undefined;
            if (!replacement) return target.rpc(name, args, options);
            const active = qaDelivery();
            if (active.role !== 'paid') throw new Error('DEV_STANDARD_QA_SCOPE_REJECTED');
            let bound;
            if (name === 'handoff_ready_signed_paid_fulfillment_v1') {
                bound = active.preflightId && args.p_preflight_id === active.preflightId;
            } else if (name.endsWith('_vertex_ai_budget')) {
                // gemini.ts constructs exactly this request-prefixed reservation key.
                // The database binds the real stored reservation and order on all three RPCs.
                bound = active.requestId && typeof args.p_reservation_key === 'string'
                    && args.p_reservation_key.startsWith(active.requestId + ':')
                    && (name !== 'reserve_vertex_ai_budget' || args.p_run_id === active.requestId);
            } else {
                bound = active.requestId && args.p_request_id === active.requestId;
            }
            if (!bound) throw new Error('DEV_STANDARD_QA_SCOPE_REJECTED');
            return target.rpc(replacement, { ...args, p_wave: active.wave }, options);
        };
    },
});
