-- Synthetic Vertex costs exercise the native policy and reservation lifecycle on their own ledger.
BEGIN;
CREATE TABLE dev_cloud_six.simulated_vertex_reservations
    (LIKE public.vertex_ai_budget_reservations INCLUDING ALL,
     wave text NOT NULL DEFAULT current_setting('dev_cloud_six.budget_wave') REFERENCES dev_cloud_six.waves(digest));
CREATE VIEW dev_cloud_six.vertex_ai_budget_reservations AS SELECT * FROM dev_cloud_six.simulated_vertex_reservations
    WHERE wave=current_setting('dev_cloud_six.budget_wave',true) WITH LOCAL CHECK OPTION;
REVOKE ALL ON dev_cloud_six.simulated_vertex_reservations,dev_cloud_six.vertex_ai_budget_reservations
    FROM PUBLIC,anon,authenticated,service_role;
DO $install$
DECLARE src record; obj regprocedure; definition text;
BEGIN
    FOR src IN SELECT * FROM (VALUES
        ('vertex_ai_budget_denial_detail_v1(text,text,text,date,numeric,numeric,numeric,numeric)','5339b02243bc23ae3de1c7e6d59c4839d47b4f9150812ac0d0add9a30dad43d4'),
        ('reserve_vertex_ai_budget(text,text,text,text,integer,text,text,text,bigint,integer,numeric,date,numeric,numeric,numeric)','45b55d1b4807f9161997a0deaea0a25b8f8c778202d98fec1980f1f35ab82b1c'),
        ('settle_vertex_ai_budget(text,uuid,numeric)','9cf3ba407b9445571b8523849890fd39bbed1b5c5ff279ec1069cd91bdf7f136'),
        ('cancel_vertex_ai_budget(text,uuid)','01672549d16208e69a44a1ad867461994d5d2ab21387fff6b69b8ba17b18b924'),
        ('snapshot_vertex_ai_budget()','fce5109940618f410bb43ac685094e2508cd480f05b372e457c558668078e470')
    ) AS funcs(signature,digest) LOOP
        obj:=('public.'||src.signature)::regprocedure;
        IF (SELECT encode(sha256(convert_to(replace(
                prosrc,
                'updated_at = GREATEST(reservation.updated_at, reservation.created_at, pg_catalog.clock_timestamp())',
                'updated_at = pg_catalog.clock_timestamp()'
            ),'UTF8')),'hex') FROM pg_proc WHERE oid=obj)<>src.digest THEN
            RAISE EXCEPTION 'DEV_CLOUD_SIX_VERTEX_BUDGET_SOURCE_DRIFT';
        END IF;
        definition:=replace(pg_get_functiondef(obj),'public.'||split_part(src.signature,'(',1)||'(',
            'dev_cloud_six.'||split_part(src.signature,'(',1)||'(');
        definition:=replace(definition,'public.vertex_ai_budget_reservations','dev_cloud_six.vertex_ai_budget_reservations');
        definition:=replace(definition,'public.vertex_ai_budget_denial_detail_v1','dev_cloud_six.vertex_ai_budget_denial_detail_v1');
        EXECUTE replace(definition,'''vertex-ai-budget:all-scopes''','''dev-cloud-six:vertex-budget:''||current_setting(''dev_cloud_six.budget_wave'')');
        EXECUTE format('REVOKE ALL ON FUNCTION dev_cloud_six.%s FROM PUBLIC,anon,authenticated,service_role',src.signature);
    END LOOP;
END;
$install$;

CREATE FUNCTION public.reserve_dev_cloud_six_vertex_budget_v1(p_wave text,p_reservation_key text,p_run_id text,p_order_id text,
    p_operation_key text,p_attempt integer,p_route text,p_model_name text,p_location text,p_input_tokens bigint,
    p_max_output_tokens integer,p_estimated_cost_usd numeric,p_day_key date,p_per_run_limit_usd numeric,
    p_per_order_limit_usd numeric,p_daily_limit_usd numeric)
RETURNS TABLE(reservation_id uuid,reservation_key text,run_id text,order_id text,day_key date,route text,model_name text,
    attempt integer,estimated_cost_usd numeric,actual_cost_usd numeric) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM 1 FROM dev_cloud_six.waves WHERE digest=p_wave AND closed_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND OR p_run_id IS NULL OR p_reservation_key IS DISTINCT FROM p_run_id||':'||p_operation_key||':'||p_attempt
       OR public.dev_cloud_six_scope_v1(p_wave,NULL,NULL,p_order_id::uuid,p_run_id::uuid) IS NULL
       OR NOT EXISTS(SELECT FROM public.analysis_pipeline_jobs j WHERE j.request_id=p_run_id::uuid AND j.status='processing'
            AND j.lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_CLAIM_REQUIRED'; END IF;
    PERFORM set_config('dev_cloud_six.budget_wave',p_wave,true);
    RETURN QUERY SELECT * FROM dev_cloud_six.reserve_vertex_ai_budget(p_reservation_key,p_run_id,p_order_id,p_operation_key,p_attempt,
        p_route,p_model_name,p_location,p_input_tokens,p_max_output_tokens,p_estimated_cost_usd,p_day_key,
        p_per_run_limit_usd,p_per_order_limit_usd,p_daily_limit_usd);
END;
$$;
CREATE FUNCTION public.settle_dev_cloud_six_vertex_budget_v1(p_wave text,p_reservation_key text,p_reservation_id uuid,p_actual_cost_usd numeric)
RETURNS TABLE(reservation_id uuid,reservation_key text,run_id text,order_id text,day_key date,route text,model_name text,
    attempt integer,estimated_cost_usd numeric,actual_cost_usd numeric) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    -- Receipt identity plus the wave-specific view permit reconciliation after close or expiry.
    PERFORM set_config('dev_cloud_six.budget_wave',p_wave,true);
    RETURN QUERY SELECT * FROM dev_cloud_six.settle_vertex_ai_budget(p_reservation_key,p_reservation_id,p_actual_cost_usd);
END;
$$;
CREATE FUNCTION public.cancel_dev_cloud_six_vertex_budget_v1(p_wave text,p_reservation_key text,p_reservation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM set_config('dev_cloud_six.budget_wave',p_wave,true);
    PERFORM dev_cloud_six.cancel_vertex_ai_budget(p_reservation_key,p_reservation_id);
END;
$$;
CREATE FUNCTION public.dev_cloud_six_vertex_budget_snapshot_v1(p_wave text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM set_config('dev_cloud_six.budget_wave',p_wave,true);
    RETURN dev_cloud_six.snapshot_vertex_ai_budget();
END;
$$;
DO $acl$
DECLARE f regprocedure;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.reserve_dev_cloud_six_vertex_budget_v1(text,text,text,text,text,integer,text,text,text,bigint,integer,numeric,date,numeric,numeric,numeric)'::regprocedure,
        'public.settle_dev_cloud_six_vertex_budget_v1(text,text,uuid,numeric)'::regprocedure,
        'public.cancel_dev_cloud_six_vertex_budget_v1(text,text,uuid)'::regprocedure,
        'public.dev_cloud_six_vertex_budget_snapshot_v1(text)'::regprocedure] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
    END LOOP;
END;
$acl$;
COMMIT;
