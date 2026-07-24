import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('earlybird fulfillment outbox migration contract', () => {
    it('creates one private, RLS-enabled row per paid order', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_fulfillments'
        );
        expect(migration).toContain(
            'order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)'
        );
        expect(migration).toContain(
            "status IN ('awaiting_operator', 'admission_pending', "
            + "'analysis_in_progress', 'completed', 'retryable_failure', "
            + "'manual_review')"
        );
        expect(migration).toContain(
            'ALTER TABLE public.earlybird_fulfillments ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.earlybird_fulfillments'
        );
        expect(migration).not.toMatch(
            /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL).*earlybird_fulfillments.*(?:anon|authenticated)/i
        );
    });

    it('lets payment confirmation enqueue only an operator-waiting row', () => {
        const enqueue = functionDefinition('enqueue_earlybird_fulfillment');
        expect(enqueue).toContain("v_order.status = 'paid'");
        expect(enqueue).toContain(
            'v_order.seller_reference_confirmed_at IS NOT NULL'
        );
        expect(enqueue).toContain("'awaiting_operator'");
        expect(enqueue).not.toMatch(
            /INSERT INTO public\.analysis_requests|reserve_analysis_v2|provider/i
        );
        expect(migration).toContain(
            'CREATE TRIGGER enqueue_reference_confirmed_earlybird_fulfillment'
        );
    });

    it('requires an explicit operator transition before any admission can be claimed', () => {
        const admit = functionDefinition('admit_earlybird_fulfillment');
        expect(admit).toContain("v_fulfillment.status = 'awaiting_operator'");
        expect(admit).toContain("status = 'admission_pending'");
        expect(admit).toContain("v_order.status = 'paid'");
        expect(admit).toContain(
            'v_order.seller_reference_confirmed_at IS NOT NULL'
        );

        const claim = functionDefinition('claim_earlybird_fulfillment');
        expect(claim).toContain(
            "v_fulfillment.status IN ('admission_pending', 'retryable_failure')"
        );
        expect(claim).toContain('v_preflight.admission_refreshed_at');
        expect(claim).toContain('v_fulfillment.lease_fence + 1');
        expect(claim).not.toContain("'awaiting_operator'");
    });

    it('creates or replays exactly one production V2 request behind the lease fence', () => {
        const create = functionDefinition(
            'create_or_replay_earlybird_fulfillment_request'
        );
        expect(create).toContain(
            'v_fulfillment.lease_token IS DISTINCT FROM p_lease_token'
        );
        expect(create).toContain(
            'v_fulfillment.lease_fence IS DISTINCT FROM p_lease_fence'
        );
        expect(create).toContain('INSERT INTO public.analysis_requests');
        expect(create).toContain("'production'");
        expect(create).toContain("'coordinator:bootstrap'");
        expect(create).toContain(
            'INSERT INTO public.analysis_pipeline_jobs'
        );
        expect(create).toContain('result_request_id = v_request_id');
        expect(create).toContain("status = 'analysis_in_progress'");
        expect(create).not.toContain('test_entitlement_jti_hash');
    });

    it('recovers only admitted work and never auto-admits waiting payments', () => {
        const list = functionDefinition(
            'list_recoverable_earlybird_fulfillments'
        );
        expect(list).toContain(
            "fulfillment.status IN ('admission_pending', 'retryable_failure')"
        );
        expect(list).not.toContain("'awaiting_operator'");

        const reconcile = functionDefinition('reconcile_earlybird_fulfillments');
        expect(reconcile).toContain("analysis_request.status = 'completed'");
        expect(reconcile).toContain("analysis_request.status = 'failed'");
        expect(reconcile).toContain("status = 'manual_review'");
        expect(reconcile).toContain("status = 'retryable_failure'");
    });

    it('keeps every runtime RPC service-role only', () => {
        const names = [
            'enqueue_earlybird_fulfillment',
            'admit_earlybird_fulfillment',
            'list_recoverable_earlybird_fulfillments',
            'claim_earlybird_fulfillment',
            'create_or_replay_earlybird_fulfillment_request',
            'mark_earlybird_fulfillment_manual_review',
            'reconcile_earlybird_fulfillments',
        ];
        for (const name of names) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'FROM PUBLIC, anon, authenticated, service_role;'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'TO service_role;'
            ));
        }
    });
});
