-- The durable B-lite finalizer/dispatch RPCs were already deployed by the additive
-- single-collection migration. Refresh PostgREST's schema cache so service-role RPC
-- calls resolve immediately after that migration rather than fail with PGRST202.
NOTIFY pgrst, 'reload schema';
