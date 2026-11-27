-- Registered Dev only. Machine orders carry a zero-amount QA receipt, not a Groble payment.
BEGIN;
CREATE FUNCTION dev_cloud_six.validate_fixture_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT FROM dev_cloud_six.order_receipts q JOIN dev_cloud_six.buyers b USING(wave,slot)
      WHERE q.order_id=NEW.id AND q.preflight_id=NEW.preflight_id AND b.user_id=NEW.user_id
        AND public.dev_cloud_six_scope_v1(q.wave,b.user_id,NEW.preflight_id,NULL,NULL)=b.slot)
      OR NEW.plan_id IS DISTINCT FROM 'standard' OR NEW.target_instagram_id IS DISTINCT FROM lpad('target7',30,'t')
      OR NEW.actual_amount_krw IS DISTINCT FROM 0 OR NEW.payment_id IS DISTINCT FROM 'fixture-payment-'||NEW.id::text
      OR NEW.buyer_match_policy IS DISTINCT FROM 'legacy_email' OR NEW.plan_sequence IS NOT NULL
      OR NEW.status IS DISTINCT FROM 'paid' THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_ORDER_DENIED';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION dev_cloud_six.validate_fixture_order() FROM PUBLIC,anon,authenticated,service_role;
-- Preserve the original Kakao trigger for every non-fixture product. The reserved product
-- must pass a private, single-order receipt instead and can never add a Kakao phone snapshot.
DO $triggers$
DECLARE t record; prior pg_trigger;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('set_earlybird_order_phone_snapshot_before_insert','public.set_earlybird_order_phone_snapshot()',
          'BEFORE INSERT'),
        ('on_earlybird_order_paid_discord_outbox','public.enqueue_earlybird_payment_discord_outbox()',
          'AFTER INSERT OR UPDATE OF status')
    ) expected(name,func,timing) LOOP
        SELECT * INTO STRICT prior FROM pg_trigger WHERE tgrelid='public.earlybird_orders'::regclass AND tgname=t.name;
        IF prior.tgenabled<>'O' OR prior.tgfoid<>t.func::regprocedure OR prior.tgisinternal OR prior.tgnargs<>0
            OR prior.tgqual IS NOT NULL OR prior.tgconstraint<>0 OR strpos(pg_get_triggerdef(prior.oid),
            t.timing||' ON public.earlybird_orders FOR EACH ROW EXECUTE FUNCTION')=0
            THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_ORDER_TRIGGER_DRIFT'; END IF;
    END LOOP;
END;
$triggers$;
DROP TRIGGER set_earlybird_order_phone_snapshot_before_insert ON public.earlybird_orders;
CREATE TRIGGER set_earlybird_order_phone_snapshot_before_insert BEFORE INSERT ON public.earlybird_orders
    FOR EACH ROW WHEN (NEW.expected_groble_product_id IS DISTINCT FROM 'shared-standard-fixture')
    EXECUTE FUNCTION public.set_earlybird_order_phone_snapshot();
CREATE TRIGGER validate_dev_cloud_six_order BEFORE INSERT ON public.earlybird_orders
    FOR EACH ROW WHEN (NEW.expected_groble_product_id='shared-standard-fixture')
    EXECUTE FUNCTION dev_cloud_six.validate_fixture_order();
-- A cloud QA order is not a customer sale. Keep its private receipt out of the Discord sales queue.
DROP TRIGGER on_earlybird_order_paid_discord_outbox ON public.earlybird_orders;
CREATE TRIGGER on_earlybird_order_paid_discord_outbox AFTER INSERT OR UPDATE OF status ON public.earlybird_orders
    FOR EACH ROW WHEN (NEW.expected_groble_product_id IS DISTINCT FROM 'shared-standard-fixture')
    EXECUTE FUNCTION public.enqueue_earlybird_payment_discord_outbox();

CREATE FUNCTION public.dev_cloud_six_create_order_v1(p_wave text,p_owner_id uuid,p_preflight_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.analysis_preflights; n smallint; purchase uuid; price integer; ts timestamptz;
BEGIN
    IF p_owner_id IS NULL OR p_preflight_id IS NULL THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_ORDER_DENIED'; END IF;
    PERFORM 1 FROM dev_cloud_six.waves WHERE digest=p_wave AND closed_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_CLOSED'; END IF;
    SELECT * INTO p FROM public.analysis_preflights WHERE id=p_preflight_id AND user_id=p_owner_id FOR UPDATE;
    n:=public.dev_cloud_six_scope_v1(p_wave,p_owner_id,p_preflight_id,NULL,NULL);
    IF n IS NULL THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_ORDER_DENIED'; END IF;
    SELECT order_id INTO purchase FROM dev_cloud_six.order_receipts WHERE wave=p_wave AND slot=n AND preflight_id=p.id;
    IF FOUND THEN RETURN purchase; END IF;
    ts:=clock_timestamp();
    IF p.status<>'ready' OR p.expires_at<=ts OR p.exclusion_decision NOT IN ('skip','exclude')
        OR p.target_followers_count IS NULL OR p.target_following_count IS NULL
        OR (p.plan_cards_snapshot->'standard'->>'selectionState') IS NULL
        OR (p.plan_cards_snapshot->'standard'->>'selectionState') NOT IN ('required','available_upgrade')
        OR p.pricing_snapshot->'standard'->>'status' IS DISTINCT FROM 'quoted'
        OR p.pricing_snapshot->'standard'->>'currency' IS DISTINCT FROM 'KRW' THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_PREFLIGHT_NOT_READY';
    END IF;
    price:=(p.pricing_snapshot->'standard'->>'amountKrw')::integer;
    IF price IS NULL OR price<=0 THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_PRICE_UNAVAILABLE'; END IF;
    purchase:=gen_random_uuid();
    INSERT INTO dev_cloud_six.order_receipts(wave,slot,preflight_id,order_id) VALUES(p_wave,n,p.id,purchase);
    INSERT INTO public.earlybird_orders(id,user_id,preflight_id,target_instagram_id,target_followers_count,target_following_count,
        exclusion_decision,excluded_instagram_id,plan_id,pricing_version,expected_amount_krw,expected_groble_product_id,
        buyer_match_policy,disclosure_version,disclosure_text,disclosure_accepted_at,status,payment_id,actual_groble_product_id,
        actual_amount_krw,paid_at,seller_reference_confirmed_at)
    VALUES(purchase,p_owner_id,p.id,p.target_instagram_id,p.target_followers_count,p.target_following_count,p.exclusion_decision,
        p.excluded_instagram_id,'standard',p.pricing_version,price,'shared-standard-fixture','legacy_email','dev-cloud-six-v1',
        'Dev 합성 주문. 실제 결제 0원.',ts,'paid','fixture-payment-'||purchase::text,'shared-standard-fixture',0,ts,ts);
    IF NOT public.bind_earlybird_order_scoped_apify_slot(purchase,'secondary') THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_SLOT_BIND_FAILED';
    END IF;
    UPDATE public.earlybird_fulfillments SET capacity_queued_at=ts WHERE order_id=purchase AND status='awaiting_operator';
    IF NOT FOUND THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_FULFILLMENT_MISSING'; END IF;
    RETURN purchase;
END;
$$;
REVOKE ALL ON FUNCTION public.dev_cloud_six_create_order_v1(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dev_cloud_six_create_order_v1(text,uuid,uuid) TO service_role;

CREATE FUNCTION public.handoff_dev_cloud_six_fulfillment_v1(p_wave text,p_preflight_id uuid,p_generation integer,
    p_dispatch_generation integer,p_dispatch_token uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE purchase uuid; existing uuid; delivery record; result record;
BEGIN
    PERFORM 1 FROM dev_cloud_six.waves WHERE digest=p_wave AND closed_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT o.id,f.request_id INTO purchase,existing FROM dev_cloud_six.order_receipts q
        JOIN public.earlybird_orders o ON o.id=q.order_id JOIN public.earlybird_fulfillments f ON f.order_id=o.id
        JOIN public.analysis_preflights p ON p.id=o.preflight_id AND p.id=q.preflight_id
    WHERE q.wave=p_wave AND p.id=p_preflight_id AND p.admission_status='ready' AND p.admission_generation=p_generation
        AND p.admission_dispatch_generation=p_dispatch_generation AND p.admission_dispatch_token=p_dispatch_token
        AND p.admission_dispatch_workload_role='paid' AND p.admission_dispatch_contract_version=2
        AND public.dev_cloud_six_scope_v1(p_wave,o.user_id,p.id,o.id,NULL) IS NOT NULL
        AND p.admission_selected_plan_id='standard' AND q.actual_charge_krw=0 AND o.actual_amount_krw=0
        AND o.payment_id='fixture-payment-'||o.id::text AND o.seller_reference_confirmed_at IS NOT NULL
        AND p.admission_entitlement_jti_hash=encode(sha256(convert_to('earlybird-fulfillment-admission-v1'||chr(10)||o.id::text,'UTF8')),'hex')
        AND f.operator_admitted_at IS NOT NULL AND f.capacity_acquired_at IS NOT NULL
        AND f.status IN ('admission_pending','retryable_failure','analysis_in_progress') AND o.status IN ('paid','analysis_in_progress')
    FOR UPDATE OF f,o,p NOWAIT;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF existing IS NOT NULL THEN
        IF public.dev_cloud_six_scope_v1(p_wave,NULL,p_preflight_id,purchase,existing) IS NOT NULL THEN RETURN existing; END IF;
        RETURN NULL;
    END IF;
    SELECT * INTO STRICT delivery FROM public.claim_earlybird_fulfillment(purchase,gen_random_uuid(),300);
    IF NOT delivery.claimed THEN RETURN NULL; END IF;
    SELECT * INTO STRICT result FROM public.create_or_replay_earlybird_fulfillment_request(purchase,delivery.lease_token,delivery.lease_fence);
    IF result.fulfillment_status='analysis_in_progress' THEN RETURN result.request_id; END IF;
    RETURN NULL;
END;
$$;
CREATE FUNCTION public.complete_dev_cloud_six_order_v1(p_wave text,p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE purchase uuid; finished boolean; ts timestamptz;
BEGIN
    PERFORM 1 FROM dev_cloud_six.waves WHERE digest=p_wave AND closed_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT o.id, f.status='completed' AND o.status='completed' INTO purchase,finished FROM dev_cloud_six.order_receipts q JOIN public.earlybird_orders o ON o.id=q.order_id
        JOIN public.earlybird_fulfillments f ON f.order_id=o.id JOIN public.analysis_requests r ON r.id=f.request_id
        JOIN public.analysis_v2_result_summaries s ON s.request_id=r.id
    WHERE r.id=p_request_id AND q.wave=p_wave AND r.status='completed' AND r.completed_at IS NOT NULL
        AND (f.status,o.status) IN (('analysis_in_progress','analysis_in_progress'),('completed','completed'))
        AND f.capacity_first_started_at IS NOT NULL
        AND s.plan_id='standard' AND public.paid_result_target_matches_v1(r.id,r.target_instagram_id,s.target_instagram_id,o.target_instagram_id)
        AND public.dev_cloud_six_scope_v1(p_wave,o.user_id,q.preflight_id,q.order_id,r.id) IS NOT NULL
    FOR UPDATE OF o,f;
    IF NOT FOUND THEN RETURN false; END IF;
    IF finished THEN RETURN public.analysis_result_publication_authorized(p_request_id); END IF;
    ts:=clock_timestamp();
    UPDATE public.earlybird_fulfillments SET status='completed',completed_at=ts,updated_at=ts WHERE order_id=purchase;
    UPDATE public.earlybird_orders SET status='completed',updated_at=ts WHERE id=purchase;
    IF NOT public.analysis_result_publication_authorized(p_request_id) THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_RESULT_NOT_PUBLISHED'; END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.handoff_dev_cloud_six_fulfillment_v1(text,uuid,integer,integer,uuid),
    public.complete_dev_cloud_six_order_v1(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.handoff_dev_cloud_six_fulfillment_v1(text,uuid,integer,integer,uuid),
    public.complete_dev_cloud_six_order_v1(text,uuid) TO service_role;
-- Operator and reader jobs use these IDs only in memory. The output never includes a real human account.
CREATE FUNCTION public.dev_cloud_six_order_state_v1(p_wave text)
RETURNS TABLE(slot integer,owner_id uuid,preflight_id uuid,order_id uuid,request_id uuid,preflight_status text,
    request_status text,order_status text,seat_at timestamptz,published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT b.slot::integer,b.user_id,p.id,o.id,r.id,p.status,r.status::text,o.status,f.capacity_first_started_at,
        CASE WHEN f.status='completed' AND o.status='completed' AND public.analysis_result_publication_authorized(r.id)
            THEN f.completed_at END
    FROM dev_cloud_six.waves w JOIN dev_cloud_six.buyers b ON b.wave=w.digest
    JOIN auth.users a ON a.id=b.user_id AND dev_cloud_six.valid_principal(w.digest,b.slot,a)
    LEFT JOIN public.analysis_preflights p ON p.user_id=b.user_id AND p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot
        AND p.access_mode='production' AND p.created_at>=w.opened_at
    LEFT JOIN dev_cloud_six.order_receipts q ON q.wave=b.wave AND q.slot=b.slot AND q.preflight_id=p.id
    LEFT JOIN public.earlybird_orders o ON o.id=q.order_id AND o.user_id=b.user_id AND o.preflight_id=p.id
    LEFT JOIN public.earlybird_fulfillments f ON f.order_id=o.id
    LEFT JOIN public.analysis_requests r ON r.id=f.request_id AND r.id=o.result_request_id AND r.id=p.consumed_request_id
        AND r.user_id=b.user_id AND r.preflight_id=p.id
    WHERE w.digest=p_wave AND w.closed_at IS NULL AND w.expires_at>statement_timestamp()
      AND public.dev_cloud_six_scope_v1(p_wave,b.user_id,NULL,NULL,NULL) IS NOT NULL
    ORDER BY b.slot
$$;
REVOKE ALL ON FUNCTION public.dev_cloud_six_order_state_v1(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dev_cloud_six_order_state_v1(text) TO service_role;
COMMIT;
