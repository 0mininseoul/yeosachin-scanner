-- Dev configuration for the common three-seat policy and isolated Plus rehearsal.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_only$
BEGIN
    IF to_regclass('dev_ui.runs') IS NULL OR to_regclass('dev_cloud_six.waves') IS NULL
        OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR to_regnamespace('paid_standard_capacity') IS NOT NULL
        OR EXISTS (SELECT FROM dev_cloud_six.waves WHERE closed_at IS NULL) THEN
        RAISE EXCEPTION 'DEV_PLUS_SCOPE';
    END IF;
END;
$dev_only$;

ALTER TABLE dev_cloud_six.waves ADD COLUMN fixture_plan text NOT NULL DEFAULT 'standard'
    CHECK (fixture_plan IN ('standard','plus'));

CREATE FUNCTION dev_cloud_six.matches_rebound_preflight(order_id uuid, preflight_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
    SELECT preflight_key ~ ('^earlybird[.]fulfillment[.]'||replace(order_id::text,'-','')||'([.]r[0-9]{1,3})?$')
$$;
REVOKE ALL ON FUNCTION dev_cloud_six.matches_rebound_preflight(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

DO $plus_fixtures$
DECLARE
    definition text;
    receipt_joins constant text := $joins$
    LEFT JOIN public.analysis_preflights origin ON origin.user_id=b.user_id
      AND origin.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot
      AND origin.access_mode='production' AND origin.created_at>=w.opened_at
    LEFT JOIN dev_cloud_six.order_receipts q ON q.wave=b.wave AND q.slot=b.slot
      AND q.preflight_id=origin.id AND q.actual_charge_krw=0
    LEFT JOIN public.earlybird_orders o ON o.id=q.order_id AND o.user_id=b.user_id
      AND o.actual_amount_krw=0 AND o.plan_id=w.fixture_plan
    LEFT JOIN public.analysis_preflights p ON p.user_id=b.user_id
      AND p.id=coalesce(o.preflight_id,origin.id)
      AND (p.id=origin.id OR (w.fixture_plan='plus'
        AND dev_cloud_six.matches_rebound_preflight(o.id,p.idempotency_key)))
$joins$;
BEGIN
    definition := pg_get_functiondef('public.dev_cloud_six_open_v1(text)'::regprocedure);
    IF strpos(definition, 'generate_series(1,6)') = 0 OR strpos(definition, 'IF enrolled<>6') = 0 THEN
        RAISE EXCEPTION 'DEV_PLUS_OPEN_DRIFT';
    END IF;
    definition := replace(definition, 'public.dev_cloud_six_open_v1(', 'public.dev_cloud_six_open_plus_v1(');
    definition := replace(definition, 'generate_series(1,6)', 'generate_series(1,4)');
    definition := replace(definition, 'IF enrolled<>6', 'IF enrolled<>4');
    definition := replace(definition, 'INSERT INTO dev_cloud_six.waves VALUES (p_wave,opened,opened+interval ''3 hours'',NULL);',
        'INSERT INTO dev_cloud_six.waves(digest,opened_at,expires_at,fixture_plan) VALUES (p_wave,opened,opened+interval ''3 hours'',''plus'');');
    definition := replace(definition, 'WHERE digest=p_wave AND closed_at IS NULL AND expires_at>opened',
        'WHERE digest=p_wave AND fixture_plan=''plus'' AND closed_at IS NULL AND expires_at>opened');
    IF strpos(definition, 'opened+interval ''3 hours'',''plus''') = 0 THEN
        RAISE EXCEPTION 'DEV_PLUS_OPEN_INSERT_DRIFT';
    END IF;
    EXECUTE definition;

    definition := pg_get_functiondef('public.dev_cloud_six_scope_v1(text,uuid,uuid,uuid,uuid)'::regprocedure);
    definition := replace(definition, $scope$
    LEFT JOIN public.analysis_preflights p ON p.user_id=b.user_id AND p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot
    LEFT JOIN public.earlybird_orders o ON o.preflight_id=p.id AND o.user_id=b.user_id$scope$, rtrim(receipt_joins));
    definition := replace(definition, 'o.plan_id=''standard''', 'o.plan_id=w.fixture_plan');
    definition := replace(definition, 'r.selected_plan_id_snapshot=''standard''', 'r.selected_plan_id_snapshot=w.fixture_plan');
    definition := replace(definition, 'p.admission_selected_plan_id=''standard''', 'p.admission_selected_plan_id=w.fixture_plan');
    definition := replace(definition, 'e.preflight_id=p.id', 'e.preflight_id=origin.id');
    IF strpos(definition, 'r.selected_plan_id_snapshot=w.fixture_plan')=0 OR strpos(definition,'e.preflight_id=origin.id')=0
        OR strpos(definition,'p.id=coalesce(o.preflight_id,origin.id)')=0 THEN RAISE EXCEPTION 'DEV_PLUS_SCOPE_DRIFT'; END IF;
    EXECUTE definition;

    definition := pg_get_functiondef('public.dev_cloud_six_order_state_v1(text)'::regprocedure);
    definition := replace(definition, $state$
    LEFT JOIN public.analysis_preflights p ON p.user_id=b.user_id AND p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot
        AND p.access_mode='production' AND p.created_at>=w.opened_at
    LEFT JOIN dev_cloud_six.order_receipts q ON q.wave=b.wave AND q.slot=b.slot AND q.preflight_id=p.id
    LEFT JOIN public.earlybird_orders o ON o.id=q.order_id AND o.user_id=b.user_id AND o.preflight_id=p.id$state$, rtrim(receipt_joins));
    IF strpos(definition,'p.id=coalesce(o.preflight_id,origin.id)')=0 THEN RAISE EXCEPTION 'DEV_PLUS_STATE_DRIFT'; END IF;
    EXECUTE definition;

    definition := pg_get_functiondef('dev_cloud_six.validate_fixture_order()'::regprocedure);
    definition := replace(definition, 'dev_cloud_six.buyers b USING(wave,slot)',
        'dev_cloud_six.buyers b USING(wave,slot) JOIN dev_cloud_six.waves w ON w.digest=q.wave');
    definition := replace(definition, 'WHERE q.order_id=NEW.id', 'WHERE w.fixture_plan=NEW.plan_id AND q.order_id=NEW.id');
    definition := replace(definition, 'OR NEW.plan_id IS DISTINCT FROM ''standard'' OR NEW.target_instagram_id', 'OR NEW.target_instagram_id');
    IF strpos(definition, 'WHERE w.fixture_plan=NEW.plan_id') = 0 THEN RAISE EXCEPTION 'DEV_PLUS_TRIGGER_DRIFT'; END IF;
    EXECUTE definition;

    definition := pg_get_functiondef('public.dev_cloud_six_create_order_v1(text,uuid,uuid)'::regprocedure);
    definition := replace(definition, 'price integer; ts timestamptz;', 'price integer; ts timestamptz; plan text;');
    definition := replace(definition, 'PERFORM 1 FROM dev_cloud_six.waves WHERE digest=p_wave',
        'SELECT fixture_plan INTO plan FROM dev_cloud_six.waves WHERE digest=p_wave');
    definition := replace(definition, '->''standard''', '->plan');
    definition := replace(definition, 'p.excluded_instagram_id,''standard'',p.pricing_version', 'p.excluded_instagram_id,plan,p.pricing_version');
    definition := replace(definition, 'OR p.target_followers_count IS NULL OR p.target_following_count IS NULL',
        'OR p.target_followers_count IS NULL OR p.target_following_count IS NULL
        OR (plan=''plus'' AND greatest(p.target_followers_count,p.target_following_count) NOT BETWEEN 801 AND 1200)');
    IF strpos(definition, 'p.excluded_instagram_id,plan,p.pricing_version') = 0 THEN RAISE EXCEPTION 'DEV_PLUS_ORDER_DRIFT'; END IF;
    EXECUTE definition;

    definition := pg_get_functiondef('public.handoff_dev_cloud_six_fulfillment_v1(text,uuid,integer,integer,uuid)'::regprocedure);
    definition := replace(definition, 'p.admission_selected_plan_id=''standard''', 'p.admission_selected_plan_id=o.plan_id');
    definition := replace(definition,'p.id=o.preflight_id AND p.id=q.preflight_id','p.id=o.preflight_id');
    IF strpos(definition,'p.id=q.preflight_id')>0 OR strpos(definition,'p.admission_selected_plan_id=o.plan_id')=0
        THEN RAISE EXCEPTION 'DEV_PLUS_HANDOFF_DRIFT'; END IF;
    EXECUTE definition;
    definition := pg_get_functiondef('public.complete_dev_cloud_six_order_v1(text,uuid)'::regprocedure);
    definition := replace(definition, 's.plan_id=''standard''', 's.plan_id=o.plan_id');
    definition := replace(definition,'o.user_id,q.preflight_id,q.order_id,r.id','o.user_id,r.preflight_id,q.order_id,r.id');
    IF strpos(definition,'o.user_id,r.preflight_id,q.order_id,r.id')=0 OR strpos(definition,'s.plan_id=o.plan_id')=0
        THEN RAISE EXCEPTION 'DEV_PLUS_COMPLETE_DRIFT'; END IF;
    EXECUTE definition;

    definition := pg_get_functiondef('public.dev_cloud_six_capacity_lineage_v1(text,uuid)'::regprocedure);
    definition := replace(definition,$lineage$p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot$lineage$,$lineage$
        (p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot OR EXISTS (
            SELECT FROM dev_cloud_six.order_receipts q JOIN dev_cloud_six.waves w ON w.digest=q.wave
            JOIN public.earlybird_orders o ON o.id=q.order_id AND o.user_id=b.user_id
            JOIN public.analysis_preflights origin ON origin.id=q.preflight_id AND origin.user_id=b.user_id
            WHERE q.wave=b.wave AND q.slot=b.slot AND w.fixture_plan='plus'
              AND q.actual_charge_krw=0 AND o.actual_amount_krw=0 AND o.plan_id='plus'
              AND o.preflight_id=p.id AND origin.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot
              AND dev_cloud_six.matches_rebound_preflight(o.id,p.idempotency_key)
        ))$lineage$);
    IF strpos(definition,'dev_cloud_six.matches_rebound_preflight')=0 THEN RAISE EXCEPTION 'DEV_PLUS_LINEAGE_DRIFT'; END IF;
    EXECUTE definition;
END;
$plus_fixtures$;

REVOKE ALL ON FUNCTION public.dev_cloud_six_open_plus_v1(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dev_cloud_six_open_plus_v1(text) TO service_role;

-- Null out neither ledger nor fulfillment rows when a fixture wave is closed.
CREATE FUNCTION dev_cloud_six.closed_fixture_order(order_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS (SELECT FROM dev_cloud_six.order_receipts q JOIN dev_cloud_six.waves w ON w.digest=q.wave
                   JOIN public.earlybird_orders o ON o.id=q.order_id
                   WHERE q.order_id=$1 AND q.actual_charge_krw=0 AND o.actual_amount_krw=0 AND w.closed_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION dev_cloud_six.closed_fixture_order(uuid) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA dev_cloud_six TO service_role;
GRANT EXECUTE ON FUNCTION dev_cloud_six.closed_fixture_order(uuid) TO service_role;

DO $dev_seats$
DECLARE
    routine record;
    definition text;
BEGIN
    FOR routine IN SELECT * FROM (VALUES
        ('public.paid_analysis_capacity_available_v1(integer)', 'WHERE o.plan_id IN (''basic'', ''standard'', ''plus'')'),
        ('public.paid_analysis_capacity_has_room_v1(uuid,timestamptz,integer)', 'WHERE f.status IN (''awaiting_operator'',''admission_pending'',''retryable_failure'')'),
        ('public.list_signed_paid_analysis_admissions_v1(integer)', 'WHERE f.status=''awaiting_operator'''),
        ('public.list_recoverable_earlybird_fulfillments(integer)', 'WHERE f.status IN (''admission_pending'',''retryable_failure'')')
    ) AS predicates(signature, old_filter) LOOP
        definition := pg_get_functiondef(routine.signature::regprocedure);
        IF strpos(definition,routine.old_filter)=0 THEN RAISE EXCEPTION 'DEV_PLUS_SEAT_DRIFT %',routine.signature; END IF;
        EXECUTE replace(definition,routine.old_filter,routine.old_filter||' AND NOT dev_cloud_six.closed_fixture_order(o.id)');
    END LOOP;
END;
$dev_seats$;

UPDATE public.paid_analysis_capacity_policy SET max_active=3, validation_ref='dev-plus-900-three-shared',
    expected_basic_max_minutes=NULL, expected_standard_max_minutes=NULL WHERE singleton;

COMMIT;
