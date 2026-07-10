-- Analysis requests are created and mutated only by server-side service-role code.
-- End users keep owner-scoped SELECT access for progress and Realtime updates.
DROP POLICY IF EXISTS "Users can insert own analysis requests" ON analysis_requests;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON TABLE analysis_requests
    FROM anon, authenticated;

GRANT SELECT ON TABLE analysis_requests TO authenticated;
