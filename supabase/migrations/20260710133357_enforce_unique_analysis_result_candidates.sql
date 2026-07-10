-- Finalization can be retried after a process interruption. Preserve the newest result for each
-- request/candidate pair, move any legacy child rows to it, and make later writes idempotent.
CREATE TEMP TABLE duplicate_analysis_result_map ON COMMIT DROP AS
SELECT id AS duplicate_id, keep_id
FROM (
    SELECT
        id,
        FIRST_VALUE(id) OVER (
            PARTITION BY request_id, suspect_instagram_id
            ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS keep_id,
        ROW_NUMBER() OVER (
            PARTITION BY request_id, suspect_instagram_id
            ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS duplicate_rank
    FROM analysis_results
) ranked
WHERE duplicate_rank > 1;

UPDATE comment_details
SET result_id = duplicate_analysis_result_map.keep_id
FROM duplicate_analysis_result_map
WHERE comment_details.result_id = duplicate_analysis_result_map.duplicate_id;

UPDATE interaction_logs
SET result_id = duplicate_analysis_result_map.keep_id
FROM duplicate_analysis_result_map
WHERE interaction_logs.result_id = duplicate_analysis_result_map.duplicate_id;

DELETE FROM analysis_results
USING duplicate_analysis_result_map
WHERE analysis_results.id = duplicate_analysis_result_map.duplicate_id;

CREATE UNIQUE INDEX analysis_results_request_suspect_unique
    ON analysis_results(request_id, suspect_instagram_id);
