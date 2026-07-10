ALTER TABLE analysis_requests
    DROP CONSTRAINT IF EXISTS analysis_requests_target_instagram_id_valid;

ALTER TABLE analysis_requests
    ADD CONSTRAINT analysis_requests_target_instagram_id_valid
        CHECK (target_instagram_id ~ '^[A-Za-z0-9._]{1,30}$');
