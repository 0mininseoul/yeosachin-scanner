-- Private Dev fixture upgrade. Shared authority locks serialize revocation, not progress or heartbeat writes.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $$ BEGIN
    IF to_regclass('dev_ui.runs') IS NULL OR to_regclass('dev_cloud_six.order_receipts') IS NULL
       OR to_regnamespace('paid_standard_capacity') IS NOT NULL
       OR to_regprocedure('dev_cloud_six.lock_approved(text,uuid,text,uuid)') IS NULL THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_AUTHORIZATION_SCHEMA_REQUIRED';
    END IF;
    -- The fixture reproduces the native wire fence below. Refuse changed native or previously installed
    -- contracts so an upgrade cannot silently omit a later production cancellation condition.
    IF EXISTS(SELECT FROM (VALUES
        ('public.analysis_v2_vertex_request_admission_open(uuid)',
         '52232eca3b756619dc7512ffa377b56be806dfb9b4c249a2c82fa06708cbd24e',NULL),
        ('public.authorize_analysis_v2_vertex_dispatch_v1(uuid,text,uuid,text)',
         '44538881d3a47e5619259ed94b5e1b24d26b8139772e22eb6315ce85ff8d8a27',NULL),
        ('dev_cloud_six.lock_approved(text,uuid,text,uuid)',
         '9a22b8f8d3ffb506735fb622601d9d83b07c37f2fb4243834dd4f36427f1770c',
         '4e1929eef9b225f6d9aac4fc4b8eb517b265d392e91fbe35798591673986da7b'),
        ('public.authorize_dev_cloud_six_vertex_dispatch_v1(text,uuid,text,uuid,text)',
         'a8d0f1eba96fa2c645c87c892b4c81bf0a246f801d868233e55cf26d76c7b67f',
         '034d660beba8e4dfcf030f83dc7574b4f23f42a236d3d0e8cc49b5dd7831866c'),
        ('public.reserve_dev_cloud_six_ai_attempt_v1(text,uuid,text,uuid,text,smallint,uuid,jsonb,text)',
         'fc83933d1d1d5cfb07795d229140ece7e507c90ee3f47e2bd84cdd72834f3c92',
         'f992bfadcb2ca13781be1955a0bb89d5d4236702636ab367c3ef04374fe8bb20')
    ) AS expected(signature,original,upgraded)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
        NOT IN (expected.original,coalesce(expected.upgraded,expected.original))) THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_AUTHORIZATION_SOURCE_DRIFT';
    END IF;
END; $$;

-- The dedicated queues and Auth addresses use the first sixteen characters of the execution digest.
CREATE UNIQUE INDEX IF NOT EXISTS dev_cloud_six_execution_prefix ON dev_cloud_six.waves (left(digest,16));
DO $$ BEGIN
    IF NOT EXISTS(SELECT FROM pg_index i WHERE i.indexrelid='dev_cloud_six.dev_cloud_six_execution_prefix'::regclass
        AND i.indrelid='dev_cloud_six.waves'::regclass AND i.indisunique AND i.indisvalid
        AND i.indpred IS NULL AND i.indnkeyatts=1 AND regexp_replace(pg_get_expr(i.indexprs,i.indrelid),
            '["[:space:]]','','g')='left(digest,16)') THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_PREFIX_INDEX_DRIFT'; END IF;
END; $$;

CREATE OR REPLACE FUNCTION dev_cloud_six.authority_key(scope text, id uuid, job text DEFAULT '')
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
    SELECT hashtextextended('dev-cloud-six-authority-v1'||chr(10)||scope||chr(10)||id::text||chr(10)||job,0)
$$;

-- Only a previously eligible fixture request can lose authority. Lock its OLD association; for a
-- newly inserted cleanup intent or additional Auth identity, it is the NEW association that loses it.
CREATE OR REPLACE FUNCTION dev_cloud_six.serialize_revocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rid uuid; scope text:='request'; job text:='';
BEGIN
    CASE TG_TABLE_NAME
        WHEN 'analysis_preflights' THEN rid:=OLD.consumed_request_id;
        WHEN 'analysis_requests' THEN rid:=OLD.id;
        WHEN 'analysis_pipeline_jobs' THEN rid:=OLD.request_id; scope:='job'; job:=OLD.job_key;
        WHEN 'analysis_v2_provider_cleanup_intents' THEN rid:=NEW.request_id;
        WHEN 'identities' THEN
            IF EXISTS(SELECT FROM dev_cloud_six.buyers b JOIN dev_cloud_six.waves w ON w.digest=b.wave
                      WHERE b.user_id=NEW.user_id AND w.closed_at IS NULL AND w.expires_at>clock_timestamp()) THEN
                PERFORM pg_advisory_xact_lock(dev_cloud_six.authority_key('owner',NEW.user_id));
            END IF;
            RETURN NULL;
    END CASE;
    IF EXISTS(SELECT FROM public.earlybird_orders o JOIN dev_cloud_six.order_receipts q ON q.order_id=o.id
              JOIN dev_cloud_six.waves w ON w.digest=q.wave
              WHERE o.result_request_id=rid AND w.closed_at IS NULL AND w.expires_at>clock_timestamp()) THEN
        PERFORM pg_advisory_xact_lock(dev_cloud_six.authority_key(scope,rid,job));
    END IF;
    RETURN NULL;
END; $$;

-- A grant holds shared guards through commit. Changes irrelevant to an existing grant never take these locks.
DROP TRIGGER IF EXISTS dev_cloud_six_revoke_update ON public.analysis_preflights;
CREATE TRIGGER dev_cloud_six_revoke_update AFTER UPDATE OF id, consumed_request_id, user_id, idempotency_key, created_at, access_mode,
    beta_entry_provenance, target_instagram_id, status, admission_selected_plan_id, admission_entitlement_jti_hash, order_scoped_apify_credential_slot
ON public.analysis_preflights FOR EACH ROW WHEN (OLD.consumed_request_id IS NOT NULL AND OLD.idempotency_key LIKE 'dev-cloud-six:%'
    AND (OLD.id,OLD.consumed_request_id,OLD.user_id,OLD.idempotency_key,OLD.created_at,OLD.access_mode,OLD.beta_entry_provenance,
         OLD.target_instagram_id,OLD.status,OLD.admission_selected_plan_id,OLD.admission_entitlement_jti_hash,OLD.order_scoped_apify_credential_slot)
      IS DISTINCT FROM (NEW.id,NEW.consumed_request_id,NEW.user_id,NEW.idempotency_key,NEW.created_at,NEW.access_mode,NEW.beta_entry_provenance,
         NEW.target_instagram_id,NEW.status,NEW.admission_selected_plan_id,NEW.admission_entitlement_jti_hash,NEW.order_scoped_apify_credential_slot))
    EXECUTE FUNCTION dev_cloud_six.serialize_revocation();
DROP TRIGGER IF EXISTS dev_cloud_six_revoke_delete ON public.analysis_preflights;
CREATE TRIGGER dev_cloud_six_revoke_delete AFTER DELETE ON public.analysis_preflights FOR EACH ROW
    WHEN (OLD.consumed_request_id IS NOT NULL AND OLD.idempotency_key LIKE 'dev-cloud-six:%') EXECUTE FUNCTION dev_cloud_six.serialize_revocation();

DROP TRIGGER IF EXISTS dev_cloud_six_revoke_update ON public.analysis_requests;
CREATE TRIGGER dev_cloud_six_revoke_update AFTER UPDATE OF id,user_id,preflight_id,status,pipeline_version,plan_access_mode_snapshot,
    selected_plan_id_snapshot,test_entitlement_jti_hash,target_instagram_id,policy_versions_snapshot
ON public.analysis_requests FOR EACH ROW WHEN (OLD.status IN ('pending','processing') AND
    (OLD.id,OLD.user_id,OLD.preflight_id,true,OLD.pipeline_version,OLD.plan_access_mode_snapshot,
     OLD.selected_plan_id_snapshot,OLD.test_entitlement_jti_hash,OLD.target_instagram_id,OLD.policy_versions_snapshot)
    IS DISTINCT FROM (NEW.id,NEW.user_id,NEW.preflight_id,NEW.status IN ('pending','processing'),NEW.pipeline_version,NEW.plan_access_mode_snapshot,
     NEW.selected_plan_id_snapshot,NEW.test_entitlement_jti_hash,NEW.target_instagram_id,NEW.policy_versions_snapshot))
    EXECUTE FUNCTION dev_cloud_six.serialize_revocation();
DROP TRIGGER IF EXISTS dev_cloud_six_revoke_delete ON public.analysis_requests;
CREATE TRIGGER dev_cloud_six_revoke_delete AFTER DELETE ON public.analysis_requests FOR EACH ROW
    WHEN (OLD.status IN ('pending','processing')) EXECUTE FUNCTION dev_cloud_six.serialize_revocation();

DROP TRIGGER IF EXISTS dev_cloud_six_revoke_update ON public.analysis_pipeline_jobs;
CREATE TRIGGER dev_cloud_six_revoke_update AFTER UPDATE OF request_id,job_key,status,lease_token,input_hash,lease_expires_at
ON public.analysis_pipeline_jobs FOR EACH ROW WHEN (OLD.status='processing' AND
    ((OLD.request_id,OLD.job_key,OLD.status,OLD.lease_token,OLD.input_hash)
       IS DISTINCT FROM (NEW.request_id,NEW.job_key,NEW.status,NEW.lease_token,NEW.input_hash)
     OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<OLD.lease_expires_at))
    EXECUTE FUNCTION dev_cloud_six.serialize_revocation();
DROP TRIGGER IF EXISTS dev_cloud_six_revoke_delete ON public.analysis_pipeline_jobs;
CREATE TRIGGER dev_cloud_six_revoke_delete AFTER DELETE ON public.analysis_pipeline_jobs FOR EACH ROW
    WHEN (OLD.status='processing') EXECUTE FUNCTION dev_cloud_six.serialize_revocation();

DROP TRIGGER IF EXISTS dev_cloud_six_stop_insert ON public.analysis_v2_provider_cleanup_intents;
CREATE TRIGGER dev_cloud_six_stop_insert AFTER INSERT ON public.analysis_v2_provider_cleanup_intents FOR EACH ROW
    WHEN (NEW.completed_at IS NULL) EXECUTE FUNCTION dev_cloud_six.serialize_revocation();
DROP TRIGGER IF EXISTS dev_cloud_six_stop_update ON public.analysis_v2_provider_cleanup_intents;
CREATE TRIGGER dev_cloud_six_stop_update AFTER UPDATE OF request_id,completed_at ON public.analysis_v2_provider_cleanup_intents FOR EACH ROW
    WHEN (NEW.completed_at IS NULL AND (OLD.completed_at IS NOT NULL OR OLD.request_id<>NEW.request_id))
    EXECUTE FUNCTION dev_cloud_six.serialize_revocation();

-- Existing identity rows are locked for share. A second linked identity would invalidate valid_principal.
DROP TRIGGER IF EXISTS dev_cloud_six_identity_insert ON auth.identities;
CREATE TRIGGER dev_cloud_six_identity_insert AFTER INSERT ON auth.identities FOR EACH ROW EXECUTE FUNCTION dev_cloud_six.serialize_revocation();
DROP TRIGGER IF EXISTS dev_cloud_six_identity_move ON auth.identities;
CREATE TRIGGER dev_cloud_six_identity_move AFTER UPDATE OF user_id ON auth.identities FOR EACH ROW
    WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id) EXECUTE FUNCTION dev_cloud_six.serialize_revocation();

CREATE OR REPLACE FUNCTION dev_cloud_six.lock_approved(w text,request uuid,job text,claim uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE owner_id uuid;
BEGIN
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted')
        OR request IS NULL OR job IS NULL OR claim IS NULL THEN RETURN false; END IF;

    -- These original owner/receipt rows are stable during ordinary analysis, including sibling jobs.
    SELECT b.user_id INTO owner_id FROM dev_cloud_six.waves v JOIN dev_cloud_six.buyers b ON b.wave=v.digest
    JOIN dev_cloud_six.order_receipts q ON q.wave=b.wave AND q.slot=b.slot
    JOIN public.earlybird_orders o ON o.id=q.order_id AND o.result_request_id=request AND o.user_id=b.user_id
    JOIN public.earlybird_fulfillments f ON f.order_id=o.id AND f.request_id=request
    JOIN public.users u ON u.id=b.user_id JOIN auth.users a ON a.id=b.user_id
    JOIN auth.identities i ON i.user_id=b.user_id AND i.provider='email'
    WHERE v.digest=w AND v.closed_at IS NULL AND v.expires_at>clock_timestamp()
    FOR SHARE OF v,b,q,o,f,u,a,i NOWAIT;
    IF NOT FOUND THEN RETURN false; END IF;

    -- Allocators may already hold provider/budget locks. Never wait in the reverse direction for a revocation.
    IF NOT pg_try_advisory_xact_lock_shared(dev_cloud_six.authority_key('request',request))
       OR NOT pg_try_advisory_xact_lock_shared(dev_cloud_six.authority_key('job',request,job))
       OR NOT pg_try_advisory_xact_lock_shared(dev_cloud_six.authority_key('owner',owner_id)) THEN
        RAISE lock_not_available;
    END IF;
    -- A separate READ COMMITTED statement sees any revocation that committed before the guard.
    RETURN public.dev_cloud_six_capacity_approved_v1(w,request,job,claim)
        AND NOT EXISTS(SELECT FROM public.analysis_v2_provider_cleanup_intents c WHERE c.request_id=request AND c.completed_at IS NULL)
        AND EXISTS(SELECT FROM dev_cloud_six.waves WHERE digest=w AND expires_at>clock_timestamp());
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='PAID_STANDARD_CAPACITY_LOCK_BUSY';
END; $$;
REVOKE ALL ON FUNCTION dev_cloud_six.authority_key(text,uuid,text),dev_cloud_six.serialize_revocation(),
    dev_cloud_six.lock_approved(text,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.authorize_dev_cloud_six_vertex_dispatch_v1(p_wave text,p_request_id uuid,p_job_key text,p_claim_token uuid,p_job_input_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_job_key IS NULL OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_input_hash IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR NOT dev_cloud_six.lock_approved(p_wave,p_request_id,p_job_key,p_claim_token) THEN RETURN false; END IF;
    RETURN EXISTS(SELECT FROM public.analysis_pipeline_jobs j JOIN dev_cloud_six.waves w ON w.digest=p_wave
        WHERE j.request_id=p_request_id AND j.job_key=p_job_key AND j.input_hash=p_job_input_hash
            AND j.lease_token=p_claim_token AND j.lease_expires_at>clock_timestamp() AND w.expires_at>clock_timestamp());
END; $$;

CREATE OR REPLACE FUNCTION public.reserve_dev_cloud_six_ai_attempt_v1(p_wave text,p_request_id uuid,p_job_key text,p_claim_token uuid,
    p_operation_key text,p_attempt smallint,p_reservation_token uuid,p_metadata jsonb,p_job_input_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt jsonb;
BEGIN
    IF NOT public.dev_cloud_six_capacity_approved_v1(p_wave,p_request_id,p_job_key,p_claim_token) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED';
    END IF;
    receipt:=public.reserve_analysis_v2_ai_attempt(p_request_id,p_job_key,p_claim_token,p_operation_key,p_attempt,p_reservation_token,p_metadata);
    IF NOT public.authorize_dev_cloud_six_vertex_dispatch_v1(p_wave,p_request_id,p_job_key,p_claim_token,p_job_input_hash) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED';
    END IF;
    RETURN receipt;
END; $$;
COMMIT;
