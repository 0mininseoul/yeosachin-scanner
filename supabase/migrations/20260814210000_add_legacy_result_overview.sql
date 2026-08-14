ALTER TABLE public.analysis_results
    ADD COLUMN IF NOT EXISTS one_line_overview VARCHAR(180)
        CHECK (one_line_overview IS NULL OR char_length(one_line_overview) BETWEEN 1 AND 180);

COMMENT ON COLUMN public.analysis_results.one_line_overview IS
    'Bounded canonical public overview for each ranked verified-female legacy result row.';

GRANT SELECT (one_line_overview)
    ON TABLE public.analysis_results TO authenticated;
