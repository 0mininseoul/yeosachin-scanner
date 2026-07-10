-- The collect step is resumable, so private-account persistence must be idempotent as well.
DELETE FROM private_accounts
USING (
    SELECT id
    FROM (
        SELECT
            id,
            ROW_NUMBER() OVER (
                PARTITION BY request_id, instagram_id
                ORDER BY created_at DESC NULLS LAST, id DESC
            ) AS duplicate_rank
        FROM private_accounts
    ) ranked
    WHERE duplicate_rank > 1
) duplicates
WHERE private_accounts.id = duplicates.id;

CREATE UNIQUE INDEX private_accounts_request_instagram_unique
    ON private_accounts(request_id, instagram_id);
