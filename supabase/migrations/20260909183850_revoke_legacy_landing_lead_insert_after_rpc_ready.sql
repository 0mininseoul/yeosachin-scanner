-- Wave B post-deploy migration. Apply only after the RPC-backed landing code
-- is deployed and ready; this removes the old direct service_role writer.
REVOKE INSERT ON TABLE public.landing_leads FROM service_role;
