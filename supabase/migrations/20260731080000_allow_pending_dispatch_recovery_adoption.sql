-- A second retention pass can leave the recorded recovery tombstone in the
-- exact pending/enqueued admission state while primary profile and plan fields
-- are already scrubbed. Validate that order-bound dispatch witness, normalize
-- only those witnessed mutable columns in a local composite, then reuse the
-- 070 fully-scrubbed/current-count policy unchanged.
ALTER FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) RENAME TO analysis_v2_valid_pre_hybrid_recovery_adoption_preflights;

CREATE FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    p_order public.earlybird_orders,
    p_recovery public.analysis_preflights,
    p_current public.analysis_preflights
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_normalized public.analysis_preflights%ROWTYPE;
    v_entitlement_hash TEXT;
BEGIN
    IF p_recovery.admission_status <> 'pending' THEN
        RETURN public.analysis_v2_valid_pre_hybrid_recovery_adoption_preflights(
            p_order, p_recovery, p_current
        );
    END IF;

    v_entitlement_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to(
            'earlybird-fulfillment-admission-v1'
            || pg_catalog.chr(10) || pg_catalog.lower(p_order.id::TEXT),
            'UTF8'
        ),
        'sha256'
    ), 'hex');
    IF p_recovery.status <> 'expired'
       OR p_recovery.pii_scrubbed_at IS NULL
       OR p_recovery.pii_scrubbed_at < p_recovery.expires_at
       OR p_recovery.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(p_recovery.id::TEXT, '-', ''), 1, 20
            )
       )
       OR p_recovery.target_full_name IS NOT NULL
       OR p_recovery.target_bio IS NOT NULL
       OR p_recovery.target_profile_image_url IS NOT NULL
       OR p_recovery.target_followers_count IS NOT NULL
       OR p_recovery.target_following_count IS NOT NULL
       OR p_recovery.target_is_private IS NOT NULL
       OR p_recovery.capacity_required_plan_id IS NOT NULL
       OR p_recovery.required_plan_id IS NOT NULL
       OR p_recovery.plan_cards_snapshot IS NOT NULL
       OR p_recovery.exclusion_decision <> 'skip'
       OR p_recovery.excluded_instagram_id IS NOT NULL
       OR p_recovery.admission_selected_plan_id IS DISTINCT FROM p_order.plan_id
       OR p_recovery.admission_entitlement_jti_hash IS DISTINCT FROM
            v_entitlement_hash
       OR p_recovery.admission_token IS NULL
       OR p_recovery.admission_requested_at IS NULL
       OR p_recovery.admission_refreshed_at IS NOT NULL
       OR p_recovery.admission_claim_token IS NOT NULL
       OR p_recovery.admission_lease_expires_at IS NOT NULL
       OR p_recovery.admission_dispatch_state <> 'enqueued'
       OR p_recovery.admission_dispatch_generation < 1
       OR p_recovery.admission_dispatch_token IS NULL
       OR p_recovery.admission_dispatch_reserved_at IS NULL
       OR p_recovery.admission_dispatched_at IS NULL
       OR p_recovery.admission_requested_at
            > p_recovery.admission_dispatch_reserved_at
       OR p_recovery.admission_dispatch_reserved_at
            > p_recovery.admission_dispatched_at
       OR p_recovery.admission_dispatched_at > p_recovery.pii_scrubbed_at
       OR p_recovery.admission_error_code IS NOT NULL
       OR p_recovery.admission_target_followers_count IS NOT NULL
       OR p_recovery.admission_target_following_count IS NOT NULL
       OR p_recovery.admission_capacity_required_plan_id IS NOT NULL
       OR p_recovery.admission_required_plan_id IS NOT NULL
       OR p_recovery.admission_plan_cards_snapshot IS NOT NULL
       OR p_recovery.admission_failure_count <> 0
       OR p_recovery.admission_last_error_code IS NOT NULL THEN
        RETURN FALSE;
    END IF;

    v_normalized := p_recovery;
    v_normalized.admission_status := 'idle';
    v_normalized.admission_generation := 0;
    v_normalized.admission_selected_plan_id := NULL;
    v_normalized.admission_entitlement_jti_hash := NULL;
    v_normalized.admission_token := NULL;
    v_normalized.admission_requested_at := NULL;
    v_normalized.admission_refreshed_at := NULL;
    v_normalized.admission_claim_token := NULL;
    v_normalized.admission_lease_expires_at := NULL;
    v_normalized.admission_dispatch_state := 'idle';
    v_normalized.admission_dispatch_generation := 0;
    v_normalized.admission_dispatch_token := NULL;
    v_normalized.admission_dispatch_reserved_at := NULL;
    v_normalized.admission_dispatched_at := NULL;
    v_normalized.admission_error_code := NULL;
    v_normalized.admission_target_followers_count := NULL;
    v_normalized.admission_target_following_count := NULL;
    v_normalized.admission_capacity_required_plan_id := NULL;
    v_normalized.admission_required_plan_id := NULL;
    v_normalized.admission_plan_cards_snapshot := NULL;
    v_normalized.admission_failure_count := 0;
    v_normalized.admission_last_error_code := NULL;

    RETURN public.analysis_v2_valid_pre_hybrid_recovery_adoption_preflights(
        p_order, v_normalized, p_current
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_pre_hybrid_recovery_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) FROM PUBLIC, anon, authenticated, service_role;
