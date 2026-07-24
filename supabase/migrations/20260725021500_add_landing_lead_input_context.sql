-- Separates anonymous target submissions from authenticated exclusion inputs.
-- source_preflight_id is intentionally not a foreign key so the attribution row
-- survives bounded preflight cleanup while remaining an opaque replay key.

ALTER TABLE public.landing_leads
    ADD COLUMN input_context TEXT NOT NULL DEFAULT 'target',
    ADD COLUMN source_preflight_id UUID;

ALTER TABLE public.landing_leads
    ADD CONSTRAINT landing_leads_input_context_check CHECK (
        input_context IN ('target', 'excluded')
    ),
    ADD CONSTRAINT landing_leads_context_shape_check CHECK (
        (input_context = 'target' AND source_preflight_id IS NULL)
        OR (
            input_context = 'excluded'
            AND source_preflight_id IS NOT NULL
            AND raw_input IS NULL
            AND utm_source IS NULL
            AND utm_medium IS NULL
            AND utm_campaign IS NULL
            AND utm_content IS NULL
            AND utm_term IS NULL
            AND referrer IS NULL
            AND user_agent IS NULL
        )
    );

CREATE INDEX landing_leads_input_context_created_at_idx
    ON public.landing_leads(input_context, created_at DESC);

-- One exclusion lead per durable preflight. Anonymous target submissions keep
-- their existing append-only behavior and are deliberately not deduplicated.
CREATE UNIQUE INDEX landing_leads_excluded_preflight_uidx
    ON public.landing_leads(source_preflight_id)
    WHERE input_context = 'excluded';

ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role;
