BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Tenth is a general Analysis V2 credential only. Beta and historical
-- authorized-test slot vocabularies remain independently pinned.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(
    p_slot TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary',
            'senary', 'septenary', 'tenth'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    TO anon, authenticated;

COMMIT;
