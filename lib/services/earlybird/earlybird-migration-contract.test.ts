import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260717140000_add_groble_earlybird_presale.sql',
        import.meta.url
    ),
    'utf8'
);

const SERVICE_FUNCTIONS = [
    'create_earlybird_checkout',
    'join_earlybird_waitlist',
    'finalize_earlybird_groble_payment',
    'finalize_earlybird_groble_cancel_request',
    'set_earlybird_refund_status',
] as const;

describe('Groble earlybird migration contract', () => {
    it('creates the isolated earlybird tables and unique payment evidence', () => {
        for (const table of [
            'earlybird_orders',
            'earlybird_plan_inventory',
            'earlybird_webhook_events',
            'earlybird_waitlist',
        ]) {
            expect(migration).toContain(`CREATE TABLE public.${table}`);
            expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
        }
        expect(migration).toMatch(/payment_id\s+VARCHAR\(256\)\s+UNIQUE/);
        expect(migration).toContain('CREATE UNIQUE INDEX earlybird_orders_plan_sequence_unique');
    });

    it('grants browser reads only for owner-scoped, presentation-safe order columns', () => {
        expect(migration).toMatch(
            /CREATE POLICY earlybird_orders_owner_select[\s\S]*?FOR SELECT[\s\S]*?\(SELECT auth\.uid\(\)\) = user_id/
        );
        expect(migration).toMatch(
            /CREATE POLICY earlybird_waitlist_owner_select[\s\S]*?FOR SELECT[\s\S]*?\(SELECT auth\.uid\(\)\) = user_id/
        );
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.earlybird_orders FROM anon, authenticated'
        );
        expect(migration).toMatch(
            /GRANT SELECT \([\s\S]*?target_instagram_id[\s\S]*?actual_amount_krw[\s\S]*?plan_sequence[\s\S]*?\)\s+ON public\.earlybird_orders TO authenticated/
        );
        expect(migration).not.toContain(
            'GRANT SELECT ON TABLE public.earlybird_orders TO authenticated'
        );
        const authenticatedOrderGrant = migration.match(
            /GRANT SELECT \(([\s\S]*?)\)\s+ON public\.earlybird_orders TO authenticated/
        )?.[1];
        expect(authenticatedOrderGrant).toBeDefined();
        expect(authenticatedOrderGrant).not.toMatch(
            /payment_id|expected_groble_product_id|actual_groble_product_id|disclosure_text/
        );
        expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE).*authenticated/i);
    });

    it('keeps all state-changing RPCs service-role only and search-path safe', () => {
        for (const functionName of SERVICE_FUNCTIONS) {
            const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}(`);
            expect(start, `${functionName} must exist`).toBeGreaterThanOrEqual(0);
            const end = migration.indexOf('\n$$;', start);
            const definition = migration.slice(start, end);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?TO service_role`
            ));
        }
    });

    it('does not create analysis requests or dispatch automatic work', () => {
        expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.analysis_requests/i);
        expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.pipeline_jobs/i);
        expect(migration).not.toMatch(/cloud\s*tasks|dispatch_analysis|start_analysis/i);
    });
});
