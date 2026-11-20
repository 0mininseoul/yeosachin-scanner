-- Retain observed scores from both the legacy and current reverse-like policies.
ALTER TABLE public.analysis_order_audit_interactions
    DROP CONSTRAINT analysis_order_audit_interaction_reverse_check,
    ADD CONSTRAINT analysis_order_audit_interaction_reverse_check CHECK (
        (reverse_like_status IS NULL AND reverse_component_score IS NULL)
        OR (
            signal = 'candidate_post_like'
            AND reverse_like_status IS NOT NULL
            AND reverse_component_score IS NOT NULL
            AND (
                (reverse_like_status = 'observed' AND reverse_component_score IN (3, 5))
                OR (reverse_like_status IN ('not_observed', 'not_collected') AND reverse_component_score = 0)
            )
        )
    );
