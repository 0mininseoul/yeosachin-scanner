-- MIGRATION_PREDECESSOR=20260815090000
-- PR403-compatible forward-only correction for the exact first-paid Basic
-- concierge bootstrap.  Only the immutable order exclusion-shape predicate is
-- relaxed; candidate, payment/refund, owner, target, pointer, fulfillment,
-- artifact, CAS, and replay guards remain in the predecessor function.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := TRUE;
    v_signature REGPROCEDURE :=
        'public.bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure;
    v_original_definition TEXT;
    v_corrected_definition TEXT;
    v_old TEXT := $old$
       OR v_order.exclusion_decision IS DISTINCT FROM 'skip'
       OR v_order.excluded_instagram_id IS NOT NULL$old$;
    v_new TEXT := $new$
       OR (
            v_order.exclusion_decision IS NULL
            OR (
                v_order.exclusion_decision = 'skip'
                AND v_order.excluded_instagram_id IS NOT NULL
            )
            OR (
                v_order.exclusion_decision <> 'skip'
                AND NOT (
                    v_order.exclusion_decision = 'exclude'
                    AND v_order.excluded_instagram_id IS NOT NULL
                    AND pg_catalog.lower(pg_catalog.btrim(v_order.excluded_instagram_id))
                        ~ '^[a-z0-9._]{1,30}$'
                    AND pg_catalog.lower(pg_catalog.btrim(v_order.excluded_instagram_id))
                        IS DISTINCT FROM v_target
                )
            )
       )$new$;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260815090000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_PR403_EXCLUDE_GUARD_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.pg_get_functiondef(v_signature)
    INTO v_original_definition;
    IF v_original_definition IS NULL
       OR pg_catalog.strpos(v_original_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_original_definition,
                pg_catalog.strpos(v_original_definition, v_old)
                    + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_PR403_EXCLUDE_GUARD_DEFINITION_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_corrected_definition := pg_catalog.replace(
        v_original_definition, v_old, v_new
    );
    IF v_corrected_definition = v_original_definition
       OR pg_catalog.strpos(v_corrected_definition, v_old) > 0
       OR pg_catalog.strpos(
            v_corrected_definition,
            'v_order.exclusion_decision IS NULL'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_PR403_EXCLUDE_GUARD_REWRITE_FAILED',
            ERRCODE = 'P0001';
    END IF;

    EXECUTE v_corrected_definition;
END;
$migration$;

DO $final_guard$
DECLARE
    v_signature TEXT :=
        'public.bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)';
    v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_signature::pg_catalog.regprocedure)
    INTO v_definition;
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR pg_catalog.strpos(v_definition, 'v_order.exclusion_decision IS NULL') = 0
       OR pg_catalog.strpos(v_definition, 'v_order.excluded_instagram_id IS NOT NULL') = 0
       OR pg_catalog.strpos(v_definition, 'v_order.result_request_id IS DISTINCT FROM p_result_request_id') = 0
       OR pg_catalog.strpos(v_definition, 'v_order.payment_id IS NULL') = 0
       OR pg_catalog.strpos(v_definition, 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ORDER_SCOPE_CONFLICT') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_PR403_EXCLUDE_GUARD_FINAL_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$final_guard$;

COMMENT ON FUNCTION public.bootstrap_earlybird_v211_concierge_first_order(
    UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, SMALLINT,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, JSONB, JSONB,
    JSONB, JSONB, JSONB
) IS 'One-shot service-role-only bootstrap/publication for the exact first paid non-refunded 2026-08-12 Basic concierge order; PR403-compatible immutable exclude state is accepted only when normalized, non-target, and all predecessor scope/CAS guards pass.';

COMMIT;
