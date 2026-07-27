-- Supabase's migration runner does not include the extensions schema in search_path.
-- Keep existing unqualified defaults and functions compatible with uuid-ossp.
DO $compat$
BEGIN
    IF pg_catalog.to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
        EXECUTE $function$
            CREATE FUNCTION public.uuid_generate_v4()
            RETURNS uuid
            LANGUAGE sql
            VOLATILE
            SET search_path = pg_catalog, extensions
            AS 'SELECT extensions.uuid_generate_v4()'
        $function$;
    END IF;
END;
$compat$;
