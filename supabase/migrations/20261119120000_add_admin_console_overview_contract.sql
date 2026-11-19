-- Admin console overview contract.
--
-- 1. Bounded acquisition labels (the same nine labels the Kakao signup
--    notification already uses) on users (signup time) and landing_leads
--    (input time).  Raw URLs, queries and referrers are never stored.
-- 2. A bounded client device summary on earlybird_orders ("iPhone · Safari").
-- 3. Read-only operator projections: one row per analysis input (target and
--    optional exclusion together), order customer facts, and overview metrics.
--
-- Every writer below only fills a NULL value, so retries are idempotent and
-- existing data is never overwritten.  All functions are service_role only.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.admin_console_attribution_label_valid(p_label TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(p_label IN (
        '직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타',
        '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타'
    ), FALSE);
$$;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS signup_attribution_label TEXT
        CONSTRAINT users_signup_attribution_label_check CHECK (
            signup_attribution_label IS NULL
            OR signup_attribution_label IN (
                '직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타',
                '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타'
            )
        );

ALTER TABLE public.landing_leads
    ADD COLUMN IF NOT EXISTS attribution_label TEXT
        CONSTRAINT landing_leads_attribution_label_check CHECK (
            attribution_label IS NULL
            OR attribution_label IN (
                '직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타',
                '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타'
            )
        );

ALTER TABLE public.earlybird_orders
    ADD COLUMN IF NOT EXISTS client_device_label TEXT
        CONSTRAINT earlybird_orders_client_device_label_check CHECK (
            client_device_label IS NULL
            OR client_device_label ~ '^[A-Za-z0-9가-힣 ·]{1,40}$'
        );

-- Signup labels staged for the Discord notification predate this column.
-- Copy them once; later signups are written by set_user_signup_attribution.
UPDATE public.users AS target
SET signup_attribution_label = outbox.attribution_label
FROM public.kakao_signup_discord_outbox AS outbox
WHERE outbox.user_id = target.id
  AND public.admin_console_attribution_label_valid(outbox.attribution_label)
  AND target.signup_attribution_label IS NULL;

-- Paid-date lookups for the overview metrics.
CREATE INDEX IF NOT EXISTS earlybird_orders_paid_at_idx
    ON public.earlybird_orders(paid_at)
    WHERE paid_at IS NOT NULL;
-- Time-window scans for the overview spend series.
CREATE INDEX IF NOT EXISTS analysis_preflight_provider_runs_reserved_at_idx
    ON public.analysis_preflight_provider_runs(reserved_at);
CREATE INDEX IF NOT EXISTS analysis_v2_provider_runs_reserved_at_idx
    ON public.analysis_v2_provider_runs(reserved_at);
CREATE INDEX IF NOT EXISTS analysis_v2_ai_attempts_created_at_idx
    ON public.analysis_v2_ai_attempts(created_at);

CREATE OR REPLACE FUNCTION public.set_user_signup_attribution(
    p_user_id UUID,
    p_label TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_user_id IS NULL OR NOT public.admin_console_attribution_label_valid(p_label) THEN
        RETURN FALSE;
    END IF;
    UPDATE public.users
    SET signup_attribution_label = p_label
    WHERE id = p_user_id AND signup_attribution_label IS NULL;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_landing_lead_journey_attribution(
    p_journey_id UUID,
    p_label TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_journey_id IS NULL OR NOT public.admin_console_attribution_label_valid(p_label) THEN
        RETURN FALSE;
    END IF;
    UPDATE public.landing_leads
    SET attribution_label = p_label
    WHERE journey_id = p_journey_id AND attribution_label IS NULL;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_earlybird_order_client_device(
    p_order_id UUID,
    p_user_id UUID,
    p_label TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_order_id IS NULL OR p_user_id IS NULL
       OR p_label IS NULL OR p_label !~ '^[A-Za-z0-9가-힣 ·]{1,40}$' THEN
        RETURN FALSE;
    END IF;
    UPDATE public.earlybird_orders
    SET client_device_label = p_label
    WHERE id = p_order_id AND user_id = p_user_id AND client_device_label IS NULL;
    RETURN FOUND;
END;
$$;

-- One row per analysis input.  A journey holds the target row and, when the
-- user also chose an account to exclude, the excluded row bound to the same
-- preflight.  Paging walks target rows only, newest first, on the existing
-- (input_context, created_at) index.
CREATE OR REPLACE FUNCTION public.load_admin_lead_inputs(
    p_mapping_status TEXT DEFAULT NULL,
    p_instagram_id TEXT DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
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
       OR (p_mapping_status IS NOT NULL AND p_mapping_status NOT IN (
            'legacy_unlinked', 'anonymous_device',
            'authenticated_user', 'unlinked_after_deletion'
       ))
       OR (p_instagram_id IS NOT NULL AND p_instagram_id !~ '^[a-z0-9._]{1,30}$')
       OR ((p_cursor_created_at IS NULL) <> (p_cursor_id IS NULL)) THEN
        RAISE EXCEPTION 'ADMIN_LEAD_INPUT_FILTER_INVALID';
    END IF;

    WITH page AS (
        SELECT target.id,
               target.instagram_id,
               target.mapping_status,
               target.auth_user_id,
               target.attribution_label,
               target.created_at,
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
        WHERE target.input_context = 'target'
          AND (p_mapping_status IS NULL OR target.mapping_status = p_mapping_status)
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

-- Customer facts for the orders currently shown in the console (<= 50).
CREATE OR REPLACE FUNCTION public.load_admin_order_customers(p_request_ids UUID[])
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
BEGIN
    IF p_request_ids IS NULL OR pg_catalog.cardinality(p_request_ids) > 50 THEN
        RAISE EXCEPTION 'ADMIN_ORDER_CUSTOMER_FILTER_INVALID';
    END IF;
    WITH latest AS (
        SELECT DISTINCT ON (bundle.request_id)
               bundle.request_id, bundle.order_id
        FROM public.analysis_order_audit_bundles AS bundle
        WHERE bundle.request_id = ANY (p_request_ids)
        ORDER BY bundle.request_id, bundle.version DESC
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'requestId', latest.request_id,
        'userName', account.name,
        'gender', account.gender,
        'birthyear', account.birthyear,
        'deviceLabel', orders.client_device_label,
        'attributionLabel', account.signup_attribution_label,
        'paidAmountKrw', orders.actual_amount_krw
    )), '[]'::JSONB)
    INTO v_rows
    FROM latest
    LEFT JOIN public.earlybird_orders AS orders ON orders.id = latest.order_id
    LEFT JOIN public.users AS account ON account.id = orders.user_id;
    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

-- Overview metrics in KST.
--
-- Paying users exclude cancelled and refunded orders.
--
-- Spend is time-based and covers every paid call, not only paid orders:
--   * preflight Apify runs (anonymous and logged-in, paid or not),
--   * analysis Apify runs,
--   * Vertex/Gemini analysis attempts.
-- known_usd counts provider-reconciled Apify usage and metered AI estimates.
-- conservative_usd adds the reserved max charge / pre-call estimate for rows
-- that are not settled yet, so an unsettled call is never treated as zero.
-- Shared infrastructure (Cloud Run, Supabase, Vercel, email) is out of scope.
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

REVOKE ALL ON FUNCTION public.admin_console_attribution_label_valid(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_user_signup_attribution(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_landing_lead_journey_attribution(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_earlybird_order_client_device(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_order_customers(UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_console_overview(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_console_attribution_label_valid(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_user_signup_attribution(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_landing_lead_journey_attribution(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_earlybird_order_client_device(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_order_customers(UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_admin_console_overview(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

COMMIT;
