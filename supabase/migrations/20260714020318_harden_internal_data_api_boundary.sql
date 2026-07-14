-- These tables are owned by server-side application paths. RLS remains enabled as
-- defense in depth, while Data API roles lose object-level access. This block is
-- intentionally tolerant of remote-only legacy tables and fresh databases where
-- any of the named tables do not exist.
DO $migration$
DECLARE
    v_table_name TEXT;
BEGIN
    FOREACH v_table_name IN ARRAY ARRAY[
        'payments',
        'payment_orders',
        'users',
        'ai_analysis_cache'
    ]
    LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table_name)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE pg_catalog.format(
            'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
            v_table_name
        );
        EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',
            v_table_name
        );
    END LOOP;
END;
$migration$;

-- Payment integration is not a client-writable boundary. Remove the two legacy
-- policies that let authenticated clients submit arbitrary payment state or read
-- it directly. service_role keeps its existing explicit table privileges and
-- bypasses RLS; this migration never revokes from service_role.
DO $migration$
BEGIN
    IF pg_catalog.to_regclass('public.payments') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can insert own payments" ON public.payments';
        EXECUTE 'DROP POLICY IF EXISTS "Users can view own payments" ON public.payments';
    END IF;
END;
$migration$;

-- Keep the existing trigger function identity and signature so dependent triggers
-- remain attached. The explicit empty search path and pg_catalog qualification
-- prevent caller-controlled object resolution.
DO $migration$
BEGIN
    IF pg_catalog.to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN
        EXECUTE $function_ddl$
            CREATE OR REPLACE FUNCTION public.update_updated_at_column()
            RETURNS trigger
            LANGUAGE plpgsql
            SECURITY INVOKER
            SET search_path = ''
            AS $function_body$
            BEGIN
                NEW.updated_at := pg_catalog.now();
                RETURN NEW;
            END;
            $function_body$
        $function_ddl$;

        EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO service_role';
    END IF;
END;
$migration$;
