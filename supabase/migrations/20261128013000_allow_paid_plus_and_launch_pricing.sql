BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.earlybird_orders DROP CONSTRAINT earlybird_orders_plan_check,
    ADD CONSTRAINT earlybird_orders_plan_check CHECK (plan_id IN ('basic','standard','plus'));
ALTER TABLE public.earlybird_plan_inventory DROP CONSTRAINT earlybird_plan_inventory_plan_check,
    ADD CONSTRAINT earlybird_plan_inventory_plan_check CHECK (plan_id IN ('basic','standard','plus'));
INSERT INTO public.earlybird_plan_inventory(plan_id) VALUES ('plus');

-- These routines already implement ownership, signed payment, admission and recovery.
-- Preserve their installed bodies and grants, widening just the paid plan predicates.
DO $paid_plus$
DECLARE
    routine record;
    previous text;
    updated text;
BEGIN
    FOR routine IN SELECT * FROM (VALUES
        ('admit_earlybird_fulfillment_core_20260730140000', 'uuid'),
        ('rebind_expired_paid_earlybird_preflight', 'uuid'),
        ('auto_admit_eligible_earlybird_fulfillments', 'integer'),
        ('create_or_replay_earlybird_fulfillment_request', 'uuid,uuid,bigint'),
        ('checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1', 'uuid,text,uuid,text,text[],jsonb,text,text'),
        ('register_paid_analysis_capacity_v1', ''),
        ('paid_analysis_capacity_available_v1', 'integer'),
        ('claim_paid_analysis_capacity_v1', 'uuid'),
        ('handoff_ready_signed_paid_fulfillment_v1', 'uuid,integer,integer,uuid'),
        ('complete_published_capacity_order_v1', 'uuid')
    ) AS routines(name, arguments) LOOP
        previous := pg_get_functiondef(format('public.%s(%s)', routine.name, routine.arguments)::regprocedure);
        updated := regexp_replace(previous, '\(''basic'',\s*''standard''\)', '(''basic'', ''standard'', ''plus'')', 'g');
        IF updated = previous THEN RAISE EXCEPTION 'PAID_PLUS_ROUTINE_DRIFT %', routine.name; END IF;
        IF routine.name = 'admit_earlybird_fulfillment_core_20260730140000' THEN
            IF strpos(updated, 'WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 ELSE NULL') = 0 THEN
                RAISE EXCEPTION 'PAID_PLUS_RANK_DRIFT %', routine.name;
            END IF;
            updated := replace(updated, 'WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 ELSE NULL',
                'WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 WHEN ''plus'' THEN 3 ELSE NULL');
        ELSIF routine.name = 'rebind_expired_paid_earlybird_preflight' THEN
            IF strpos(updated, 'CASE v_order.plan_id WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 END') = 0 THEN
                RAISE EXCEPTION 'PAID_PLUS_RANK_DRIFT %', routine.name;
            END IF;
            updated := replace(updated, 'CASE v_order.plan_id WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 END',
                'CASE v_order.plan_id WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 WHEN ''plus'' THEN 3 END');
        END IF;
        EXECUTE updated;
    END LOOP;
END;
$paid_plus$;

DO $launch_price$
DECLARE
    definition text := pg_get_functiondef('public.create_earlybird_checkout(uuid,uuid,text,text,integer,text,text,text,timestamptz)'::regprocedure);
BEGIN
    IF strpos(definition, 'IF p_pricing_version <> ''earlybird-2026-08-v5''') = 0
        OR strpos(definition, 'IF v_required_rank = 3 THEN RAISE EXCEPTION ''EARLYBIRD_WAITLIST_REQUIRED''; END IF;') = 0 THEN
        RAISE EXCEPTION 'PAID_PLUS_CHECKOUT_DRIFT';
    END IF;
    definition := replace(definition, 'p_plan_id NOT IN (''basic'', ''standard'')',
        'p_plan_id NOT IN (''basic'', ''standard'', ''plus'')');
    definition := replace(definition, '''earlybird-2026-08-v5''
       )', '''earlybird-2026-08-v5'', ''earlybird-2026-11-v6''
       )');
    definition := replace(definition, 'IF p_expected_amount_krw IS NULL', $condition$IF p_expected_amount_krw IS NULL
       OR (p_plan_id = 'plus' AND p_pricing_version <> 'earlybird-2026-11-v6')
       OR (p_pricing_version = 'earlybird-2026-11-v6' AND p_expected_amount_krw <> CASE p_plan_id
            WHEN 'basic' THEN 3900 WHEN 'standard' THEN 6900 WHEN 'plus' THEN 10900 END)$condition$);
    definition := replace(definition, 'IF p_pricing_version <> ''earlybird-2026-08-v5''',
        'IF p_pricing_version <> ''earlybird-2026-11-v6''');
    definition := replace(definition, 'OR v_preflight.pricing_version IN (''earlybird-2026-07-v1'', ''earlybird-2026-07-v2'', ''earlybird-2026-08-v3'', ''earlybird-2026-08-v4'')',
        'OR v_preflight.pricing_version IS DISTINCT FROM p_pricing_version');
    definition := replace(definition, 'v_existing.pricing_version <> ''earlybird-2026-08-v5''',
        'v_existing.pricing_version <> ''earlybird-2026-11-v6''');
    definition := replace(definition, 'WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 ELSE 99',
        'WHEN ''basic'' THEN 1 WHEN ''standard'' THEN 2 WHEN ''plus'' THEN 3 ELSE 99');
    definition := replace(definition,
        'IF v_required_rank = 3 THEN RAISE EXCEPTION ''EARLYBIRD_WAITLIST_REQUIRED''; END IF;',
        $eligibility$IF p_plan_id = 'plus' AND greatest(v_preflight.target_followers_count,
        v_preflight.target_following_count) NOT BETWEEN 801 AND 1200 THEN
        RAISE EXCEPTION 'PLAN_SELECTION_UNAVAILABLE';
    END IF;$eligibility$);
    EXECUTE definition;
END;
$launch_price$;

COMMIT;
