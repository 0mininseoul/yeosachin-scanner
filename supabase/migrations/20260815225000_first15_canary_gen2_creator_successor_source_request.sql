-- MIGRATION_PREDECESSOR=20260815220000
-- The existing creator's immutable base idempotency conflict is the original
-- request. For an exact generation-two first15 rearm, the pre-existing private
-- ledger identifies the failed successor that the existing readiness fence must
-- validate. No lineage, route, privilege, or provider behavior changes here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815220000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_CREATOR_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

DO $creator_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)';
    v_expected_definition_md5 CONSTANT TEXT := 'cc8435f6fc8ee4184e99434005c529d8';
    v_definition TEXT;
    v_rewritten TEXT;
    v_declaration_old TEXT :=
        '    v_first15_rearm_ready BOOLEAN := FALSE;';
    v_declaration_new TEXT :=
        '    v_first15_rearm_ready BOOLEAN := FALSE;'
        || pg_catalog.chr(10)
        || '    v_first15_rearm_failed_request_id UUID;';
    v_readiness_old TEXT := $old$
        v_first15_rearm_ready :=
            public.earlybird_first15_canary_provider_rearm_request_ready(
                v_order.id, v_conflicting_request.id, v_preflight.id
            );
$old$;
    v_readiness_new TEXT := $new$
        SELECT rearm.source_request_id
        INTO v_first15_rearm_failed_request_id
        FROM public.earlybird_first15_canary_provider_rearms AS rearm
        WHERE rearm.order_id = v_order.id
          AND rearm.rearmed_preflight_id = v_preflight.id
          AND rearm.rearm_generation = 2
        FOR KEY SHARE;
        v_first15_rearm_ready :=
            public.earlybird_first15_canary_provider_rearm_request_ready(
                v_order.id,
                COALESCE(
                    v_first15_rearm_failed_request_id,
                    v_conflicting_request.id
                ),
                v_preflight.id
            );
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_declaration_old) = 0
       OR pg_catalog.strpos(v_definition, v_readiness_old) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_CREATOR_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(
        v_definition, v_declaration_old, v_declaration_new
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_readiness_old, v_readiness_new
    );
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten, 'v_first15_rearm_failed_request_id UUID;'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten, 'rearm.rearm_generation = 2'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'COALESCE('
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_CREATOR_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$creator_patch$;

COMMIT;
