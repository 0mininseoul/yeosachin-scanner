-- Called only after the existing hard limit refuses a new reservation, under the
-- same lock used by reserve/settle/cancel. No reservation or approval is issued.
CREATE FUNCTION public.vertex_ai_budget_denial_detail_v1(
    p_denied_scope text, p_run text, p_order text, p_day date, p_requested numeric,
    p_run_limit numeric, p_order_limit numeric, p_day_limit numeric
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = '' AS $body$
    WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS checked_at), limits(scope, cap) AS (
        VALUES ('run', p_run_limit), ('order', p_order_limit), ('day', p_day_limit)
    ), exposure AS (
        SELECT l.*, sums.*
        FROM limits l CROSS JOIN observed t
        CROSS JOIN LATERAL (
            SELECT
                coalesce(sum(coalesce(r.actual_cost_usd, r.estimated_cost_usd))
                    FILTER (WHERE r.state = 'settled'), 0) AS settled,
                coalesce(sum(r.estimated_cost_usd) FILTER (WHERE r.state = 'reserved'
                    AND r.created_at NOT BETWEEN t.checked_at - interval '240 seconds' AND t.checked_at), 0) AS stale,
                coalesce(sum(r.estimated_cost_usd) FILTER (WHERE r.state = 'reserved'
                    AND r.created_at BETWEEN t.checked_at - interval '240 seconds' AND t.checked_at), 0) AS fresh
            FROM public.vertex_ai_budget_reservations r
            WHERE r.state IN ('reserved', 'settled') AND (
                (l.scope = 'run' AND r.run_id = p_run) OR (l.scope = 'order' AND r.order_id = p_order)
                OR (l.scope = 'day' AND r.day_key = p_day)
            )
        ) sums
    ), classified AS (
        -- Even if the first exceeded scope could recover, another scope can be hard-exhausted.
        SELECT *, bool_and(settled + stale + p_requested <= cap) OVER () AS has_headroom
        FROM exposure
    )
    SELECT jsonb_build_object('scope', scope, 'limitUsd', cap, 'settledUsd', settled,
        'staleReservedUsd', stale, 'freshReservedUsd', fresh, 'requestedUsd', p_requested,
        'pending', has_headroom AND fresh > 0)
    FROM classified WHERE scope = p_denied_scope;
$body$;
REVOKE ALL ON FUNCTION public.vertex_ai_budget_denial_detail_v1(text,text,text,date,numeric,numeric,numeric,numeric)
    FROM PUBLIC, anon, authenticated, service_role;

-- Retain the original checks, validation, order resolution, deduplication, ACL,
-- and all writes. Only enrich their three denial branches with an ID-free detail.
DO $migration$
DECLARE
    fn regprocedure := 'public.reserve_vertex_ai_budget(text,text,text,text,integer,text,text,text,bigint,integer,numeric,date,numeric,numeric,numeric)'::regprocedure;
    body text := pg_get_functiondef(fn);
    scope text;
    key_name text;
    marker text;
BEGIN
    IF (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc WHERE oid = fn)
        <> '24bc8f4d23c1c2dfcd0d699c854402b7fb95a3d2d5b054d40d239b030e207086'
    THEN RAISE EXCEPTION 'VERTEX_AI_BUDGET_RESERVE_DEFINITION_CHANGED'; END IF;
    body := replace(body, '    v_current NUMERIC;', '    v_current NUMERIC;' || chr(10) || '    v_denial jsonb;');
    FOR scope, key_name IN VALUES ('run','v_run_id'), ('order','v_order_id'), ('day','v_day_key') LOOP
        marker := format('RAISE EXCEPTION %L, %s', 'VERTEX_AI_BUDGET_EXCEEDED:' || scope || ':%', key_name);
        body := replace(body, marker || ';', format($branch$
        v_denial := public.vertex_ai_budget_denial_detail_v1(%L, v_run_id, v_order_id, v_day_key,
            p_estimated_cost_usd, p_per_run_limit_usd, p_per_order_limit_usd, p_daily_limit_usd);
        IF (v_denial->>'pending')::boolean THEN
            %s USING HINT = 'VERTEX_AI_BUDGET_CAPACITY_PENDING', DETAIL = (v_denial - 'pending')::text;
        END IF;
        %s USING DETAIL = (v_denial - 'pending')::text;$branch$, scope, marker, marker));
    END LOOP;
    EXECUTE body;
END;
$migration$;
