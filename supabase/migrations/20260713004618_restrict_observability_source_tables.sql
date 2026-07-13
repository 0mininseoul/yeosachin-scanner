-- These telemetry sources were originally protected by service-role-only RLS
-- policies but still exposed table metadata to public API roles through default
-- grants. Remove that unnecessary discoverability as well.
REVOKE ALL ON TABLE public.gemini_token_usage
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.gemini_token_usage TO service_role;

REVOKE ALL ON TABLE public.scraper_provider_usage
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.scraper_provider_usage TO service_role;
