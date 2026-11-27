-- Apply only to the registered Dev database. No live provider grant or owner login is issued.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
    IF to_regclass('dev_ui.runs') IS NULL OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR to_regprocedure('public.dev_live_owner_start_v4(uuid,text,uuid)') IS NULL
        OR to_regnamespace('paid_standard_capacity') IS NOT NULL THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_WRONG_DATABASE';
    END IF;
END;
$$;
CREATE SCHEMA dev_cloud_six;
REVOKE ALL ON SCHEMA dev_cloud_six FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE dev_cloud_six.waves (
    digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
    opened_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, closed_at timestamptz,
    CHECK (expires_at = opened_at + interval '3 hours')
);
CREATE TABLE dev_cloud_six.buyers (
    wave text NOT NULL REFERENCES dev_cloud_six.waves(digest),
    slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 6), user_id uuid NOT NULL UNIQUE,
    PRIMARY KEY (wave,slot)
);
CREATE TABLE dev_cloud_six.order_receipts (
    wave text NOT NULL, slot smallint NOT NULL, order_id uuid PRIMARY KEY
      REFERENCES public.earlybird_orders(id) DEFERRABLE INITIALLY DEFERRED,
    preflight_id uuid NOT NULL UNIQUE REFERENCES public.analysis_preflights(id),
    actual_charge_krw integer NOT NULL DEFAULT 0 CHECK (actual_charge_krw=0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (wave,slot), FOREIGN KEY(wave,slot) REFERENCES dev_cloud_six.buyers(wave,slot)
);
REVOKE ALL ON ALL TABLES IN SCHEMA dev_cloud_six FROM PUBLIC, anon, authenticated, service_role;

-- Auth Admin sets app_metadata. Values from user_metadata or client JWT claims cannot enroll a buyer.
CREATE FUNCTION dev_cloud_six.valid_principal(w text, n smallint, a auth.users)
RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
    SELECT a.email = 'dev-six-' || left(w,16) || '-' || n::text || '@example.invalid'
        AND a.email_confirmed_at IS NOT NULL AND a.deleted_at IS NULL
        AND a.raw_app_meta_data->>'provider'='email'
        AND a.raw_app_meta_data->>'dev_cloud_six_v1'=w
        AND a.raw_app_meta_data->'dev_cloud_six_slot'=to_jsonb(n)
        AND (SELECT count(*) FROM auth.identities i WHERE i.user_id=a.id)=1
        AND EXISTS (SELECT FROM auth.identities i WHERE i.user_id=a.id AND i.provider='email'
            AND i.identity_data->>'email'=a.email)
$$;
REVOKE ALL ON FUNCTION dev_cloud_six.valid_principal(text,smallint,auth.users) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.dev_cloud_six_open_v1(p_wave text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE opened timestamptz; enrolled integer;
BEGIN
    IF p_wave IS NULL OR p_wave !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_INVALID_WAVE'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('dev-cloud-six-registry-v1',0));
    opened := clock_timestamp();
    IF EXISTS(SELECT FROM dev_cloud_six.waves WHERE digest=p_wave) THEN
        IF NOT EXISTS(SELECT FROM dev_cloud_six.waves WHERE digest=p_wave AND closed_at IS NULL AND expires_at>opened) THEN
            RAISE EXCEPTION 'DEV_CLOUD_SIX_CLOSED';
        END IF;
    ELSE
        IF EXISTS(SELECT FROM dev_cloud_six.waves WHERE closed_at IS NULL AND expires_at>opened) THEN
            RAISE EXCEPTION 'DEV_CLOUD_SIX_BUSY';
        END IF;
        INSERT INTO dev_cloud_six.waves VALUES (p_wave,opened,opened+interval '3 hours',NULL);
        INSERT INTO dev_cloud_six.buyers(wave,slot,user_id)
        SELECT p_wave, n, a.id FROM generate_series(1,6) n
        JOIN auth.users a ON a.email='dev-six-' || left(p_wave,16) || '-' || n::text || '@example.invalid'
        WHERE dev_cloud_six.valid_principal(p_wave,n::smallint,a);
        -- Only new, registered email QA principals can become internal test buyers.
        INSERT INTO public.users(id,email,provider,account_class,traffic_class,classification_version)
        SELECT a.id,a.email,'email','e2e_test','internal_tester','dev_cloud_six_v1' FROM dev_cloud_six.buyers b
        JOIN auth.users a ON a.id=b.user_id WHERE b.wave=p_wave
        ON CONFLICT (id) DO UPDATE SET account_class='e2e_test',traffic_class='internal_tester',classification_version='dev_cloud_six_v1'
        WHERE users.email=EXCLUDED.email AND users.provider='email' AND users.account_class='production' AND users.traffic_class='external'
          AND users.lifecycle='active' AND users.first_paid_at IS NULL AND users.phone_number IS NULL
          AND NOT EXISTS(SELECT FROM public.earlybird_orders o WHERE o.user_id=users.id)
          AND NOT EXISTS(SELECT FROM public.analysis_preflights p WHERE p.user_id=users.id);
    END IF;
    SELECT count(*) INTO enrolled FROM dev_cloud_six.buyers b
    JOIN auth.users a ON a.id=b.user_id AND dev_cloud_six.valid_principal(b.wave,b.slot,a)
    JOIN public.users u ON u.id=b.user_id AND u.account_class='e2e_test' AND u.traffic_class='internal_tester'
       AND u.lifecycle='active' AND u.provider='email' AND u.classification_version='dev_cloud_six_v1'
    WHERE b.wave=p_wave;
    IF enrolled<>6 THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_BUYERS_INCOMPLETE'; END IF;
    RETURN enrolled;
END;
$$;

CREATE FUNCTION public.dev_cloud_six_close_v1(p_wave text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('dev-cloud-six-registry-v1',0));
    UPDATE dev_cloud_six.waves SET closed_at=clock_timestamp() WHERE digest=p_wave AND closed_at IS NULL;
    RETURN EXISTS(SELECT FROM dev_cloud_six.waves WHERE digest=p_wave);
END;
$$;

-- Paid preflight, order and request each have a unique DB relationship to their predecessor.
-- A completed scrub may replace the two target fields, but the order retains the original target.
CREATE FUNCTION public.dev_cloud_six_scope_v1(p_wave text,p_owner_id uuid DEFAULT NULL,p_preflight_id uuid DEFAULT NULL,
    p_order_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT b.slot::integer FROM dev_cloud_six.waves w JOIN dev_cloud_six.buyers b ON b.wave=w.digest
    JOIN auth.users a ON a.id=b.user_id AND dev_cloud_six.valid_principal(w.digest,b.slot,a)
    JOIN public.users u ON u.id=b.user_id AND u.provider='email' AND u.account_class='e2e_test'
       AND u.traffic_class='internal_tester' AND u.lifecycle='active' AND u.classification_version='dev_cloud_six_v1'
    LEFT JOIN public.analysis_preflights p ON p.user_id=b.user_id AND p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot
    LEFT JOIN public.earlybird_orders o ON o.preflight_id=p.id AND o.user_id=b.user_id
    LEFT JOIN public.analysis_requests r ON r.preflight_id=p.id AND r.user_id=b.user_id
    WHERE w.digest=p_wave AND w.closed_at IS NULL AND w.expires_at>statement_timestamp()
      AND num_nonnulls(p_owner_id,p_preflight_id,p_order_id,p_request_id)>0
      AND (p_owner_id IS NULL OR p_owner_id=b.user_id)
      AND (p_preflight_id IS NULL OR p_preflight_id=p.id)
      AND (p_order_id IS NULL OR p_order_id=o.id)
      AND (p_request_id IS NULL OR p_request_id=r.id)
      AND (p_preflight_id IS NULL AND p_order_id IS NULL AND p_request_id IS NULL OR (
        p.created_at>=w.opened_at AND p.access_mode='production' AND p.beta_entry_provenance IS NULL
        AND (p.target_instagram_id=lpad('target7',30,'t') OR (
          p.pii_scrubbed_at IS NOT NULL AND p.status='consumed' AND p.consumed_request_id=r.id
          AND r.status='completed' AND p.consumed_at<=r.completed_at AND r.completed_at<=p.pii_scrubbed_at
          AND p.target_instagram_id='retained.'||left(replace(p.id::text,'-',''),20)
          AND o.target_instagram_id=lpad('target7',30,'t')))))
      AND (p_order_id IS NULL AND p_request_id IS NULL OR
          (o.target_instagram_id=lpad('target7',30,'t') AND o.plan_id='standard' AND o.expected_groble_product_id='shared-standard-fixture'
           AND o.concierge_apify_credential_slot='secondary' AND p.order_scoped_apify_credential_slot='secondary'
           AND o.actual_amount_krw=0 AND o.payment_id='fixture-payment-'||o.id::text AND EXISTS(
              SELECT FROM dev_cloud_six.order_receipts e WHERE e.wave=b.wave AND e.slot=b.slot
                AND e.order_id=o.id AND e.preflight_id=p.id AND e.actual_charge_krw=0)))
      AND (p_request_id IS NULL OR (
          r.pipeline_version='v2' AND r.plan_access_mode_snapshot='production' AND r.selected_plan_id_snapshot='standard'
          AND r.test_entitlement_jti_hash IS NULL AND r.policy_versions_snapshot->>'aiStage'='ai-stage-policy-v2.11'
          AND r.target_instagram_id IN (lpad('target7',30,'t'),
            CASE WHEN r.status='completed' AND p.pii_scrubbed_at IS NOT NULL THEN 'retained.'||left(replace(r.id::text,'-',''),20) END)
          AND p.status='consumed' AND p.consumed_request_id=r.id AND p.admission_selected_plan_id='standard'
          AND p.admission_entitlement_jti_hash=encode(sha256(convert_to('earlybird-fulfillment-admission-v1'||chr(10)||o.id::text,'UTF8')),'hex')
          AND o.result_request_id=r.id AND o.status IN ('analysis_in_progress','completed')
          AND o.paid_at IS NOT NULL AND o.actual_amount_krw=0
          AND o.actual_groble_product_id=o.expected_groble_product_id AND o.seller_reference_confirmed_at IS NOT NULL
          AND EXISTS(SELECT FROM public.earlybird_fulfillments f WHERE f.order_id=o.id AND f.request_id=r.id
                     AND f.status IN ('analysis_in_progress','completed') AND f.operator_admitted_at IS NOT NULL)))
$$;

CREATE FUNCTION public.dev_cloud_six_result_owner_v1(p_wave text,p_request_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT auth.uid() IS NOT NULL AND p_request_id IS NOT NULL
       AND public.dev_cloud_six_scope_v1(p_wave,auth.uid(),NULL,NULL,p_request_id) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.dev_cloud_six_open_v1(text),public.dev_cloud_six_close_v1(text),
    public.dev_cloud_six_scope_v1(text,uuid,uuid,uuid,uuid),public.dev_cloud_six_result_owner_v1(text,uuid)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dev_cloud_six_open_v1(text),public.dev_cloud_six_close_v1(text),
    public.dev_cloud_six_scope_v1(text,uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_cloud_six_result_owner_v1(text,uuid) TO authenticated;
COMMIT;
