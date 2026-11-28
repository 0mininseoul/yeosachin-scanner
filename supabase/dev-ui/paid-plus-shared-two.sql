-- Dev-only follow-up to paid-plus-shared-three.sql. Run before opening the two-seat rehearsal.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';

DO $dev_only$
DECLARE
    definition text;
BEGIN
    IF to_regclass('dev_ui.runs') IS NULL
        OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR to_regclass('dev_cloud_six.waves') IS NULL
        OR to_regnamespace('paid_standard_capacity') IS NOT NULL
        OR to_regprocedure('public.dev_cloud_six_open_plus_two_v1(text)') IS NOT NULL THEN
        RAISE EXCEPTION 'DEV_PLUS_TWO_SCOPE';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('dev-cloud-six-registry-v1', 0));
    PERFORM 1 FROM public.paid_analysis_capacity_policy
        WHERE singleton AND max_active=3 AND validation_ref='dev-plus-900-three-shared'
        FOR UPDATE;
    IF NOT FOUND
        OR EXISTS (SELECT FROM dev_cloud_six.waves WHERE closed_at IS NULL)
        OR public.paid_analysis_capacity_available_v1(3) <> 3
        OR EXISTS (
            SELECT FROM public.earlybird_fulfillments f
            JOIN public.earlybird_orders o ON o.id=f.order_id
            WHERE o.status='paid' AND f.status IN ('awaiting_operator','admission_pending','retryable_failure')
                AND NOT dev_cloud_six.closed_fixture_order(o.id)
        ) THEN
        RAISE EXCEPTION 'DEV_PLUS_TWO_ALREADY_IN_USE';
    END IF;

    definition := pg_get_functiondef('public.dev_cloud_six_open_plus_v1(text)'::regprocedure);
    IF strpos(definition, 'public.dev_cloud_six_open_plus_v1(') = 0
        OR strpos(definition, 'generate_series(1,4)') = 0
        OR strpos(definition, 'IF enrolled<>4') = 0
        OR strpos(definition, 'fixture_plan=''plus''') = 0 THEN
        RAISE EXCEPTION 'DEV_PLUS_TWO_OPEN_DRIFT';
    END IF;
    definition := replace(definition, 'public.dev_cloud_six_open_plus_v1(', 'public.dev_cloud_six_open_plus_two_v1(');
    definition := replace(definition, 'generate_series(1,4)', 'generate_series(1,3)');
    definition := replace(definition, 'IF enrolled<>4', 'IF enrolled<>3');
    EXECUTE definition;
END;
$dev_only$;

REVOKE ALL ON FUNCTION public.dev_cloud_six_open_plus_two_v1(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dev_cloud_six_open_plus_two_v1(text) TO service_role;

UPDATE public.paid_analysis_capacity_policy
    SET max_active=2, validation_ref='dev-plus-900-two-rehearsal'
    WHERE singleton;
COMMIT;
