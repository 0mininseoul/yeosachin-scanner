SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    DROP CONSTRAINT analysis_preflights_timestamp_order_check;

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_timestamp_order_check CHECK (
        updated_at >= created_at
        AND (claimed_at IS NULL OR claimed_at >= created_at)
        AND (dispatch_reserved_at IS NULL OR dispatch_reserved_at >= created_at)
        AND (dispatched_at IS NULL OR dispatched_at >= dispatch_reserved_at)
        AND (exclusion_decided_at IS NULL OR exclusion_decided_at >= created_at)
        AND (ready_at IS NULL OR ready_at >= created_at)
        AND (blocked_at IS NULL OR blocked_at >= created_at)
        AND (consumed_at IS NULL OR consumed_at >= created_at)
        AND (pii_scrubbed_at IS NULL OR pii_scrubbed_at >= created_at)
        AND (
            pii_scrubbed_at IS NULL
            OR status IN ('expired', 'consumed')
            OR (
                target_instagram_id = 'deleted'
                AND target_full_name IS NULL
                AND target_bio IS NULL
                AND target_profile_image_url IS NULL
                AND excluded_instagram_id IS NULL
                AND exclusion_decision = 'skip'
            )
        )
    ) NOT VALID;
