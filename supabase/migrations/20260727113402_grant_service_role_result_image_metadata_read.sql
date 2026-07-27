-- The demo fixture asset importer runs server-side with service_role only.
-- Keep this private metadata inaccessible to browser roles.
GRANT SELECT ON TABLE public.analysis_v2_result_image_objects TO service_role;
