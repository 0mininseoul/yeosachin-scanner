-- A first-generation schema-failure recovery remains on the deterministic
-- schema-recovery preflight until a later paid-preflight rebind is needed.
-- That exact row may retain a fresh, capacity-safe observation while the paid
-- order preserves checkout counts. Permit only that recorded lineage to adopt
-- already reconciled provider runs; descendants keep the fulfillment key.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- The retained-admission branch already recomputes capacity/required policy
-- for both the admission/current witness and the immutable paid order. Replace
-- only its obsolete equality requirement with non-null immutable witnesses.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.analysis_v2_valid_retained_admission_adoption_preflights(public.earlybird_orders,public.analysis_preflights,public.analysis_preflights)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(
        v_definition,
        'p_current.target_followers_count IS DISTINCT FROM p_order.target_followers_count'
    ) = 0
       AND pg_catalog.strpos(
            v_definition,
            'p_order.target_followers_count IS NULL'
       ) > 0
       AND pg_catalog.strpos(
            v_definition,
            'p_current.target_followers_count IS NULL'
       ) > 0 THEN
        v_rewritten := v_definition;
    ELSE
        v_rewritten := pg_catalog.replace(v_definition, $old$
       OR p_current.target_followers_count IS DISTINCT FROM p_order.target_followers_count
       OR p_current.target_following_count IS DISTINCT FROM p_order.target_following_count
$old$, $new$
       OR p_order.target_followers_count IS NULL
       OR p_order.target_following_count IS NULL
       OR p_current.target_followers_count IS NULL
       OR p_current.target_following_count IS NULL
$new$);
        IF v_rewritten = v_definition
           OR pg_catalog.strpos(
                v_rewritten,
                'p_current.target_followers_count IS DISTINCT FROM p_order.target_followers_count'
           ) > 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_SCHEMA_RECOVERY_ADOPTION_COUNT_PATCH_MISMATCH';
        END IF;
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_retained_admission_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.earlybird_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = recovery.order_id
        JOIN public.analysis_requests AS failed_request
          ON failed_request.id = recovery.failed_request_id
        JOIN public.analysis_preflights AS recovery_preflight
          ON recovery_preflight.id = recovery.recovery_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = earlybird_order.preflight_id
        WHERE recovery.order_id = p_order_id
          AND recovery.failed_request_id = p_failed_request_id
          AND (
              current_preflight.id = p_recovery_preflight_id
              OR recovery.recovery_preflight_id = p_recovery_preflight_id
          )
          AND failed_request.user_id = earlybird_order.user_id
          AND failed_request.pipeline_version = 'v2'
          AND failed_request.status = 'failed'
          AND EXISTS (
              SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
                AND receipt.error_code = failed_request.error_message
          )
          AND (
              (
                  current_preflight.id = recovery.recovery_preflight_id
                  AND current_preflight.idempotency_key =
                      'earlybird.schema-recovery.'
                      || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              )
              OR current_preflight.idempotency_key ~ (
                  '^earlybird[.]fulfillment[.]'
                  || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
                  || '([.]r[1-9])?$'
              )
          )
          AND public.analysis_v2_valid_recovery_adoption_preflights(
              earlybird_order, recovery_preflight, current_preflight
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND (
                    source_run.status <> 'succeeded'
                    OR source_run.run_id IS NULL
                    OR source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- The 090 resolver has both the exact and cross-identity implementations in
-- the live call path. Keep their lineage/key guard identical to readiness.
DO $migration$
DECLARE
    v_exact_definition TEXT;
    v_exact_key TEXT;
    v_exact_status TEXT;
    v_exact_tombstone TEXT;
    v_exact_rewritten TEXT;
    v_wrapper_definition TEXT;
    v_wrapper_rewritten TEXT;
BEGIN
    v_exact_definition := pg_catalog.pg_get_functiondef(
        'public.resolve_analysis_v2_exact_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(
        v_exact_definition,
        'v_current_preflight.idempotency_key !~'
    ) = 0
       AND pg_catalog.strpos(
            v_exact_definition,
            'v_recovery_preflight.idempotency_key ='
       ) > 0
       AND pg_catalog.strpos(
            v_exact_definition,
            'NOT public.analysis_v2_valid_recovery_adoption_preflights'
       ) > 0 THEN
        v_exact_rewritten := v_exact_definition;
    ELSE
        v_exact_key := pg_catalog.replace(v_exact_definition, $old$
       OR v_current_preflight.idempotency_key !~
            ('^earlybird[.]fulfillment[.]'
             || pg_catalog.replace(v_order.id::TEXT, '-', '')
             || '([.]r[1-9])?$')
$old$, $new$
       OR NOT (
            (
                v_current_preflight.id = v_recovery.recovery_preflight_id
                AND v_current_preflight.idempotency_key =
                    'earlybird.schema-recovery.'
                    || pg_catalog.replace(v_order.id::TEXT, '-', '')
            )
            OR v_current_preflight.idempotency_key ~
                ('^earlybird[.]fulfillment[.]'
                 || pg_catalog.replace(v_order.id::TEXT, '-', '')
                 || '([.]r[1-9])?$')
       )
$new$);
        IF v_exact_key = v_exact_definition THEN
            RAISE EXCEPTION 'EARLYBIRD_SCHEMA_RECOVERY_EXACT_RESOLVER_KEY_PATCH_MISMATCH';
        END IF;
        v_exact_status := pg_catalog.regexp_replace(v_exact_key,
        $pattern$OR[[:space:]]+v_recovery_preflight[.]status <> 'expired'$pattern$,
        $new$
       OR (
            NOT (
                v_recovery_preflight.idempotency_key =
                    'earlybird.schema-recovery.'
                    || pg_catalog.replace(v_order.id::TEXT, '-', '')
                AND (
                    (
                        v_current_preflight.id = v_recovery.recovery_preflight_id
                        AND v_current_preflight.idempotency_key =
                            'earlybird.schema-recovery.'
                            || pg_catalog.replace(v_order.id::TEXT, '-', '')
                    )
                    OR v_current_preflight.idempotency_key ~
                        ('^earlybird[.]fulfillment[.]'
                         || pg_catalog.replace(v_order.id::TEXT, '-', '')
                         || '([.]r[1-9])?$')
                )
            )
            AND (
                v_recovery_preflight.status <> 'expired'
$new$,
        ''
    );
        IF v_exact_status = v_exact_key THEN
            RAISE EXCEPTION 'EARLYBIRD_SCHEMA_RECOVERY_EXACT_RESOLVER_STATUS_PATCH_MISMATCH';
        END IF;
        v_exact_tombstone := pg_catalog.regexp_replace(v_exact_status,
        $pattern$OR[[:space:]]+v_recovery_preflight[.]excluded_instagram_id IS NOT NULL[[:space:]]+OR[[:space:]]+NOT public[.]analysis_v2_valid_recovery_adoption_preflights$pattern$,
        $new$
       OR v_recovery_preflight.excluded_instagram_id IS NOT NULL
            )
       )
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights
$new$,
        ''
    );
        IF v_exact_tombstone = v_exact_status THEN
            RAISE EXCEPTION 'EARLYBIRD_SCHEMA_RECOVERY_EXACT_RESOLVER_TOMBSTONE_PATCH_MISMATCH';
        END IF;
        v_exact_rewritten := v_exact_tombstone;
    END IF;

    v_wrapper_definition := pg_catalog.pg_get_functiondef(
        'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_wrapper_definition, 'v_current.idempotency_key !~') = 0
       AND pg_catalog.strpos(
            v_wrapper_definition,
            'v_current.id = v_recovery.recovery_preflight_id'
       ) > 0 THEN
        v_wrapper_rewritten := v_wrapper_definition;
    ELSE
        v_wrapper_rewritten := pg_catalog.replace(v_wrapper_definition, $old$
       OR v_current.idempotency_key !~ (
            '^earlybird[.]fulfillment[.]'
            || pg_catalog.replace(v_order.id::TEXT, '-', '')
            || '([.]r[1-9])?$'
       )
$old$, $new$
       OR NOT (
            (
                v_current.id = v_recovery.recovery_preflight_id
                AND v_current.idempotency_key =
                    'earlybird.schema-recovery.'
                    || pg_catalog.replace(v_order.id::TEXT, '-', '')
            )
            OR v_current.idempotency_key ~ (
                '^earlybird[.]fulfillment[.]'
                || pg_catalog.replace(v_order.id::TEXT, '-', '')
                || '([.]r[1-9])?$'
            )
       )
$new$);
        IF v_wrapper_rewritten = v_wrapper_definition THEN
            RAISE EXCEPTION 'EARLYBIRD_SCHEMA_RECOVERY_WRAPPER_RESOLVER_KEY_PATCH_MISMATCH';
        END IF;
    END IF;

    -- Both definitions were completely validated above. EXECUTE only now so a
    -- failed expected-definition guard cannot leave either resolver half-patched.
    EXECUTE v_exact_rewritten;
    EXECUTE v_wrapper_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;
