import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manualReconciliation = readFileSync(
    new URL(
        '../../../supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql',
        import.meta.url
    ),
    'utf8'
);
const forwardMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260721143000_fix_analysis_v2_e2e_admission_and_retention.sql',
        import.meta.url
    ),
    'utf8'
);
const preflightMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713142811_add_analysis_v2_preflight.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return source.slice(start, end + '\n$$;'.length);
}

describe('analysis V2 E2E unblock migration contracts', () => {
    it('tracks the already-applied one-order reconciliation without buyer literals', () => {
        expect(manualReconciliation).toContain(
            'evt_manual_recon_64115d4d_20260719'
        );
        expect(manualReconciliation).toContain(
            'finalize_earlybird_groble_payment'
        );
        expect(manualReconciliation).not.toMatch(/[\w.+-]+@[\w.-]+/);
        expect(manualReconciliation).not.toMatch(/01[016789]-?\d{3,4}-?\d{4}/);
    });

    it('expands the legacy request plan domain without changing the sale catalog', () => {
        const consumer = functionDefinition(
            preflightMigration,
            'consume_analysis_v2_test_entitlement'
        );

        expect(consumer).toContain(
            "p_selected_plan_id NOT IN ('basic', 'standard', 'plus')"
        );
        expect(consumer).toMatch(
            /INSERT INTO public\.analysis_requests \([\s\S]*?plan_type,[\s\S]*?\) VALUES \([\s\S]*?p_selected_plan_id,/
        );
        expect(forwardMigration).toMatch(
            /CHECK\s*\(plan_type IN \('basic', 'standard', 'plus'\)\)/
        );
        expect(forwardMigration).toContain(
            'DROP CONSTRAINT IF EXISTS analysis_requests_plan_type_check'
        );
        expect(forwardMigration).toContain(
            'VALIDATE CONSTRAINT analysis_requests_plan_type_check'
        );
        expect(forwardMigration).not.toContain(
            'earlybird_orders_plan_check'
        );
    });

    it('retains every restrictive commercial preflight reference during purge', () => {
        const purge = functionDefinition(
            forwardMigration,
            'purge_expired_analysis_v2_preflights'
        );

        expect(purge).toContain(
            'FROM public.analysis_preflight_provider_runs AS provider_run'
        );
        expect(purge).toContain(
            'FROM public.earlybird_orders AS earlybird_order'
        );
        expect(purge).toContain(
            'FROM public.earlybird_waitlist AS waitlist_entry'
        );
        expect(forwardMigration).toContain(
            'REVOKE ALL ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)'
        );
        expect(forwardMigration).toContain(
            'GRANT EXECUTE ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)'
        );
        expect(forwardMigration).not.toMatch(/ON DELETE CASCADE/);
    });
});
