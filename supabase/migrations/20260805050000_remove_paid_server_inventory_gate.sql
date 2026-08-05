-- Groble is the inventory source of truth for both paid plans. Remove the
-- remaining Basic branch that still allocated the legacy server sequence.
DO $migration$
DECLARE
    v_definition TEXT;
    v_start INTEGER;
    v_end INTEGER;
    v_marker CONSTANT TEXT := $marker$    IF v_order.plan_id = 'standard' THEN$marker$;
    v_update_marker CONSTANT TEXT := $marker$    UPDATE public.earlybird_orders AS accepted_order$marker$;
    v_replacement CONSTANT TEXT := $replacement$    -- Groble owns paid-plan inventory. Do not allocate or reject
    -- against the legacy server-side counter.
    v_sequence := NULL;

$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.finalize_earlybird_groble_payment_pre_reconciliation(
            text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone
        )'::pg_catalog.regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(v_definition, v_marker) = 0 THEN
        RETURN;
    END IF;
    v_start := pg_catalog.strpos(v_definition, v_marker);
    v_end := v_start + pg_catalog.strpos(
        pg_catalog.substr(v_definition, v_start),
        v_update_marker
    ) - 1;
    IF v_end <= v_start THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PAID_INVENTORY_FUNCTION_SHAPE_UNEXPECTED',
            ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.overlay(
        v_definition,
        v_replacement,
        v_start,
        v_end - v_start
    );
    EXECUTE v_definition;
END;
$migration$;
