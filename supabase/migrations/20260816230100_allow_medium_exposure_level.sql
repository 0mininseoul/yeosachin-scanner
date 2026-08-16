ALTER TABLE public.analysis_results
    DROP CONSTRAINT IF EXISTS analysis_results_exposure_level_check;

ALTER TABLE public.analysis_results
    ADD CONSTRAINT analysis_results_exposure_level_check
    CHECK (exposure_level IN ('high', 'medium', 'low'));
