-- Freshness recovery can advance the order-bound preflight generation without
-- advancing the failed analysis request generation. Preserve the exact r1
-- request witness while deriving the next bounded preflight key from the
-- consumed order-bound r1..r8 preflight.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamp with time zone)'::pg_catalog.regprocedure
    );
    v_rewritten := pg_catalog.replace(
        v_definition,
        'v_base_preflight_key TEXT;',
        'v_base_preflight_key TEXT;'
            || pg_catalog.chr(10) || '    v_preflight_generation INTEGER;'
    );
    IF pg_catalog.strpos(v_rewritten, 'v_preflight_generation INTEGER') = 0 THEN
        RAISE EXCEPTION 'EARLYBIRD_ZERO_SPEND_REARM_GENERATION_DECLARATION_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
    v_normalized_preflight := v_preflight;
$old$, $new$
    IF v_preflight.idempotency_key ~ (
        '^earlybird[.]fulfillment[.]'
        || pg_catalog.replace(v_order.id::TEXT, '-', '')
        || '[.]r[1-8]$'
    ) THEN
        v_preflight_generation := substring(
            v_preflight.idempotency_key FROM '[.]r([1-8])$'
        )::integer;
    ELSE
        v_preflight_generation := NULL;
    END IF;
    v_normalized_preflight := v_preflight;
$new$);
    IF pg_catalog.strpos(v_rewritten, '[.]r[1-8]$') = 0 THEN
        RAISE EXCEPTION 'EARLYBIRD_ZERO_SPEND_REARM_GENERATION_PARSE_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(
        v_rewritten,
        'v_preflight.idempotency_key IS DISTINCT FROM (v_base_preflight_key || ''.r1'')',
        $guard$v_preflight_generation IS NULL
       OR EXISTS (
            SELECT 1
            FROM public.analysis_preflights AS family_preflight
            WHERE family_preflight.user_id = v_order.user_id
              AND family_preflight.id <> v_preflight.id
              AND family_preflight.idempotency_key ~ (
                  '^earlybird[.]fulfillment[.]'
                  || pg_catalog.replace(v_order.id::TEXT, '-', '')
                  || '[.]r[1-9]$'
              )
              AND substring(
                  family_preflight.idempotency_key FROM '[.]r([1-9])$'
              )::INTEGER > v_preflight_generation
       )$guard$
    );
    IF pg_catalog.strpos(v_rewritten, 'v_preflight_generation IS NULL') = 0 THEN
        RAISE EXCEPTION 'EARLYBIRD_ZERO_SPEND_REARM_GENERATION_GUARD_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(
        v_rewritten,
        'v_base_preflight_key || ''.r2''',
        'v_base_preflight_key || ''.r'' || (v_preflight_generation + 1)::TEXT'
    );
    IF pg_catalog.strpos(
        v_rewritten,
        'v_base_preflight_key || ''.r'' || (v_preflight_generation + 1)::TEXT'
    ) = 0 THEN
        RAISE EXCEPTION 'EARLYBIRD_ZERO_SPEND_REARM_GENERATION_INSERT_MISMATCH';
    END IF;

    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'v_preflight_generation INTEGER') = 0
       OR pg_catalog.strpos(v_rewritten, '[.]r[1-8]$') = 0
       OR pg_catalog.strpos(v_rewritten, 'family_preflight.idempotency_key') = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'v_base_preflight_key || ''.r'' || (v_preflight_generation + 1)::TEXT'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'v_request.idempotency_key IS DISTINCT FROM'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            '(''earlybird:'' || pg_catalog.lower(v_order.id::TEXT) || ''.r1'')'
       ) = 0 THEN
        RAISE EXCEPTION 'EARLYBIRD_ZERO_SPEND_REARM_GENERATION_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;
