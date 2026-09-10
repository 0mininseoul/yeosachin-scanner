-- Account-deletion backfill and parity are additive service boundaries. The
-- legacy source remains authoritative; these functions never remove or
-- rename an object and return no account identifier.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.backfill_account_deletion_jobs_v1(
    p_limit INTEGER DEFAULT 100,
    p_cursor_hash TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source RECORD;
    v_mirror_result JSONB;
    v_canonical_state TEXT;
    v_processed INTEGER := 0;
    v_mirrored INTEGER := 0;
    v_duplicates INTEGER := 0;
    v_blocked INTEGER := 0;
    v_seen INTEGER := 0;
    v_has_more BOOLEAN := FALSE;
    v_next_cursor_hash TEXT;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_DELETION_BACKFILL_LIMIT_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF p_cursor_hash IS NOT NULL
       AND p_cursor_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_DELETION_BACKFILL_CURSOR_INVALID',
            ERRCODE = 'P0001';
    END IF;

    FOR v_source IN
        SELECT source_job.account_id,
               public.canonical_json_hash_v1(
                   'account-deletion-target',
                   pg_catalog.jsonb_build_object('account_id', source_job.account_id::TEXT)
               ) AS target_key_hash
        FROM public.account_deletion_jobs AS source_job
        WHERE p_cursor_hash IS NULL
           OR public.canonical_json_hash_v1(
               'account-deletion-target',
               pg_catalog.jsonb_build_object('account_id', source_job.account_id::TEXT)
           ) > p_cursor_hash
        ORDER BY target_key_hash
        LIMIT p_limit + 1
    LOOP
        v_seen := v_seen + 1;
        IF v_seen > p_limit THEN
            v_has_more := TRUE;
            EXIT;
        END IF;

        v_processed := v_processed + 1;
        v_next_cursor_hash := v_source.target_key_hash;
        v_mirror_result := public.mirror_account_deletion_job_v1(v_source.account_id);

        SELECT maintenance_job.state
        INTO v_canonical_state
        FROM public.maintenance_jobs AS maintenance_job
        WHERE maintenance_job.kind = 'purge'
          AND maintenance_job.target_key_hash = v_source.target_key_hash;

        IF v_canonical_state = 'blocked' THEN
            v_blocked := v_blocked + 1;
        ELSIF COALESCE((v_mirror_result->>'duplicate')::BOOLEAN, FALSE) THEN
            v_duplicates := v_duplicates + 1;
        ELSE
            v_mirrored := v_mirrored + 1;
        END IF;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'schema_version', 'supabase-22-account-deletion-backfill-v1',
        'status', CASE WHEN v_blocked > 0 THEN 'blocked' ELSE 'completed' END,
        'processed', v_processed,
        'mirrored', v_mirrored,
        'duplicates', v_duplicates,
        'blocked', v_blocked,
        'has_more', v_has_more,
        'next_cursor_hash', v_next_cursor_hash
    );
END;
$$;

CREATE FUNCTION public.collect_account_deletion_parity_v1()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '2min'
AS $$
WITH source_rows AS (
    SELECT public.canonical_json_hash_v1(
               'account-deletion-target',
               pg_catalog.jsonb_build_object('account_id', source_job.account_id::TEXT)
           ) AS target_key_hash,
           'purge'::TEXT AS kind,
           CASE
               WHEN source_job.state = 'completed' THEN 'succeeded'
               ELSE 'queued'
           END AS canonical_state,
           pg_catalog.jsonb_build_object(
               'source_table', 'account_deletion_jobs',
               'source_key_hash', public.canonical_json_hash_v1(
                   'account-deletion-target',
                   pg_catalog.jsonb_build_object('account_id', source_job.account_id::TEXT)
               ),
               'legacy_state', source_job.state,
               'requested_at', pg_catalog.to_char(
                   source_job.requested_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ),
               'objects_purged_at', CASE
                   WHEN source_job.objects_purged_at IS NULL THEN NULL
                   ELSE pg_catalog.to_char(
                       source_job.objects_purged_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   )
               END,
               'database_purged_at', CASE
                   WHEN source_job.database_purged_at IS NULL THEN NULL
                   ELSE pg_catalog.to_char(
                       source_job.database_purged_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   )
               END,
               'completed_at', CASE
                   WHEN source_job.completed_at IS NULL THEN NULL
                   ELSE pg_catalog.to_char(
                       source_job.completed_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   )
               END,
               'source_updated_at', pg_catalog.to_char(
                   source_job.updated_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
           ) AS payload
    FROM public.account_deletion_jobs AS source_job
), source_projection AS (
    SELECT source_row.target_key_hash,
           source_row.kind,
           source_row.canonical_state,
           source_row.payload,
           public.canonical_json_hash_v1(
               'account-deletion-maintenance-content',
               source_row.payload
           ) AS content_hash
    FROM source_rows AS source_row
), canonical_projection AS (
    SELECT maintenance_job.target_key_hash,
           maintenance_job.kind,
           maintenance_job.state AS canonical_state,
           maintenance_job.payload,
           maintenance_job.content_hash
    FROM public.maintenance_jobs AS maintenance_job
    WHERE maintenance_job.payload->>'source_table' = 'account_deletion_jobs'
), source_summary AS (
    SELECT pg_catalog.count(*)::BIGINT AS source_count,
           CASE
               WHEN pg_catalog.count(*) = 0 THEN NULL
               ELSE pg_catalog.encode(
                   extensions.digest(
                       pg_catalog.convert_to(
                           pg_catalog.string_agg(
                               pg_catalog.length(source_row.target_key_hash)::TEXT
                                   || ':' || source_row.target_key_hash || E'\n'
                                   || source_row.kind || E'\n'
                                   || source_row.canonical_state || E'\n'
                                   || pg_catalog.length(source_row.content_hash)::TEXT
                                   || ':' || source_row.content_hash,
                               E'\n' ORDER BY source_row.target_key_hash
                           ) || E'\n',
                           'UTF8'
                       ),
                       'sha256'
                   ),
                   'hex'
               )
           END AS source_checksum
    FROM source_projection AS source_row
), canonical_summary AS (
    SELECT pg_catalog.count(*)::BIGINT AS canonical_count,
           CASE
               WHEN pg_catalog.count(*) = 0 THEN NULL
               ELSE pg_catalog.encode(
                   extensions.digest(
                       pg_catalog.convert_to(
                           pg_catalog.string_agg(
                               pg_catalog.length(canonical_row.target_key_hash)::TEXT
                                   || ':' || canonical_row.target_key_hash || E'\n'
                                   || canonical_row.kind || E'\n'
                                   || canonical_row.canonical_state || E'\n'
                                   || pg_catalog.length(canonical_row.content_hash)::TEXT
                                   || ':' || canonical_row.content_hash,
                               E'\n' ORDER BY canonical_row.target_key_hash
                           ) || E'\n',
                           'UTF8'
                       ),
                       'sha256'
                   ),
                   'hex'
               )
           END AS canonical_checksum
    FROM canonical_projection AS canonical_row
), canonical_duplicate_keys AS (
    SELECT canonical_row.target_key_hash
    FROM canonical_projection AS canonical_row
    GROUP BY canonical_row.target_key_hash
    HAVING pg_catalog.count(*) > 1
), comparisons AS (
    SELECT source_row.target_key_hash AS source_key,
           canonical_row.target_key_hash AS canonical_key,
           source_row.kind AS source_kind,
           canonical_row.kind AS canonical_kind,
           source_row.canonical_state AS source_state,
           canonical_row.canonical_state AS canonical_state,
           source_row.content_hash AS source_content_hash,
           canonical_row.content_hash AS canonical_content_hash,
           source_row.payload AS source_payload,
           canonical_row.payload AS canonical_payload
    FROM source_projection AS source_row
    FULL OUTER JOIN canonical_projection AS canonical_row
        ON canonical_row.target_key_hash = source_row.target_key_hash
), mismatch_fields AS (
    SELECT 'record_count'::TEXT AS field
    FROM source_summary, canonical_summary
    WHERE source_summary.source_count <> canonical_summary.canonical_count
    UNION
    SELECT 'duplicate_key'::TEXT
    FROM canonical_duplicate_keys
    UNION
    SELECT 'missing_record'::TEXT
    FROM comparisons
    WHERE comparisons.source_key IS NULL OR comparisons.canonical_key IS NULL
    UNION
    SELECT 'kind'::TEXT
    FROM comparisons
    WHERE comparisons.canonical_key IS NOT NULL
      AND comparisons.canonical_kind IS DISTINCT FROM 'purge'
    UNION
    SELECT 'state'::TEXT
    FROM comparisons
    WHERE comparisons.source_key IS NOT NULL
      AND comparisons.canonical_key IS NOT NULL
      AND comparisons.source_state IS DISTINCT FROM comparisons.canonical_state
    UNION
    SELECT 'content_hash'::TEXT
    FROM comparisons
    WHERE comparisons.source_key IS NOT NULL
      AND comparisons.canonical_key IS NOT NULL
      AND comparisons.source_content_hash IS DISTINCT FROM comparisons.canonical_content_hash
    UNION
    SELECT 'payload'::TEXT
    FROM comparisons
    WHERE comparisons.source_key IS NOT NULL
      AND comparisons.canonical_key IS NOT NULL
      AND comparisons.source_payload IS DISTINCT FROM comparisons.canonical_payload
)
SELECT pg_catalog.jsonb_build_object(
    'schema_version', 'supabase-22-account-deletion-parity-v1',
    'status', CASE
        WHEN EXISTS (SELECT 1 FROM mismatch_fields) THEN 'mismatch'
        ELSE 'match'
    END,
    'source_count', source_summary.source_count,
    'canonical_count', canonical_summary.canonical_count,
    'source_checksum', source_summary.source_checksum,
    'canonical_checksum', canonical_summary.canonical_checksum,
    'mismatch_fields', COALESCE(
        (
            SELECT pg_catalog.jsonb_agg(field ORDER BY field)
            FROM mismatch_fields
        ),
        '[]'::JSONB
    )
)
FROM source_summary, canonical_summary;
$$;

REVOKE EXECUTE ON FUNCTION public.backfill_account_deletion_jobs_v1(INTEGER, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_account_deletion_jobs_v1(INTEGER, TEXT)
    TO service_role;
REVOKE EXECUTE ON FUNCTION public.collect_account_deletion_parity_v1()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_account_deletion_parity_v1()
    TO service_role;
