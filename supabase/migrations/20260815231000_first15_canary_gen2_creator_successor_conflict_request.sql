-- MIGRATION_PREDECESSOR=20260815225000
-- The generation-two ledger already supplies the exact terminal successor.
-- Rebind only the creator's local conflict record to that immutable successor
-- before the existing readiness and receipt fences continue unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815225000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_CONFLICT_REQUEST_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

DO $creator_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)';
    v_expected_definition_md5 CONSTANT TEXT := '026b0411e95b47d792e78d6fbddaf42c';
    v_definition TEXT;
    v_rewritten TEXT;
    v_anchor TEXT := $old$
        FOR KEY SHARE;
        v_first15_rearm_ready :=
$old$;
    v_replacement TEXT := $new$
        FOR KEY SHARE;
        IF v_first15_rearm_failed_request_id IS NOT NULL THEN
            SELECT analysis_request.* INTO v_conflicting_request
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = v_first15_rearm_failed_request_id
            FOR KEY SHARE;
        END IF;
        v_first15_rearm_ready :=
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_anchor) = 0
       OR (
           pg_catalog.char_length(v_definition)
           - pg_catalog.char_length(pg_catalog.replace(v_definition, v_anchor, ''))
       ) / pg_catalog.char_length(v_anchor) <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_CONFLICT_REQUEST_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(v_definition, v_anchor, v_replacement);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'WHERE analysis_request.id = v_first15_rearm_failed_request_id'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'IF v_first15_rearm_failed_request_id IS NOT NULL THEN'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_CONFLICT_REQUEST_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$creator_patch$;

COMMIT;
