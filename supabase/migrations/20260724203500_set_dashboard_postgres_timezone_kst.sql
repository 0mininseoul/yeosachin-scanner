-- Stored timestamptz instants remain UTC.
-- Only new sessions logged in as postgres render timestamptz in KST.
-- Application/PostgREST roles remain UTC.
-- After deployment, reconnect or refresh the Dashboard Table Editor.
ALTER ROLE postgres IN DATABASE postgres SET timezone TO 'Asia/Seoul';
