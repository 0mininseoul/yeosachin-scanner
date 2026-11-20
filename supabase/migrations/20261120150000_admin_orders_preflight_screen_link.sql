-- Order list: expose the order's preflight id and whether its result screen is
-- archived, so the operator can open the screen the buyer saw before paying.

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
        'preflightId', page.preflight_id,
        'preflightScreenArchived', EXISTS (
            SELECT 1 FROM public.admin_preflight_screen_archive AS archive
            WHERE archive.preflight_id = page.preflight_id
        ),
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

COMMIT;
