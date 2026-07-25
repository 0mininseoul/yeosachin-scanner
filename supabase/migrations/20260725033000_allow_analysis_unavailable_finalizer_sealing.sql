ALTER TABLE public.analysis_v2_candidate_feature_rows
    DROP CONSTRAINT analysis_v2_candidate_feature_resolution_change_check;

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD CONSTRAINT analysis_v2_candidate_feature_resolution_change_check CHECK (
        (
            classification_source = 'gender_resolution'
            AND gender_resolution_status = 'ready_applied'
            AND baseline_classification IN (
                'unresolved', 'unresolved_stage_conflict'
            )
            AND terminal_classification IN (
                'verified_female', 'verified_non_female'
            )
        )
        OR (
            classification_source <> 'gender_resolution'
            AND gender_resolution_status <> 'ready_applied'
            AND terminal_classification = CASE baseline_classification
                WHEN 'fetch_unavailable' THEN 'unavailable'
                WHEN 'analysis_unavailable' THEN 'unavailable'
                ELSE baseline_classification
            END
        )
        OR (
            baseline_classification = 'analysis_unavailable'
            AND terminal_classification = 'media_unavailable'
            AND classification_source = 'unavailable'
            AND gender_resolution_status <> 'ready_applied'
            AND unavailable_reason IS NULL
        )
    );
