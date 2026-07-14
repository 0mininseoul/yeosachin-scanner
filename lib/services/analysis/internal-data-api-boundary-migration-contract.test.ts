import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714020318_harden_internal_data_api_boundary.sql',
        import.meta.url
    ),
    'utf8'
);

describe('internal Data API boundary migration contract', () => {
    it('is safe when any remote-drift table is absent', () => {
        expect(migration).toContain("FOREACH v_table_name IN ARRAY ARRAY[");
        for (const table of [
            'payments',
            'payment_orders',
            'users',
            'ai_analysis_cache',
        ]) {
            expect(migration).toContain(`'${table}'`);
        }
        expect(migration).toContain(
            "pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table_name)) IS NULL"
        );
        expect(migration).toContain(
            "pg_catalog.to_regclass('public.payments') IS NOT NULL"
        );
    });

    it('keeps RLS enabled without changing the existing FORCE RLS state', () => {
        expect(migration).toContain(
            "'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY'"
        );
        expect(migration).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
        expect(migration).not.toMatch(/(?:NO )?FORCE ROW LEVEL SECURITY/i);
    });

    it('removes only public Data API grants and preserves service-role table grants', () => {
        expect(migration).toContain(
            "'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated'"
        );
        expect(migration).not.toMatch(
            /REVOKE ALL PRIVILEGES ON TABLE[^\n]+service_role/i
        );
        expect(migration).toContain(
            'this migration never revokes from service_role'
        );
    });

    it('removes the legacy authenticated payment policies conditionally', () => {
        expect(migration).toContain(
            'DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments'
        );
        expect(migration).toContain(
            'DROP POLICY IF EXISTS "Users can view own payments" ON public.payments'
        );
    });

    it('hardens the trigger function without breaking its trigger signature', () => {
        expect(migration).toContain(
            "pg_catalog.to_regprocedure('public.update_updated_at_column()') IS NOT NULL"
        );
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.update_updated_at_column()'
        );
        expect(migration).toContain('RETURNS trigger');
        expect(migration).toContain('SECURITY INVOKER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('NEW.updated_at := pg_catalog.now()');
        expect(migration).toContain(
            'REVOKE ALL PRIVILEGES ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated'
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO service_role'
        );
    });
});
