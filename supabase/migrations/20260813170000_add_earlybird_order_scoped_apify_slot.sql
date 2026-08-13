-- A service-role-only, immutable selector for one paid concierge order.
-- The token remains in Secret Manager/env; only the allowlisted slot name is durable.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.earlybird_orders
    ADD COLUMN IF NOT EXISTS concierge_apify_credential_slot TEXT;
ALTER TABLE public.earlybird_orders
    ADD CONSTRAINT earlybird_orders_concierge_apify_slot_check CHECK (
        concierge_apify_credential_slot IS NULL
        OR public.analysis_v2_valid_apify_credential_slot(concierge_apify_credential_slot)
    );
ALTER TABLE public.analysis_preflights
    ADD COLUMN IF NOT EXISTS order_scoped_apify_credential_slot TEXT;
ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_order_scoped_apify_slot_check CHECK (
        order_scoped_apify_credential_slot IS NULL
        OR public.analysis_v2_valid_apify_credential_slot(order_scoped_apify_credential_slot)
    );

CREATE OR REPLACE FUNCTION public.copy_earlybird_order_scoped_apify_slot()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.preflight_id IS DISTINCT FROM OLD.preflight_id
       AND NEW.preflight_id IS NOT NULL
       AND NEW.concierge_apify_credential_slot IS NOT NULL THEN
        UPDATE public.analysis_preflights
        SET order_scoped_apify_credential_slot = NEW.concierge_apify_credential_slot
        WHERE id = NEW.preflight_id;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS copy_earlybird_order_scoped_apify_slot
    ON public.earlybird_orders;
CREATE TRIGGER copy_earlybird_order_scoped_apify_slot
AFTER UPDATE OF preflight_id, concierge_apify_credential_slot
ON public.earlybird_orders
FOR EACH ROW EXECUTE FUNCTION public.copy_earlybird_order_scoped_apify_slot();

CREATE FUNCTION public.bind_earlybird_order_scoped_apify_slot(
    p_order_id UUID,
    p_credential_slot TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
BEGIN
    IF p_order_id IS NULL
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
    THEN RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_ORDER_CREDENTIAL_SLOT_INVALID', ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_order FROM public.earlybird_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND OR v_order.status <> 'paid'
       OR v_order.payment_id IS NULL
       OR v_order.preflight_id IS NULL
       OR EXISTS (SELECT 1 FROM public.earlybird_fulfillments f WHERE f.order_id = v_order.id AND f.request_id IS NOT NULL)
    THEN RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_ORDER_CREDENTIAL_SLOT_INELIGIBLE', ERRCODE = 'P0001'; END IF;
    IF v_order.concierge_apify_credential_slot IS NOT NULL
       AND v_order.concierge_apify_credential_slot <> p_credential_slot
    THEN RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_ORDER_CREDENTIAL_SLOT_IMMUTABLE', ERRCODE = 'P0001'; END IF;
    UPDATE public.earlybird_orders
    SET concierge_apify_credential_slot = p_credential_slot, updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_order_id;
    UPDATE public.analysis_preflights
    SET order_scoped_apify_credential_slot = p_credential_slot,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_order.preflight_id;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.bind_earlybird_order_scoped_apify_slot(UUID,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bind_earlybird_order_scoped_apify_slot(UUID,TEXT)
    TO service_role;

-- Preserve old workers by leaving the existing response shapes untouched. The
-- new worker uses a versioned selector-bearing collection RPC.
DO $context_patch$
DECLARE
    v_signature REGPROCEDURE :=
        'public.load_analysis_v2_collection_context_with_policy(uuid,text,uuid,text)'::REGPROCEDURE;
    v_original TEXT;
    v_patched TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_signature) INTO v_original;
    v_patched := pg_catalog.replace(
        v_original,
        $$CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_context_with_policy($$,
        $$CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_context_with_policy_v2($$
    );
    v_patched := pg_catalog.replace(
        v_patched,
        $$'detailedMutualLimit',v_detailed_limit);$$,
        $$'detailedMutualLimit',v_detailed_limit,'orderScopedCredentialSlot',(
            SELECT earlybird_order.concierge_apify_credential_slot
            FROM public.earlybird_fulfillments AS fulfillment
            JOIN public.earlybird_orders AS earlybird_order
              ON earlybird_order.id = fulfillment.order_id
            WHERE fulfillment.request_id = v_request.id
        ));$$
    );
    IF v_patched = v_original THEN
        RAISE EXCEPTION 'EARLYBIRD_ORDER_CREDENTIAL_SLOT_CONTEXT_PATCH_FAILED';
    END IF;
    EXECUTE v_patched;
END;
$context_patch$;

-- The versioned fresh-admission claim carries the immutable preflight selector;
-- the existing v2 claim remains available to already-running workers.
DO $claim_patch$
DECLARE
    v_signature REGPROCEDURE :=
        'public.claim_analysis_v2_preflight_admission_v2(uuid,integer,integer,uuid,uuid,integer)'::REGPROCEDURE;
    v_original TEXT;
    v_patched TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_signature) INTO v_original;
    v_patched := pg_catalog.replace(
        v_original,
        $$CREATE OR REPLACE FUNCTION public.claim_analysis_v2_preflight_admission_v2($$,
        $$CREATE OR REPLACE FUNCTION public.claim_analysis_v2_preflight_admission_v3($$
    );
    v_patched := pg_catalog.replace(
        v_patched,
        $$RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT, analysis_entry_channel TEXT, access_mode TEXT)$$,
        $$RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT, analysis_entry_channel TEXT, access_mode TEXT, order_scoped_credential_slot TEXT)$$
    );
    v_patched := pg_catalog.replace(
        v_patched,
        $$v_preflight.access_mode::TEXT$$,
        $$v_preflight.access_mode::TEXT,v_preflight.order_scoped_apify_credential_slot$$
    );
    IF v_patched = v_original THEN
        RAISE EXCEPTION 'EARLYBIRD_ORDER_CREDENTIAL_SLOT_CLAIM_PATCH_FAILED';
    END IF;
    EXECUTE v_patched;
END;
$claim_patch$;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight_admission_v3(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight_admission_v3(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)
    TO service_role;

COMMIT;
