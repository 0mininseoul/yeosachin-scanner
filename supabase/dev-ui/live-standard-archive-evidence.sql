-- Install only on registered Dev, after live-standard-archive-replay.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
       OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
       OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_archive_replay_grants') IS NULL
       OR pg_catalog.to_regprocedure('public.dev_live_owner_start_lookup_v2(uuid,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_EVIDENCE_WRONG_DATABASE';
    END IF;
END;
$$;

-- Match the archive grant to its original, same-owner Standard request. The
-- original working set is disposable after completion. Its provider ledger is
-- durable, and replay never moves or clones the receipt.
CREATE OR REPLACE FUNCTION dev_live_budget.standard_archive_source_request(p_request_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $fn$
    SELECT source.id
    FROM public.analysis_requests AS destination
    JOIN public.analysis_preflights AS destination_preflight
      ON destination_preflight.id = destination.preflight_id
     AND destination_preflight.consumed_request_id = destination.id
     AND destination_preflight.user_id = destination.user_id
     AND destination_preflight.target_instagram_id = destination.target_instagram_id
    JOIN public.analysis_v2_test_entitlement_consumptions AS destination_consumption
      ON destination_consumption.request_id = destination.id
     AND destination_consumption.preflight_id = destination_preflight.id
     AND destination_consumption.user_id = destination.user_id
     AND destination_consumption.selected_plan_id = 'standard'
     AND destination_consumption.entitlement_jti_hash = destination.test_entitlement_jti_hash
     AND destination_consumption.entitlement_jti_hash = destination_preflight.admission_entitlement_jti_hash
    JOIN dev_live_budget.standard_archive_replay_grants AS binding
      ON binding.grant_id = CASE
          WHEN destination_preflight.idempotency_key ~ '^dev-live:owner:standard:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN pg_catalog.split_part(destination_preflight.idempotency_key, ':', 4)::uuid
      END
    JOIN dev_live_budget.owner_starts AS source_start
      ON source_start.grant_id = binding.source_grant_id
     AND source_start.user_id = destination.user_id
     AND source_start.target_instagram_id = destination.target_instagram_id
    JOIN public.analysis_preflights AS source_preflight
      ON source_preflight.user_id = source_start.user_id
     AND source_preflight.target_instagram_id = source_start.target_instagram_id
     AND source_preflight.idempotency_key = 'dev-live:owner:standard:' || source_start.grant_id::text
    JOIN public.analysis_requests AS source
      ON source.id = source_preflight.consumed_request_id
     AND source.preflight_id = source_preflight.id
     AND source.user_id = destination.user_id
     AND source.target_instagram_id = destination.target_instagram_id
     AND source.excluded_instagram_id IS NOT DISTINCT FROM destination.excluded_instagram_id
    WHERE destination.id = p_request_id
      AND binding.expires_at > pg_catalog.clock_timestamp()
      AND public.dev_live_owner_start_lookup_v2(
          binding.grant_id, destination.user_id, destination.target_instagram_id
      ) IS NOT NULL
      AND destination_consumption.entitlement_jti_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          'analysis-test-entitlement-jti-v1' || pg_catalog.chr(10) || 'dev-live-' || binding.grant_id::text,
          'UTF8'
      )), 'hex')
      AND destination_preflight.status = 'consumed'
      AND destination_preflight.admission_status = 'ready'
      AND destination_preflight.admission_selected_plan_id = 'standard'
      AND destination_preflight.access_mode = 'test_entitlement'
      AND destination_preflight.analysis_entry_channel = 'standard'
      AND destination_preflight.beta_entry_provenance IS NULL
      AND destination.status = 'processing'
      AND destination.pipeline_version = 'v2'
      AND destination.plan_access_mode_snapshot = 'test_entitlement'
      AND destination.selected_plan_id_snapshot = 'standard'
      AND destination.analysis_entry_channel = 'standard'
      AND source_preflight.status = 'consumed'
      AND source.status = 'completed'
      AND source.pipeline_version = 'v2'
      AND source.plan_access_mode_snapshot = 'test_entitlement'
      AND source.selected_plan_id_snapshot = 'standard'
      AND source.analysis_entry_channel = 'standard';
$fn$;
REVOKE ALL ON FUNCTION dev_live_budget.standard_archive_source_request(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- Resolve the original settled run by operation, provider input and run ID from
-- the encrypted worker inputs. Post selection and item coverage remain fenced
-- by the existing checkpoint writers and validated archive identities.
CREATE OR REPLACE FUNCTION dev_live_budget.standard_archive_evidence_source(
    p_request_id uuid, p_job_key text, p_claim_token uuid, p_operation_key text,
    p_input_hash text, p_provider text, p_run_id text, p_credential_slot text
) RETURNS SETOF public.analysis_v2_provider_runs
LANGUAGE sql STABLE SET search_path = ''
AS $fn$
    SELECT provider_run.*
    FROM public.analysis_pipeline_jobs AS current_job
    JOIN public.analysis_v2_provider_runs AS provider_run
      ON provider_run.request_id = dev_live_budget.standard_archive_source_request(p_request_id)
     AND provider_run.job_key = p_job_key
     AND provider_run.operation_key = p_operation_key
    WHERE current_job.request_id = p_request_id
      AND current_job.job_key = p_job_key
      AND current_job.status = 'processing'
      AND current_job.lease_token = p_claim_token
      AND current_job.lease_expires_at > pg_catalog.clock_timestamp()
      AND current_job.kind = 'collection'
      AND current_job.batch IS NULL
      AND (
          (
              p_job_key = 'track:relationships:collect'
              AND current_job.track = 'relationships'
              AND p_operation_key ~ '^relationship-(followers|following):[0-9a-f]{64}$'
          )
          OR (
              p_job_key = 'track:target-evidence:collect'
              AND current_job.track = 'target_evidence'
              AND p_operation_key ~ '^target-(likers|comments):[0-9a-f]{64}$'
          )
      )
      AND p_provider = 'apify'
      AND provider_run.logical_provider = p_provider
      AND provider_run.input_hash = p_input_hash
      AND provider_run.run_id = p_run_id
      AND provider_run.status = 'succeeded'
      AND provider_run.actual_usage_usd IS NOT NULL
      AND provider_run.usage_reconciled_at IS NOT NULL
      AND (p_credential_slot IS NULL OR provider_run.credential_slot = p_credential_slot)
      -- Give the request's direct receipt and recovery adoption precedence,
      -- including rejection when either exists with a conflicting identity.
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_v2_provider_runs AS direct_run
          WHERE direct_run.request_id = p_request_id
            AND direct_run.job_key = p_job_key
            AND direct_run.operation_key = p_operation_key
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
          WHERE adoption.request_id = p_request_id
            AND adoption.job_key = p_job_key
            AND adoption.operation_key = p_operation_key
      );
$fn$;
REVOKE ALL ON FUNCTION dev_live_budget.standard_archive_evidence_source(uuid,text,uuid,text,text,text,text,text)
    FROM PUBLIC, anon, authenticated, service_role;

-- The archived DTO omits credentials. Return just the original slot label for
-- the active target-evidence claim, before the writer rechecks the same source.
CREATE OR REPLACE FUNCTION public.dev_live_standard_archive_evidence_slot_v1(
    p_request_id uuid, p_job_key text, p_claim_token uuid, p_job_input_hash text,
    p_operation_key text, p_input_hash text, p_run_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
    v_slot text;
BEGIN
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.job_key = 'track:target-evidence:collect'
      AND job.input_hash = p_job_input_hash
      AND job.status = 'processing'
      AND job.lease_token = p_claim_token
      AND job.lease_expires_at > pg_catalog.clock_timestamp()
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID' USING ERRCODE = 'P0001';
    END IF;

    SELECT original.credential_slot INTO STRICT v_slot
    FROM dev_live_budget.standard_archive_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_operation_key,
        p_input_hash, 'apify', p_run_id, NULL
    ) AS original;
    RETURN v_slot;
EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID' USING ERRCODE = 'P0001';
END;
$fn$;
REVOKE ALL ON FUNCTION public.dev_live_standard_archive_evidence_slot_v1(uuid,text,uuid,text,text,text,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dev_live_standard_archive_evidence_slot_v1(uuid,text,uuid,text,text,text,text)
    TO service_role;

DO $patch$
DECLARE
    v_base pg_catalog.pg_proc%ROWTYPE;
    v_signature text;
    v_baseline_hash text;
    v_edited_hash text;
    v_source text;
    v_loader_marker constant text := '    SELECT provider_run.* INTO STRICT v_source';
    v_loader_addition constant text := $sql$    SELECT provider_run.* INTO v_source
    FROM dev_live_budget.standard_archive_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_operation_key,
        p_input_hash, p_provider, p_run_id, p_credential_slot
    ) AS original
    JOIN public.analysis_v2_provider_runs AS provider_run
      USING (request_id, job_key, operation_key)
    FOR SHARE OF provider_run;
    IF FOUND THEN
        RETURN v_source;
    END IF;

$sql$;
    v_validator_marker constant text := E'    );\n';
    v_validator_end constant text := $sql$    ) THEN true ELSE EXISTS (
        SELECT 1 FROM dev_live_budget.standard_archive_evidence_source(
            p_request_id, p_job_key, p_claim_token, p_operation_key,
            p_input_hash, p_provider, p_run_id, p_credential_slot
        )
    ) END;
$sql$;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.analysis_v2_load_provider_evidence_source(uuid,text,uuid,text,text,text,text,text)',
        'public.analysis_v2_valid_provider_evidence_source(uuid,text,uuid,text,text,text,text,text)'
    ] LOOP
        SELECT * INTO v_base FROM pg_catalog.pg_proc
        WHERE oid = pg_catalog.to_regprocedure(v_signature);
        IF NOT FOUND OR NOT v_base.prosecdef
           OR pg_catalog.pg_get_userbyid(v_base.proowner) IS DISTINCT FROM 'postgres'
           OR v_base.proconfig IS DISTINCT FROM ARRAY['search_path=""']
           OR pg_catalog.has_function_privilege('service_role', v_base.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('anon', v_base.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', v_base.oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_EVIDENCE_BASELINE_MISMATCH';
        END IF;

        IF v_base.proname = 'analysis_v2_load_provider_evidence_source' THEN
            v_baseline_hash := 'b8c653a8b10f5b005ce114d46fb67faf';
            v_edited_hash := '775e8207f5f1b5daa7af6472ad96e40e';
            v_source := pg_catalog.replace(v_base.prosrc, v_loader_marker, v_loader_addition || v_loader_marker);
        ELSE
            v_baseline_hash := '882fa2745bb5da312932f4dc288d523f';
            v_edited_hash := '83377cbefa62ca0f0c7514bb9852373f';
            v_source := pg_catalog.replace(v_base.prosrc, '    SELECT EXISTS (', '    SELECT CASE WHEN EXISTS (');
            v_source := pg_catalog.replace(v_source, v_validator_marker, v_validator_end);
        END IF;

        IF pg_catalog.md5(v_base.prosrc) = v_edited_hash THEN
            CONTINUE;
        END IF;
        IF pg_catalog.md5(v_base.prosrc) <> v_baseline_hash OR pg_catalog.md5(v_source) <> v_edited_hash THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_EVIDENCE_SOURCE_PATCH_MISMATCH';
        END IF;
        EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_base.oid), v_base.prosrc, v_source);
        IF NOT EXISTS (
            SELECT FROM pg_catalog.pg_proc AS edited
            WHERE edited.oid = v_base.oid AND pg_catalog.md5(edited.prosrc) = v_edited_hash
              AND edited.proowner = v_base.proowner AND edited.proacl IS NOT DISTINCT FROM v_base.proacl
              AND edited.proconfig = v_base.proconfig AND edited.prosecdef
        ) THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_EVIDENCE_PATCH_UNVERIFIED';
        END IF;
    END LOOP;
END;
$patch$;

-- Reuse the same fenced direct-fresh writer and retain its current-checkpoint
-- idempotency, coverage, and downstream consumer shape. Only the proof of the
-- Apify run changes for a replay grant. The original operation uniquely identifies
-- the receipt within its source request and job, even after working-set cleanup.
DO $profile$
DECLARE
    v_signature constant text :=
        'public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(uuid,text,uuid,text,text[],jsonb,text,text)';
    v_baseline_hash constant text := 'd574dd70c33a4344d1740b2ec9226a54';
    v_edited_hash constant text := '94f2b06bdd089a492891e1dd28764262';
    v_base pg_catalog.pg_proc%ROWTYPE;
    v_source text;
    v_marker constant text := '    SELECT batch.*';
    v_clause constant text := '       OR v_provider.job_claim_token IS DISTINCT FROM p_claim_token';
    v_provider_declaration constant text := '    v_provider public.analysis_v2_provider_runs%ROWTYPE;';
    v_archive_provider constant text := $sql$    IF v_order_id IS NULL
       AND v_provider.request_id IS NULL
       AND v_job.request_id = p_request_id
       AND v_job.job_key = p_job_key
       AND v_job.input_hash = p_job_input_hash
       AND v_job.status = 'processing'
       AND v_job.lease_token = p_claim_token
       AND v_job.lease_expires_at > pg_catalog.clock_timestamp()
       AND dev_live_budget.valid_standard_profile_lineage(v_preflight, v_request)
       AND NOT EXISTS (
           SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
           WHERE adoption.request_id = p_request_id
             AND adoption.job_key = p_job_key
             AND adoption.operation_key = p_operation_key
       ) THEN
        SELECT provider_run.* INTO v_provider
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = dev_live_budget.standard_archive_source_request(p_request_id)
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_operation_key
          AND provider_run.input_hash = p_provider_input_hash
          AND provider_run.actual_usage_usd IS NOT NULL
          AND provider_run.usage_reconciled_at IS NOT NULL
        FOR SHARE OF provider_run;
        v_uses_archive := FOUND;
    END IF;
$sql$;
BEGIN
    SELECT * INTO v_base FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure(v_signature);
    IF NOT FOUND OR NOT v_base.prosecdef
       OR pg_catalog.pg_get_userbyid(v_base.proowner) IS DISTINCT FROM 'postgres'
       OR v_base.proconfig IS DISTINCT FROM ARRAY['search_path=""']
       OR NOT pg_catalog.has_function_privilege('service_role', v_base.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_base.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_base.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_PROFILE_BASELINE_MISMATCH';
    END IF;
    IF pg_catalog.md5(v_base.prosrc) = v_edited_hash THEN
        RETURN;
    END IF;

    v_source := pg_catalog.replace(v_base.prosrc, v_provider_declaration,
        v_provider_declaration || E'\n    v_uses_archive boolean := FALSE;');
    v_source := pg_catalog.replace(v_source, v_marker, v_archive_provider || v_marker);
    v_source := pg_catalog.replace(v_source, v_clause,
        '       OR (NOT v_uses_archive AND v_provider.job_claim_token IS DISTINCT FROM p_claim_token)');

    IF pg_catalog.md5(v_base.prosrc) <> v_baseline_hash OR pg_catalog.md5(v_source) <> v_edited_hash THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_PROFILE_SOURCE_PATCH_MISMATCH';
    END IF;
    EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_base.oid), v_base.prosrc, v_source);
    IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_proc AS edited
        WHERE edited.oid = v_base.oid AND pg_catalog.md5(edited.prosrc) = v_edited_hash
          AND edited.proowner = v_base.proowner AND edited.proacl IS NOT DISTINCT FROM v_base.proacl
          AND edited.proconfig = v_base.proconfig AND edited.prosecdef
    ) THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_PROFILE_PATCH_UNVERIFIED';
    END IF;
END;
$profile$;

COMMIT;
