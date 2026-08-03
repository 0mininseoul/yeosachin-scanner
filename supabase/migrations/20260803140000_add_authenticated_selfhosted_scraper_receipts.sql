-- Authenticated self-hosted collection is deliberately not a paid-provider run.
-- Keep its bounded public-result cache in a separate, claim-fenced ledger so it
-- cannot participate in paid-run accounting or recovery/adoption.
CREATE TABLE public.analysis_v2_selfhosted_auth_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(87) NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    job_claim_token UUID NOT NULL,
    run_id VARCHAR(32) NOT NULL,
    account_slot VARCHAR(16) NOT NULL,
    items JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    UNIQUE (run_id),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_selfhosted_auth_runs_job_key_check CHECK (
        job_key IN (
            'track:relationships:collect',
            'track:target-evidence:collect',
            'track:reverse-likes:collect'
        )
    ),
    CONSTRAINT analysis_v2_selfhosted_auth_runs_operation_key_check CHECK (
        operation_key ~ '^(relationship-(followers|following)|target-(likers|comments)|candidate-likers):[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_selfhosted_auth_runs_input_hash_check CHECK (
        input_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_selfhosted_auth_runs_run_id_check CHECK (
        run_id ~ '^[0-9a-f]{32}$'
    ),
    CONSTRAINT analysis_v2_selfhosted_auth_runs_account_slot_check CHECK (
        account_slot = 'primary'
    ),
    CONSTRAINT analysis_v2_selfhosted_auth_runs_items_check CHECK (
        pg_catalog.jsonb_typeof(items) = 'array'
        AND pg_catalog.jsonb_array_length(items) <= 1500
        AND pg_catalog.octet_length(items::TEXT) <= 4194304
    )
);

COMMENT ON TABLE public.analysis_v2_selfhosted_auth_runs IS
    'RPC-only authenticated self-hosted scraper receipts and bounded public-result cache. This is not a paid-provider ledger.';

ALTER TABLE public.analysis_v2_selfhosted_auth_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_selfhosted_auth_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_selfhosted_auth_runs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_selfhosted_auth_run_json(
    p_receipt public.analysis_v2_selfhosted_auth_runs
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'provider', 'selfhosted_auth',
        'operationKey', p_receipt.operation_key,
        'inputHash', p_receipt.input_hash,
        'runId', p_receipt.run_id,
        'accountSlot', p_receipt.account_slot,
        'items', p_receipt.items
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_selfhosted_auth_run_json(
    public.analysis_v2_selfhosted_auth_runs
) FROM PUBLIC, anon, authenticated, service_role;

-- The optional, best-effort scraper telemetry hook persists every configured
-- scraper provider. It is observational only, so allow this distinct provider
-- here without changing any paid-run ledger constraints.
ALTER TABLE public.scraper_provider_usage
    DROP CONSTRAINT scraper_provider_usage_provider_check,
    ADD CONSTRAINT scraper_provider_usage_provider_check CHECK (
        provider IN ('apify', 'coderx', 'flashapi', 'rapidapi', 'selfhosted', 'selfhosted_auth')
    );

CREATE FUNCTION public.checkpoint_analysis_v2_selfhosted_auth_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_run_id TEXT,
    p_account_slot TEXT,
    p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_receipt public.analysis_v2_selfhosted_auth_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_job_key IS NULL
       OR p_job_input_hash IS NULL
       OR p_operation_key IS NULL
       OR p_input_hash IS NULL
       OR p_run_id IS NULL
       OR p_account_slot IS NULL
       OR p_items IS NULL
       OR p_job_key NOT IN (
            'track:relationships:collect',
            'track:target-evidence:collect',
            'track:reverse-likes:collect'
       )
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_run_id !~ '^[0-9a-f]{32}$'
       OR p_account_slot <> 'primary'
       OR pg_catalog.jsonb_typeof(p_items) <> 'array'
       OR pg_catalog.jsonb_array_length(p_items) > (CASE
            WHEN p_operation_key ~ '^relationship-' THEN 1200
            WHEN p_operation_key ~ '^target-comments:' THEN 150
            ELSE 1500
       END)
       OR pg_catalog.octet_length(p_items::TEXT) > 4194304
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_items) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
       )
       OR p_operation_key !~ '^(relationship-(followers|following)|target-(likers|comments)|candidate-likers):[0-9a-f]{64}$'
       OR (
            p_job_key = 'track:relationships:collect'
            AND p_operation_key !~ '^relationship-(followers|following):[0-9a-f]{64}$'
       )
       OR (
            p_job_key = 'track:target-evidence:collect'
            AND p_operation_key !~ '^target-(likers|comments):[0-9a-f]{64}$'
       )
       OR (
            p_job_key = 'track:reverse-likes:collect'
            AND p_operation_key !~ '^candidate-likers:[0-9a-f]{64}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp()
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT receipt.* INTO v_receipt
    FROM public.analysis_v2_selfhosted_auth_runs AS receipt
    WHERE receipt.request_id = p_request_id
      AND receipt.job_key = p_job_key
      AND receipt.operation_key = p_operation_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_receipt.input_hash IS DISTINCT FROM p_input_hash
           OR v_receipt.run_id IS DISTINCT FROM p_run_id
           OR v_receipt.account_slot IS DISTINCT FROM p_account_slot
           OR v_receipt.items IS DISTINCT FROM p_items THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_CONFLICT', ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_selfhosted_auth_runs AS receipt
        SET job_claim_token = p_claim_token,
            updated_at = pg_catalog.clock_timestamp()
        WHERE receipt.request_id = p_request_id
          AND receipt.job_key = p_job_key
          AND receipt.operation_key = p_operation_key
        RETURNING receipt.* INTO v_receipt;
    ELSE
        INSERT INTO public.analysis_v2_selfhosted_auth_runs (
            request_id, job_key, operation_key, input_hash, job_claim_token, run_id, account_slot,
            items
        ) VALUES (
            p_request_id, p_job_key, p_operation_key, p_input_hash,
            p_claim_token, p_run_id, p_account_slot, p_items
        ) ON CONFLICT DO NOTHING
        RETURNING * INTO v_receipt;

        -- A retry with the same claim may race between the initial SELECT and
        -- INSERT. Treat the winner's identical receipt as an idempotent replay;
        -- a run_id collision on a different operation remains a hard conflict.
        IF NOT FOUND THEN
            SELECT receipt.* INTO v_receipt
            FROM public.analysis_v2_selfhosted_auth_runs AS receipt
            WHERE receipt.request_id = p_request_id
              AND receipt.job_key = p_job_key
              AND receipt.operation_key = p_operation_key
            FOR UPDATE;
            IF NOT FOUND
               OR v_receipt.input_hash IS DISTINCT FROM p_input_hash
               OR v_receipt.run_id IS DISTINCT FROM p_run_id
               OR v_receipt.account_slot IS DISTINCT FROM p_account_slot
               OR v_receipt.items IS DISTINCT FROM p_items THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_CONFLICT', ERRCODE = 'P0001';
            END IF;
            UPDATE public.analysis_v2_selfhosted_auth_runs AS receipt
            SET job_claim_token = p_claim_token,
                updated_at = pg_catalog.clock_timestamp()
            WHERE receipt.request_id = p_request_id
              AND receipt.job_key = p_job_key
              AND receipt.operation_key = p_operation_key
            RETURNING receipt.* INTO v_receipt;
        END IF;
    END IF;

    RETURN public.analysis_v2_selfhosted_auth_run_json(v_receipt);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_selfhosted_auth_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_selfhosted_auth_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

CREATE FUNCTION public.load_analysis_v2_selfhosted_auth_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT,
    p_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_receipt public.analysis_v2_selfhosted_auth_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_job_key IS NULL
       OR p_job_input_hash IS NULL
       OR p_operation_key IS NULL
       OR p_input_hash IS NULL
       OR p_job_key NOT IN (
            'track:relationships:collect',
            'track:target-evidence:collect',
            'track:reverse-likes:collect'
       )
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_operation_key !~ '^(relationship-(followers|following)|target-(likers|comments)|candidate-likers):[0-9a-f]{64}$'
       OR (
            p_job_key = 'track:relationships:collect'
            AND p_operation_key !~ '^relationship-(followers|following):[0-9a-f]{64}$'
       )
       OR (
            p_job_key = 'track:target-evidence:collect'
            AND p_operation_key !~ '^target-(likers|comments):[0-9a-f]{64}$'
       )
       OR (
            p_job_key = 'track:reverse-likes:collect'
            AND p_operation_key !~ '^candidate-likers:[0-9a-f]{64}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp()
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT receipt.* INTO v_receipt
    FROM public.analysis_v2_selfhosted_auth_runs AS receipt
    WHERE receipt.request_id = p_request_id
      AND receipt.job_key = p_job_key
      AND receipt.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_receipt.input_hash IS DISTINCT FROM p_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_RUN_CONFLICT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_selfhosted_auth_runs AS receipt
    SET job_claim_token = p_claim_token,
        updated_at = pg_catalog.clock_timestamp()
    WHERE receipt.request_id = p_request_id
      AND receipt.job_key = p_job_key
      AND receipt.operation_key = p_operation_key
    RETURNING receipt.* INTO v_receipt;
    RETURN public.analysis_v2_selfhosted_auth_run_json(v_receipt);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_selfhosted_auth_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_selfhosted_auth_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT
) TO service_role;

CREATE FUNCTION public.analysis_v2_valid_selfhosted_auth_evidence_source(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_provider TEXT,
    p_run_id TEXT,
    p_account_slot TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p_provider = 'selfhosted_auth'
       AND p_account_slot = 'primary'
       AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_selfhosted_auth_runs AS receipt
            JOIN public.analysis_pipeline_jobs AS job
              ON job.request_id = receipt.request_id AND job.job_key = receipt.job_key
            WHERE receipt.request_id = p_request_id
              AND receipt.job_key = p_job_key
              AND receipt.operation_key = p_operation_key
              AND receipt.input_hash = p_input_hash
              AND receipt.job_claim_token = p_claim_token
              AND receipt.run_id = p_run_id
              AND receipt.account_slot = p_account_slot
              AND job.status = 'processing'
              AND job.lease_token = p_claim_token
              AND job.lease_expires_at > pg_catalog.clock_timestamp()
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_selfhosted_auth_evidence_source(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_load_selfhosted_auth_evidence_source(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_provider TEXT,
    p_run_id TEXT,
    p_account_slot TEXT
)
RETURNS public.analysis_v2_selfhosted_auth_runs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_receipt public.analysis_v2_selfhosted_auth_runs%ROWTYPE;
BEGIN
    IF NOT public.analysis_v2_valid_selfhosted_auth_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_operation_key,
        p_input_hash, p_provider, p_run_id, p_account_slot
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_EVIDENCE_SOURCE_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT receipt.* INTO STRICT v_receipt
    FROM public.analysis_v2_selfhosted_auth_runs AS receipt
    WHERE receipt.request_id = p_request_id
      AND receipt.job_key = p_job_key
      AND receipt.operation_key = p_operation_key
      AND receipt.job_claim_token = p_claim_token
      AND receipt.input_hash = p_input_hash
      AND receipt.run_id = p_run_id
      AND receipt.account_slot = p_account_slot
    FOR UPDATE;
    RETURN v_receipt;
EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SELFHOSTED_AUTH_EVIDENCE_SOURCE_INVALID', ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_load_selfhosted_auth_evidence_source(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the paid target-source validator as-is, then admit only the exact
-- authenticated receipt shape. The original validator continues to own all
-- Apify/CoderX validation behavior.
ALTER FUNCTION public.analysis_v2_valid_target_evidence_source(TEXT, JSONB)
    RENAME TO analysis_v2_valid_paid_target_evidence_source;

CREATE FUNCTION public.analysis_v2_valid_target_evidence_source(
    p_signal TEXT,
    p_source JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT public.analysis_v2_valid_paid_target_evidence_source(p_signal, p_source)
       OR (
            p_source->>'provider' = 'selfhosted_auth'
            AND p_source->>'provider_credential_slot' = 'primary'
            AND public.analysis_v2_valid_paid_target_evidence_source(
                p_signal,
                pg_catalog.jsonb_set(p_source, '{provider}', '"apify"'::JSONB)
            )
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_paid_target_evidence_source(TEXT, JSONB),
    public.analysis_v2_valid_target_evidence_source(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_target_evidence_manifests
    DROP CONSTRAINT analysis_v2_target_evidence_manifest_source_check,
    ADD CONSTRAINT analysis_v2_target_evidence_manifest_source_check CHECK (
        public.analysis_v2_valid_target_evidence_source('target_post_like', liker_source)
        AND public.analysis_v2_valid_target_evidence_source('target_post_comment', comment_source)
    );

ALTER TABLE public.analysis_v2_relationship_sides
    DROP CONSTRAINT analysis_v2_relationship_sides_provider_check,
    ADD CONSTRAINT analysis_v2_relationship_sides_provider_check CHECK (
        provider IN ('apify', 'coderx', 'selfhosted_auth')
    );

-- The final writers already call the paid adoption-aware loader. Insert a
-- separate branch for selfhosted_auth receipts and leave that paid branch intact.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
    v_before TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_relationship_side(uuid,text,uuid,text,text,integer,text,text,text,text,text,jsonb)'::pg_catalog.regprocedure
    );
    v_rewritten := pg_catalog.replace(
        v_definition,
        $old$OR p_provider NOT IN ('apify', 'coderx')$old$,
        $new$OR p_provider NOT IN ('apify', 'coderx', 'selfhosted_auth')$new$
    );
    IF v_rewritten = v_definition THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_RELATIONSHIP_VALIDATOR_PATCH_MISMATCH';
    END IF;
    IF pg_catalog.strpos(
        v_rewritten, 'v_provider_run public.analysis_v2_provider_runs%ROWTYPE;'
    ) = 0 THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_RELATIONSHIP_DECLARATION_PATCH_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(
        v_rewritten,
        $old$v_provider_run public.analysis_v2_provider_runs%ROWTYPE;$old$,
        $new$v_provider_run public.analysis_v2_provider_runs%ROWTYPE;
    v_provider_credential_slot TEXT;$new$
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten,
        'v_provider_run.credential_slot',
        'v_provider_credential_slot'
    );
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
    SELECT source.* INTO STRICT v_provider_run
    FROM public.analysis_v2_load_provider_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
        p_input_hash, p_provider, p_provider_run_id, NULL
    ) AS source;$old$, $new$
    IF p_provider = 'selfhosted_auth' THEN
        SELECT source.account_slot INTO STRICT v_provider_credential_slot
        FROM public.analysis_v2_load_selfhosted_auth_evidence_source(
            p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
            p_input_hash, p_provider, p_provider_run_id, 'primary'
        ) AS source;
    ELSE
        SELECT source.* INTO STRICT v_provider_run
        FROM public.analysis_v2_load_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
            p_input_hash, p_provider, p_provider_run_id, NULL
        ) AS source;
        v_provider_credential_slot := v_provider_run.credential_slot;
    END IF;$new$);
    IF pg_catalog.strpos(
        v_rewritten, 'analysis_v2_load_selfhosted_auth_evidence_source'
    ) = 0 THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_RELATIONSHIP_LOADER_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;

    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_target_evidence(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure
    );
    v_rewritten := pg_catalog.replace(v_definition, $old$
        SELECT source.* INTO STRICT v_liker_provider_run
        FROM public.analysis_v2_load_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_liker_source->>'provider_operation_key',
            p_liker_source->>'input_hash', p_liker_source->>'provider',
            p_liker_source->>'provider_run_id',
            p_liker_source->>'provider_credential_slot'
        ) AS source;$old$, $new$
        IF p_liker_source->>'provider' = 'selfhosted_auth' THEN
            PERFORM source.operation_key
            FROM public.analysis_v2_load_selfhosted_auth_evidence_source(
                p_request_id, p_job_key, p_claim_token,
                p_liker_source->>'provider_operation_key',
                p_liker_source->>'input_hash', p_liker_source->>'provider',
                p_liker_source->>'provider_run_id',
                p_liker_source->>'provider_credential_slot'
            ) AS source;
        ELSE
            SELECT source.* INTO STRICT v_liker_provider_run
            FROM public.analysis_v2_load_provider_evidence_source(
                p_request_id, p_job_key, p_claim_token,
                p_liker_source->>'provider_operation_key',
                p_liker_source->>'input_hash', p_liker_source->>'provider',
                p_liker_source->>'provider_run_id',
                p_liker_source->>'provider_credential_slot'
            ) AS source;
        END IF;$new$);
    IF v_rewritten = v_definition THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_TARGET_LOADER_PATCH_MISMATCH';
    END IF;
    v_before := v_rewritten;
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
        SELECT source.* INTO STRICT v_comment_provider_run
        FROM public.analysis_v2_load_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_comment_source->>'provider_operation_key',
            p_comment_source->>'input_hash', p_comment_source->>'provider',
            p_comment_source->>'provider_run_id',
            p_comment_source->>'provider_credential_slot'
        ) AS source;$old$, $new$
        IF p_comment_source->>'provider' = 'selfhosted_auth' THEN
            PERFORM source.operation_key
            FROM public.analysis_v2_load_selfhosted_auth_evidence_source(
                p_request_id, p_job_key, p_claim_token,
                p_comment_source->>'provider_operation_key',
                p_comment_source->>'input_hash', p_comment_source->>'provider',
                p_comment_source->>'provider_run_id',
                p_comment_source->>'provider_credential_slot'
            ) AS source;
        ELSE
            SELECT source.* INTO STRICT v_comment_provider_run
            FROM public.analysis_v2_load_provider_evidence_source(
                p_request_id, p_job_key, p_claim_token,
                p_comment_source->>'provider_operation_key',
                p_comment_source->>'input_hash', p_comment_source->>'provider',
                p_comment_source->>'provider_run_id',
                p_comment_source->>'provider_credential_slot'
            ) AS source;
        END IF;$new$);
    IF v_rewritten = v_before THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_TARGET_LOADER_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_relationship_side(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
), public.checkpoint_analysis_v2_target_evidence(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_relationship_side(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
), public.checkpoint_analysis_v2_target_evidence(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) TO service_role;
