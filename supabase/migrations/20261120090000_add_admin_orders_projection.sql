-- Operator console order and user lists.
--
-- Order list: built from every paid order.
--
-- The permanent audit bundle only exists for orders assembled after
-- 2026-09-04, so listing bundles alone hid most real orders.  This read-only
-- projection walks earlybird_orders (paid_at IS NOT NULL, newest first) and
-- attaches, when present:
--   * the latest audit bundle (evidence status, gap codes, order cost),
--   * otherwise the durable V2 cost snapshot for the result request,
--   * customer, payment, acquisition and device facts.
-- Nothing is written.  service_role only.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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

REVOKE ALL ON FUNCTION public.load_admin_orders(TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_admin_orders(TIMESTAMPTZ, UUID, INTEGER) TO service_role;

-- Operator console user list: every column of public.users plus per-user
-- order and lead totals.  Newest signup first; optional text search over
-- name, nickname, email and phone.  Read-only, service_role only.
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
    ) AS orders ON TRUE
    LEFT JOIN LATERAL (
        SELECT pg_catalog.count(*) AS lead_count
        FROM public.landing_leads AS lead
        WHERE lead.auth_user_id = page.id AND lead.input_context = 'target'
    ) AS leads ON TRUE;

    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

-- Per-user lead lookups for the user list.
CREATE INDEX IF NOT EXISTS landing_leads_auth_user_idx
    ON public.landing_leads(auth_user_id)
    WHERE auth_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS earlybird_orders_user_paid_idx
    ON public.earlybird_orders(user_id, paid_at);

REVOKE ALL ON FUNCTION public.load_admin_users(TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_admin_users(TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;

COMMIT;
