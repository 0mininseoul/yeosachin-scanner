-- Operator console: test/dev order filter, durable per-lead preflight
-- outcomes, and user demographics.
--
-- 1. Real orders only.  Orders with no charged amount (0 KRW) or whose
--    preflight ran in test_entitlement mode (Dev live analyses) are excluded
--    from the console order list, payer metrics and per-user paid totals.
-- 2. Preflight outcome on the lead.  Preflight rows are purged after expiry,
--    so the console could not tell what happened to an input.  The outcome
--    (processing / completed / failed + reason, PII-free counts) is now copied
--    onto the target lead row when the preflight changes state, when a lead is
--    bound to a preflight, and when a failure is recorded.  Failures raised
--    before a preflight row exists are matched through the landing journey.
--    Target name, bio and photo are NOT copied.
-- 3. User demographics and daily signups for the console user menu.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.admin_console_is_real_order(
    p_actual_amount_krw INTEGER,
    p_expected_amount_krw INTEGER,
    p_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT COALESCE(p_actual_amount_krw, p_expected_amount_krw, 0) > 0
       AND NOT EXISTS (
           SELECT 1 FROM public.analysis_preflights AS preflight
           WHERE preflight.id = p_preflight_id
             AND preflight.access_mode = 'test_entitlement'
       );
$$;

-- ---------- durable preflight outcome on the lead ----------

ALTER TABLE public.landing_leads
    ADD COLUMN IF NOT EXISTS preflight_status TEXT
        CONSTRAINT landing_leads_preflight_status_check CHECK (
            preflight_status IS NULL OR preflight_status IN ('processing', 'completed', 'failed')
        ),
    ADD COLUMN IF NOT EXISTS preflight_stage TEXT
        CONSTRAINT landing_leads_preflight_stage_check CHECK (
            preflight_stage IS NULL OR preflight_stage IN ('request', 'profile', 'exclusion', 'preflight')
        ),
    ADD COLUMN IF NOT EXISTS preflight_error_code TEXT
        CONSTRAINT landing_leads_preflight_error_code_check CHECK (
            preflight_error_code IS NULL OR preflight_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
        ),
    ADD COLUMN IF NOT EXISTS preflight_outcome_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS preflight_followers_count INTEGER,
    ADD COLUMN IF NOT EXISTS preflight_following_count INTEGER,
    ADD COLUMN IF NOT EXISTS preflight_is_private BOOLEAN,
    ADD COLUMN IF NOT EXISTS preflight_required_plan_id TEXT
        CONSTRAINT landing_leads_preflight_required_plan_check CHECK (
            preflight_required_plan_id IS NULL OR preflight_required_plan_id ~ '^[a-z_]{1,16}$'
        );

ALTER TABLE public.analysis_preflight_failures
    ADD COLUMN IF NOT EXISTS landing_journey_id UUID;

CREATE INDEX IF NOT EXISTS landing_leads_source_preflight_idx
    ON public.landing_leads(source_preflight_id)
    WHERE source_preflight_id IS NOT NULL;

-- Writes the outcome for every target lead bound to one preflight row.
CREATE OR REPLACE FUNCTION public.admin_console_apply_preflight_outcome(p_preflight public.analysis_preflights)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_status TEXT;
    v_code TEXT;
BEGIN
    IF p_preflight.status IN ('ready', 'consumed')
       OR (p_preflight.status = 'expired' AND p_preflight.ready_at IS NOT NULL) THEN
        v_status := 'completed';
    ELSIF p_preflight.status = 'blocked' THEN
        v_status := 'failed';
        v_code := COALESCE(p_preflight.error_code, 'ANALYSIS_FAILED');
    ELSIF p_preflight.status = 'expired' THEN
        v_status := 'failed';
        v_code := 'PREFLIGHT_EXPIRED';
    ELSE
        v_status := 'processing';
    END IF;
    IF v_code IS NOT NULL AND v_code !~ '^[A-Z][A-Z0-9_]{1,63}$' THEN
        v_code := 'ANALYSIS_FAILED';
    END IF;

    UPDATE public.landing_leads AS lead
    SET preflight_status = v_status,
        preflight_stage = CASE WHEN v_status = 'failed' THEN 'preflight' ELSE NULL END,
        preflight_error_code = v_code,
        preflight_outcome_at = CASE
            WHEN v_status = 'completed' THEN COALESCE(p_preflight.ready_at, p_preflight.updated_at)
            WHEN v_status = 'failed' THEN COALESCE(p_preflight.blocked_at, p_preflight.updated_at)
            ELSE p_preflight.updated_at
        END,
        preflight_followers_count = CASE WHEN v_status = 'completed'
            THEN p_preflight.target_followers_count ELSE lead.preflight_followers_count END,
        preflight_following_count = CASE WHEN v_status = 'completed'
            THEN p_preflight.target_following_count ELSE lead.preflight_following_count END,
        preflight_is_private = CASE WHEN v_status = 'completed'
            THEN p_preflight.target_is_private ELSE lead.preflight_is_private END,
        preflight_required_plan_id = CASE WHEN v_status = 'completed'
            THEN p_preflight.required_plan_id ELSE lead.preflight_required_plan_id END
    WHERE lead.source_preflight_id = p_preflight.id
      AND lead.input_context = 'target'
      -- A completed outcome is final; later scrubbing or expiry never downgrades it.
      AND lead.preflight_status IS DISTINCT FROM 'completed';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_console_preflight_outcome_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    BEGIN
        PERFORM public.admin_console_apply_preflight_outcome(NEW);
    EXCEPTION WHEN OTHERS THEN
        -- Reporting only: never block the preflight lifecycle.
        NULL;
    END;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_console_preflight_outcome ON public.analysis_preflights;
CREATE TRIGGER admin_console_preflight_outcome
    AFTER INSERT OR UPDATE OF status ON public.analysis_preflights
    FOR EACH ROW EXECUTE FUNCTION public.admin_console_preflight_outcome_trigger();

CREATE OR REPLACE FUNCTION public.admin_console_lead_bound_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF NEW.input_context = 'target' AND NEW.source_preflight_id IS NOT NULL THEN
        BEGIN
            SELECT * INTO v_preflight FROM public.analysis_preflights WHERE id = NEW.source_preflight_id;
            IF FOUND THEN
                PERFORM public.admin_console_apply_preflight_outcome(v_preflight);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS admin_console_lead_bound ON public.landing_leads;
CREATE TRIGGER admin_console_lead_bound
    AFTER UPDATE OF source_preflight_id ON public.landing_leads
    FOR EACH ROW
    WHEN (NEW.source_preflight_id IS NOT NULL AND NEW.source_preflight_id IS DISTINCT FROM OLD.source_preflight_id)
    EXECUTE FUNCTION public.admin_console_lead_bound_trigger();

CREATE OR REPLACE FUNCTION public.admin_console_preflight_failure_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    BEGIN
        UPDATE public.landing_leads AS lead
        SET preflight_status = 'failed',
            preflight_stage = NEW.stage,
            preflight_error_code = NEW.error_code,
            preflight_outcome_at = NEW.occurred_at
        WHERE lead.input_context = 'target'
          AND lead.preflight_status IS DISTINCT FROM 'completed'
          AND (
              (NEW.preflight_id IS NOT NULL AND lead.source_preflight_id = NEW.preflight_id)
              OR (NEW.landing_journey_id IS NOT NULL AND lead.journey_id = NEW.landing_journey_id)
          );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS admin_console_preflight_failure ON public.analysis_preflight_failures;
CREATE TRIGGER admin_console_preflight_failure
    AFTER INSERT ON public.analysis_preflight_failures
    FOR EACH ROW EXECUTE FUNCTION public.admin_console_preflight_failure_trigger();

-- Backfill what can still be proven: preflights that still exist, then
-- failures recorded against a bound preflight id.
DO $backfill$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    FOR v_preflight IN
        SELECT preflight.* FROM public.analysis_preflights AS preflight
        WHERE EXISTS (SELECT 1 FROM public.landing_leads AS lead WHERE lead.source_preflight_id = preflight.id)
    LOOP
        PERFORM public.admin_console_apply_preflight_outcome(v_preflight);
    END LOOP;
END;
$backfill$;

UPDATE public.landing_leads AS lead
SET preflight_status = 'failed',
    preflight_stage = failure.stage,
    preflight_error_code = failure.error_code,
    preflight_outcome_at = failure.occurred_at
FROM (
    SELECT DISTINCT ON (preflight_id) preflight_id, stage, error_code, occurred_at
    FROM public.analysis_preflight_failures
    WHERE preflight_id IS NOT NULL
    ORDER BY preflight_id, occurred_at DESC
) AS failure
WHERE lead.source_preflight_id = failure.preflight_id
  AND lead.input_context = 'target'
  AND lead.preflight_status IS NULL;

-- ---------- user demographics ----------

CREATE OR REPLACE FUNCTION public.load_admin_user_stats(p_now TIMESTAMPTZ, p_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tz CONSTANT TEXT := 'Asia/Seoul';
    v_today DATE;
    v_year INTEGER;
    v_result JSONB;
BEGIN
    IF p_now IS NULL OR p_days IS NULL OR p_days NOT BETWEEN 7 AND 120 THEN
        RAISE EXCEPTION 'ADMIN_USER_STATS_INVALID';
    END IF;
    v_today := (p_now AT TIME ZONE v_tz)::DATE;
    v_year := pg_catalog.date_part('year', p_now AT TIME ZONE v_tz)::INTEGER;

    WITH base AS (
        SELECT account.id,
               CASE
                   WHEN account.gender IN ('female', '여성') THEN 'female'
                   WHEN account.gender IN ('male', '남성') THEN 'male'
                   ELSE 'unknown'
               END AS gender,
               CASE
                   WHEN account.birthyear IS NULL OR account.birthyear !~ '^[0-9]{4}$' THEN 'unknown'
                   WHEN v_year - account.birthyear::INTEGER + 1 < 20 THEN '10s'
                   WHEN v_year - account.birthyear::INTEGER + 1 < 25 THEN '20_24'
                   WHEN v_year - account.birthyear::INTEGER + 1 < 30 THEN '25_29'
                   WHEN v_year - account.birthyear::INTEGER + 1 < 35 THEN '30_34'
                   WHEN v_year - account.birthyear::INTEGER + 1 < 40 THEN '35_39'
                   ELSE '40_plus'
               END AS age_band,
               COALESCE(account.signup_attribution_label, 'unknown') AS source,
               EXISTS (
                   SELECT 1 FROM public.earlybird_orders AS o
                   WHERE o.user_id = account.id AND o.paid_at IS NOT NULL
                     AND o.status IN ('paid', 'analysis_in_progress', 'completed')
                     AND public.admin_console_is_real_order(o.actual_amount_krw, o.expected_amount_krw, o.preflight_id)
               ) AS paid,
               (account.created_at AT TIME ZONE v_tz)::DATE AS signup_day
        FROM public.users AS account
    ), days AS (
        SELECT series.day::DATE AS day
        FROM pg_catalog.generate_series(v_today - (p_days - 1), v_today, INTERVAL '1 day') AS series(day)
    )
    SELECT pg_catalog.jsonb_build_object(
        'total', (SELECT pg_catalog.count(*) FROM base),
        'paidUsers', (SELECT pg_catalog.count(*) FILTER (WHERE paid) FROM base),
        'byGenderAge', (
            SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'gender', grouped.gender, 'ageBand', grouped.age_band, 'users', grouped.users, 'paidUsers', grouped.paid_users
            ) ORDER BY grouped.age_band, grouped.gender), '[]'::JSONB)
            FROM (
                SELECT gender, age_band, pg_catalog.count(*) AS users, pg_catalog.count(*) FILTER (WHERE paid) AS paid_users
                FROM base GROUP BY gender, age_band
            ) AS grouped
        ),
        'bySource', (
            SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'source', grouped.source, 'users', grouped.users, 'paidUsers', grouped.paid_users
            ) ORDER BY grouped.users DESC), '[]'::JSONB)
            FROM (
                SELECT source, pg_catalog.count(*) AS users, pg_catalog.count(*) FILTER (WHERE paid) AS paid_users
                FROM base GROUP BY source
            ) AS grouped
        ),
        'daily', (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'day', days.day,
                'signups', (SELECT pg_catalog.count(*) FROM base WHERE base.signup_day = days.day)
            ) ORDER BY days.day)
            FROM days
        )
    ) INTO v_result;
    RETURN v_result;
END;
$$;

-- ---------- console projections (re-created with the filters above) ----------

DROP FUNCTION IF EXISTS public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.load_admin_console_overview(
    p_now TIMESTAMPTZ,
    p_conversion_since TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_tz CONSTANT TEXT := 'Asia/Seoul';
    v_today DATE;
    v_week DATE;
    v_daily_from DATE;
    v_weekly_from DATE;
    v_from_ts TIMESTAMPTZ;
    v_result JSONB;
BEGIN
    IF p_now IS NULL OR p_conversion_since IS NULL OR p_conversion_since > p_now THEN
        RAISE EXCEPTION 'ADMIN_CONSOLE_OVERVIEW_INVALID';
    END IF;
    v_today := (p_now AT TIME ZONE v_tz)::DATE;
    v_week := pg_catalog.date_trunc('week', p_now AT TIME ZONE v_tz)::DATE;
    v_daily_from := v_today - 13;
    v_weekly_from := v_week - 49;
    v_from_ts := LEAST(v_weekly_from, v_daily_from)::TIMESTAMP AT TIME ZONE v_tz;

    WITH paid_orders AS (
        SELECT orders.user_id,
               orders.plan_id,
               (orders.paid_at AT TIME ZONE v_tz)::DATE AS paid_day
        FROM public.earlybird_orders AS orders
        WHERE orders.paid_at >= v_from_ts
          AND orders.paid_at <= p_now
          AND orders.status IN ('paid', 'analysis_in_progress', 'completed')
          AND public.admin_console_is_real_order(orders.actual_amount_krw, orders.expected_amount_krw, orders.preflight_id)
    ), spend AS (
        SELECT (run.reserved_at AT TIME ZONE v_tz)::DATE AS spend_day,
               'preflight'::TEXT AS source,
               CASE
                   WHEN run.status = 'resolved_no_run' THEN 0::NUMERIC
                   WHEN run.usage_reconciled_at IS NOT NULL AND run.actual_usage_usd IS NOT NULL
                       THEN run.actual_usage_usd
                   ELSE 0::NUMERIC
               END AS known_usd,
               CASE
                   WHEN run.status = 'resolved_no_run' THEN 0::NUMERIC
                   WHEN run.usage_reconciled_at IS NOT NULL AND run.actual_usage_usd IS NOT NULL
                       THEN run.actual_usage_usd
                   ELSE run.max_charge_usd
               END AS conservative_usd,
               (run.status <> 'resolved_no_run'
                AND (run.usage_reconciled_at IS NULL OR run.actual_usage_usd IS NULL)) AS unsettled
        FROM public.analysis_preflight_provider_runs AS run
        WHERE run.reserved_at >= v_from_ts
          AND run.reserved_at <= p_now
        UNION ALL
        SELECT (run.reserved_at AT TIME ZONE v_tz)::DATE,
               'analysis'::TEXT,
               CASE
                   WHEN run.usage_reconciled_at IS NOT NULL AND run.actual_usage_usd IS NOT NULL
                       THEN run.actual_usage_usd
                   ELSE 0::NUMERIC
               END,
               CASE
                   WHEN run.usage_reconciled_at IS NOT NULL AND run.actual_usage_usd IS NOT NULL
                       THEN run.actual_usage_usd
                   ELSE run.max_charge_usd
               END,
               (run.usage_reconciled_at IS NULL OR run.actual_usage_usd IS NULL)
        FROM public.analysis_v2_provider_runs AS run
        WHERE run.reserved_at >= v_from_ts
          AND run.reserved_at <= p_now
        UNION ALL
        SELECT (attempt.created_at AT TIME ZONE v_tz)::DATE,
               'ai'::TEXT,
               CASE
                   WHEN attempt.status IN ('rejected', 'rate_limited') THEN 0::NUMERIC
                   ELSE COALESCE(attempt.metered_estimated_cost_usd, 0::NUMERIC)
               END,
               CASE
                   WHEN attempt.status IN ('rejected', 'rate_limited') THEN 0::NUMERIC
                   ELSE COALESCE(attempt.metered_estimated_cost_usd, attempt.estimated_cost_usd, 0::NUMERIC)
               END,
               (attempt.status NOT IN ('rejected', 'rate_limited')
                AND attempt.metered_estimated_cost_usd IS NULL)
        FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.created_at >= v_from_ts
          AND attempt.created_at <= p_now
    ), daily_spend AS (
        SELECT spend.spend_day,
               pg_catalog.sum(spend.known_usd) AS known_usd,
               pg_catalog.sum(spend.conservative_usd) AS conservative_usd,
               pg_catalog.sum(spend.known_usd) FILTER (WHERE spend.source = 'preflight') AS preflight_usd,
               pg_catalog.sum(spend.known_usd) FILTER (WHERE spend.source = 'analysis') AS analysis_usd,
               pg_catalog.sum(spend.known_usd) FILTER (WHERE spend.source = 'ai') AS ai_usd,
               pg_catalog.count(*) FILTER (WHERE spend.unsettled) AS unsettled_calls
        FROM spend
        GROUP BY spend.spend_day
    ), daily_paid AS (
        SELECT paid.paid_day,
               pg_catalog.count(DISTINCT paid.user_id) AS payers,
               pg_catalog.count(DISTINCT paid.user_id) FILTER (WHERE paid.plan_id = 'basic') AS basic_payers,
               pg_catalog.count(DISTINCT paid.user_id) FILTER (WHERE paid.plan_id <> 'basic') AS standard_payers
        FROM paid_orders AS paid
        GROUP BY paid.paid_day
    ), days AS (
        SELECT series.day::DATE AS day
        FROM pg_catalog.generate_series(v_daily_from, v_today, INTERVAL '1 day') AS series(day)
    ), weeks AS (
        SELECT series.week::DATE AS week
        FROM pg_catalog.generate_series(v_weekly_from, v_week, INTERVAL '7 days') AS series(week)
    ), daily AS (
        SELECT days.day AS start,
               COALESCE(paid.payers, 0) AS payers,
               COALESCE(paid.basic_payers, 0) AS basic_payers,
               COALESCE(paid.standard_payers, 0) AS standard_payers,
               COALESCE(cost.known_usd, 0) AS known_usd,
               COALESCE(cost.conservative_usd, 0) AS conservative_usd,
               COALESCE(cost.preflight_usd, 0) AS preflight_usd,
               COALESCE(cost.analysis_usd, 0) AS analysis_usd,
               COALESCE(cost.ai_usd, 0) AS ai_usd,
               COALESCE(cost.unsettled_calls, 0) AS unsettled_calls
        FROM days
        LEFT JOIN daily_paid AS paid ON paid.paid_day = days.day
        LEFT JOIN daily_spend AS cost ON cost.spend_day = days.day
    ), weekly AS (
        SELECT weeks.week AS start,
               (SELECT pg_catalog.count(DISTINCT paid.user_id) FROM paid_orders AS paid
                WHERE paid.paid_day >= weeks.week AND paid.paid_day < weeks.week + 7) AS payers,
               (SELECT pg_catalog.count(DISTINCT paid.user_id) FROM paid_orders AS paid
                WHERE paid.paid_day >= weeks.week AND paid.paid_day < weeks.week + 7
                  AND paid.plan_id = 'basic') AS basic_payers,
               (SELECT pg_catalog.count(DISTINCT paid.user_id) FROM paid_orders AS paid
                WHERE paid.paid_day >= weeks.week AND paid.paid_day < weeks.week + 7
                  AND paid.plan_id <> 'basic') AS standard_payers,
               COALESCE(pg_catalog.sum(cost.known_usd), 0) AS known_usd,
               COALESCE(pg_catalog.sum(cost.conservative_usd), 0) AS conservative_usd,
               COALESCE(pg_catalog.sum(cost.preflight_usd), 0) AS preflight_usd,
               COALESCE(pg_catalog.sum(cost.analysis_usd), 0) AS analysis_usd,
               COALESCE(pg_catalog.sum(cost.ai_usd), 0) AS ai_usd,
               COALESCE(pg_catalog.sum(cost.unsettled_calls), 0) AS unsettled_calls
        FROM weeks
        LEFT JOIN daily_spend AS cost
            ON cost.spend_day >= weeks.week AND cost.spend_day < weeks.week + 7
        GROUP BY weeks.week
    )
    SELECT pg_catalog.jsonb_build_object(
        'signups', (
            SELECT pg_catalog.jsonb_build_object(
                'total', pg_catalog.count(*),
                'today', pg_catalog.count(*) FILTER (
                    WHERE (account.created_at AT TIME ZONE v_tz)::DATE = v_today),
                'last7Days', pg_catalog.count(*) FILTER (
                    WHERE (account.created_at AT TIME ZONE v_tz)::DATE > v_today - 7)
            )
            FROM public.users AS account
        ),
        'payersSinceConversion', (
            SELECT pg_catalog.count(DISTINCT orders.user_id)
            FROM public.earlybird_orders AS orders
            WHERE orders.paid_at >= p_conversion_since
              AND orders.paid_at <= p_now
              AND orders.status IN ('paid', 'analysis_in_progress', 'completed')
              AND public.admin_console_is_real_order(orders.actual_amount_krw, orders.expected_amount_krw, orders.preflight_id)
        ),
        'daily', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'start', daily.start, 'payers', daily.payers,
            'basicPayers', daily.basic_payers, 'standardPayers', daily.standard_payers,
            'knownCostUsd', daily.known_usd, 'conservativeCostUsd', daily.conservative_usd,
            'preflightCostUsd', daily.preflight_usd, 'analysisCostUsd', daily.analysis_usd,
            'aiCostUsd', daily.ai_usd, 'unsettledCalls', daily.unsettled_calls
        ) ORDER BY daily.start) FROM daily),
        'weekly', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'start', weekly.start, 'payers', weekly.payers,
            'basicPayers', weekly.basic_payers, 'standardPayers', weekly.standard_payers,
            'knownCostUsd', weekly.known_usd, 'conservativeCostUsd', weekly.conservative_usd,
            'preflightCostUsd', weekly.preflight_usd, 'analysisCostUsd', weekly.analysis_usd,
            'aiCostUsd', weekly.ai_usd, 'unsettledCalls', weekly.unsettled_calls
        ) ORDER BY weekly.start) FROM weekly)
    )
    INTO v_result;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_admin_orders(
    p_cursor_paid_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL,
    p_page_size INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
BEGIN
    IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 51
       OR ((p_cursor_paid_at IS NULL) <> (p_cursor_id IS NULL)) THEN
        RAISE EXCEPTION 'ADMIN_ORDERS_FILTER_INVALID';
    END IF;

    WITH page AS (
        SELECT orders.*
        FROM public.earlybird_orders AS orders
        WHERE orders.paid_at IS NOT NULL
          AND public.admin_console_is_real_order(orders.actual_amount_krw, orders.expected_amount_krw, orders.preflight_id)
          AND (
              p_cursor_paid_at IS NULL
              OR (orders.paid_at, orders.id) < (p_cursor_paid_at, p_cursor_id)
          )
        ORDER BY orders.paid_at DESC, orders.id DESC
        LIMIT p_page_size
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'orderId', page.id,
        'requestId', COALESCE(bundle.request_id, page.result_request_id),
        'orderStatus', page.status,
        'planId', page.plan_id,
        'targetInstagramId', page.target_instagram_id,
        'excludedInstagramId', page.excluded_instagram_id,
        'paidAt', page.paid_at,
        'paidAmountKrw', page.actual_amount_krw,
        'userName', account.name,
        'gender', account.gender,
        'birthyear', account.birthyear,
        'attributionLabel', account.signup_attribution_label,
        'deviceLabel', page.client_device_label,
        'bundle', CASE WHEN bundle.request_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
            'version', bundle.version,
            'completenessStatus', bundle.completeness_status,
            'gapCodes', pg_catalog.to_jsonb(bundle.gap_codes),
            'costStatus', bundle.cost_status,
            'knownUsd', bundle.cost_known_usd,
            'conservativeUsd', bundle.cost_conservative_usd,
            'assembledAt', bundle.assembled_at,
            'retentionState', CASE
                WHEN queue.request_id IS NULL THEN 'unknown'
                WHEN queue.purge_fenced_at IS NOT NULL THEN 'fenced'
                WHEN queue.status = 'completed' THEN 'retained'
                ELSE 'pending'
            END
        ) END,
        'costSnapshot', CASE WHEN snapshot.request_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
            'knownUsd', CASE WHEN snapshot.usage_unknown THEN NULL ELSE snapshot.total_known_cost_usd END,
            'conservativeUsd', snapshot.total_conservative_cost_usd,
            'complete', snapshot.directly_attributable_cost_complete AND NOT snapshot.usage_unknown,
            'usageUnknown', snapshot.usage_unknown
        ) END,
        'cursorPaidAt', page.paid_at,
        'cursorId', page.id
    ) ORDER BY page.paid_at DESC, page.id DESC), '[]'::JSONB)
    INTO v_rows
    FROM page
    LEFT JOIN public.users AS account ON account.id = page.user_id
    LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM public.analysis_order_audit_bundles AS candidate
        WHERE candidate.order_id = page.id
           OR (page.result_request_id IS NOT NULL AND candidate.request_id = page.result_request_id)
        ORDER BY candidate.version DESC
        LIMIT 1
    ) AS bundle ON TRUE
    LEFT JOIN public.analysis_order_audit_assembly_queue AS queue
        ON queue.request_id = bundle.request_id
    LEFT JOIN public.analysis_v2_cost_rollup_snapshots AS snapshot
        ON snapshot.request_id = page.result_request_id;

    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_admin_users(
    p_search TEXT DEFAULT NULL,
    p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL,
    p_page_size INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
    v_pattern TEXT;
BEGIN
    IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 51
       OR (p_search IS NOT NULL AND pg_catalog.char_length(p_search) NOT BETWEEN 1 AND 100)
       OR ((p_cursor_created_at IS NULL) <> (p_cursor_id IS NULL)) THEN
        RAISE EXCEPTION 'ADMIN_USERS_FILTER_INVALID';
    END IF;
    v_pattern := CASE WHEN p_search IS NULL THEN NULL
        ELSE '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' END;

    WITH page AS (
        SELECT account.*,
               COALESCE(account.created_at, '-infinity'::TIMESTAMPTZ) AS sort_at
        FROM public.users AS account
        WHERE (
            v_pattern IS NULL
            OR account.name ILIKE v_pattern
            OR account.nickname ILIKE v_pattern
            OR account.email ILIKE v_pattern
            OR account.phone_number ILIKE v_pattern
            OR account.phone_number_normalized ILIKE v_pattern
        )
          AND (
              p_cursor_created_at IS NULL
              OR (COALESCE(account.created_at, '-infinity'::TIMESTAMPTZ), account.id) < (p_cursor_created_at, p_cursor_id)
          )
        ORDER BY sort_at DESC, account.id DESC
        LIMIT p_page_size
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(
        (pg_catalog.to_jsonb(page) - 'sort_at') || pg_catalog.jsonb_build_object(
            'paid_order_count', orders.paid_count,
            'paid_amount_krw', orders.paid_amount,
            'last_paid_at', orders.last_paid_at,
            'lead_input_count', leads.lead_count,
            'cursor_created_at', page.sort_at
        )
        ORDER BY page.sort_at DESC, page.id DESC
    ), '[]'::JSONB)
    INTO v_rows
    FROM page
    LEFT JOIN LATERAL (
        SELECT pg_catalog.count(*) FILTER (WHERE o.status IN ('paid', 'analysis_in_progress', 'completed')) AS paid_count,
               COALESCE(pg_catalog.sum(o.actual_amount_krw) FILTER (WHERE o.status IN ('paid', 'analysis_in_progress', 'completed')), 0) AS paid_amount,
               pg_catalog.max(o.paid_at) AS last_paid_at
        FROM public.earlybird_orders AS o
        WHERE o.user_id = page.id AND o.paid_at IS NOT NULL
          AND public.admin_console_is_real_order(o.actual_amount_krw, o.expected_amount_krw, o.preflight_id)
    ) AS orders ON TRUE
    LEFT JOIN LATERAL (
        SELECT pg_catalog.count(*) AS lead_count
        FROM public.landing_leads AS lead
        WHERE lead.auth_user_id = page.id AND lead.input_context = 'target'
    ) AS leads ON TRUE;

    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_admin_lead_inputs(
    p_mapping_status TEXT DEFAULT NULL,
    p_instagram_id TEXT DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL,
    p_page_size INTEGER DEFAULT 25,
    p_preflight_status TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
BEGIN
    IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 51
       OR (p_mapping_status IS NOT NULL AND p_mapping_status NOT IN (
            'legacy_unlinked', 'anonymous_device',
            'authenticated_user', 'unlinked_after_deletion'
       ))
       OR (p_instagram_id IS NOT NULL AND p_instagram_id !~ '^[a-z0-9._]{1,30}$')
       OR ((p_cursor_created_at IS NULL) <> (p_cursor_id IS NULL))
       OR (p_preflight_status IS NOT NULL AND p_preflight_status NOT IN (
            'processing', 'completed', 'failed', 'not_requested', 'unknown'
       )) THEN
        RAISE EXCEPTION 'ADMIN_LEAD_INPUT_FILTER_INVALID';
    END IF;

    WITH page AS (
        SELECT target.id,
               target.instagram_id,
               target.mapping_status,
               target.auth_user_id,
               target.attribution_label,
               target.created_at,
               target.source_preflight_id,
               target.preflight_status,
               target.preflight_stage,
               target.preflight_error_code,
               target.preflight_outcome_at,
               target.preflight_followers_count,
               target.preflight_following_count,
               target.preflight_is_private,
               target.preflight_required_plan_id,
               (live.id IS NOT NULL AND live.pii_scrubbed_at IS NULL
                AND live.status IN ('ready', 'consumed', 'expired') AND live.ready_at IS NOT NULL) AS preflight_screen_available,
               excluded.instagram_id AS excluded_instagram_id
        FROM public.landing_leads AS target
        LEFT JOIN LATERAL (
            SELECT candidate.instagram_id
            FROM public.landing_leads AS candidate
            WHERE candidate.input_context = 'excluded'
              AND (
                  candidate.journey_id = target.journey_id
                  OR (
                      target.source_preflight_id IS NOT NULL
                      AND candidate.source_preflight_id = target.source_preflight_id
                  )
              )
            ORDER BY candidate.created_at ASC, candidate.id ASC
            LIMIT 1
        ) AS excluded ON TRUE
        LEFT JOIN public.analysis_preflights AS live ON live.id = target.source_preflight_id
        WHERE target.input_context = 'target'
          AND (p_mapping_status IS NULL OR target.mapping_status = p_mapping_status)
          AND (
              p_preflight_status IS NULL
              OR (p_preflight_status = 'not_requested' AND target.source_preflight_id IS NULL AND target.preflight_status IS NULL)
              OR (p_preflight_status = 'unknown' AND target.source_preflight_id IS NOT NULL AND target.preflight_status IS NULL)
              OR target.preflight_status = p_preflight_status
          )
          AND (p_from IS NULL OR target.created_at >= p_from)
          AND (p_to IS NULL OR target.created_at < p_to)
          AND (
              p_instagram_id IS NULL
              OR target.instagram_id = p_instagram_id
              OR excluded.instagram_id = p_instagram_id
          )
          AND (
              p_cursor_created_at IS NULL
              OR (target.created_at, target.id) < (p_cursor_created_at, p_cursor_id)
          )
        ORDER BY target.created_at DESC, target.id DESC
        LIMIT p_page_size
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'inputAt', page.created_at,
                'mappingStatus', page.mapping_status,
                'userName', account.name,
                'attributionLabel', COALESCE(account.signup_attribution_label, page.attribution_label),
                'targetInstagramId', page.instagram_id,
                'excludedInstagramId', page.excluded_instagram_id,
                'preflightId', page.source_preflight_id,
                'preflightStatus', page.preflight_status,
                'preflightStage', page.preflight_stage,
                'preflightErrorCode', page.preflight_error_code,
                'preflightOutcomeAt', page.preflight_outcome_at,
                'preflightFollowersCount', page.preflight_followers_count,
                'preflightFollowingCount', page.preflight_following_count,
                'preflightIsPrivate', page.preflight_is_private,
                'preflightRequiredPlanId', page.preflight_required_plan_id,
                'preflightScreenAvailable', page.preflight_screen_available,
                'cursorCreatedAt', page.created_at,
                'cursorId', page.id
            )
            ORDER BY page.created_at DESC, page.id DESC
        ),
        '[]'::JSONB
    )
    INTO v_rows
    FROM page
    LEFT JOIN public.users AS account ON account.id = page.auth_user_id;

    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_console_is_real_order(INTEGER, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_console_apply_preflight_outcome(public.analysis_preflights) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_console_preflight_outcome_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_console_lead_bound_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_console_preflight_failure_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_user_stats(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_orders(TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_users(TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_console_overview(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_console_is_real_order(INTEGER, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_user_stats(TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_orders(TIMESTAMPTZ, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_users(TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_console_overview(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

COMMIT;
