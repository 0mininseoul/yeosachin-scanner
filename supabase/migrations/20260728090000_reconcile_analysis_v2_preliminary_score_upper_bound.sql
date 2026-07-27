-- Repair v2.4 preliminary-score bounds on databases where the recorded v2.4
-- migration did not replace the earlier three-point constraint. Keep this
-- forward-only and avoid scanning or rejecting legacy rows during rollout.

ALTER TABLE public.analysis_v2_preliminary_score_rows
    DROP CONSTRAINT IF EXISTS analysis_v2_preliminary_score_rows_possible_upper_bound_check;

ALTER TABLE public.analysis_v2_preliminary_score_rows
    ADD CONSTRAINT analysis_v2_preliminary_score_rows_possible_upper_bound_check
    CHECK (
        possible_upper_bound BETWEEN pre_score AND pre_score + 5
        AND possible_upper_bound <= 100
    ) NOT VALID;
