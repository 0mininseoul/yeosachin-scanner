ALTER TABLE private_accounts
    ADD COLUMN IF NOT EXISTS name_female_score REAL
        CHECK (name_female_score IS NULL OR name_female_score BETWEEN 0 AND 1),
    ADD COLUMN IF NOT EXISTS name_is_name BOOLEAN,
    ADD COLUMN IF NOT EXISTS name_confidence REAL
        CHECK (name_confidence IS NULL OR name_confidence BETWEEN 0 AND 1);

CREATE INDEX IF NOT EXISTS idx_private_accounts_name_sort
    ON private_accounts(
        request_id,
        name_female_score DESC NULLS LAST,
        name_confidence DESC NULLS LAST,
        instagram_id ASC
    );

COMMENT ON COLUMN private_accounts.name_female_score IS
    'Probabilistic female-name score from username/full_name text only; not a verified gender.';
COMMENT ON COLUMN private_accounts.name_is_name IS
    'Whether username/full_name appears to contain a personal name.';
COMMENT ON COLUMN private_accounts.name_confidence IS
    'Confidence in the text-only name-shape classification.';
