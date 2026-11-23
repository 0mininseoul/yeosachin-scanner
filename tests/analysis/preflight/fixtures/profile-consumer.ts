import { readFileSync } from 'node:fs';

function migration(name: string): string {
    return readFileSync(new URL(`../../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
}

function definition(source: string, name: string): string {
    const start = source.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`));
    const end = source.indexOf('\n$$;', start);
    if (start < 0 || end < 0) {
        throw new Error(`Missing fixture function ${name}`);
    }
    return source.slice(start, end + '\n$$;'.length);
}

const freshness = migration('20260811090000_harden_fresh_provenance');
const scheduler = migration('20260727034000_add_analysis_v2_scheduler_live_operations');

export const originalProfileConsumerSql = migration('20260829110000_admit_bounded_direct_fresh_apify_consumer');
export const profileConsumerReadSql = migration('20261123160000_read_profile_consumer_without_request_lock');

export const profileConsumerFixtureSql = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL,
    preflight_id UUID,
    plan_access_mode_snapshot TEXT NOT NULL DEFAULT 'production',
    selected_plan_id_snapshot TEXT NOT NULL DEFAULT 'standard',
    user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    consumed_request_id UUID,
    target_instagram_id TEXT,
    access_mode TEXT,
    status TEXT,
    target_input_hash TEXT,
    admission_refreshed_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    input_hash TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    track TEXT,
    kind TEXT,
    batch INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    dispatch_state TEXT NOT NULL DEFAULT 'delivered',
    dispatch_generation INTEGER NOT NULL DEFAULT 1,
    dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    dispatch_task_name TEXT,
    delivered_at TIMESTAMPTZ,
    first_started_at TIMESTAMPTZ,
    ai_capacity_deferral_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error_at TIMESTAMPTZ,
    scheduler_not_before_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_candidate_feature_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_preliminary_score_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_reverse_like_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_partner_safety_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_candidate_score_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_private_name_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_narrative_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);

CREATE TABLE public.analysis_v2_profile_fetch_batches (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    requested_usernames TEXT[] NOT NULL,
    frozen_unresolved_usernames TEXT[] NOT NULL,
    primary_payload_hash TEXT NOT NULL,
    primary_completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fallback_payload_hash TEXT,
    fallback_completed_at TIMESTAMPTZ,
    repair_usernames TEXT[],
    repair_payload_hash TEXT,
    repair_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT batches_fallback_pair_check CHECK (
        (fallback_payload_hash IS NULL AND fallback_completed_at IS NULL)
        OR (fallback_payload_hash IS NOT NULL AND fallback_completed_at IS NOT NULL)
    ),
    CONSTRAINT batches_repair_pair_check CHECK (
        (repair_usernames IS NULL AND repair_payload_hash IS NULL AND repair_completed_at IS NULL)
        OR (repair_usernames IS NOT NULL AND repair_payload_hash IS NOT NULL AND repair_completed_at IS NOT NULL)
    )
);
CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    attempt TEXT NOT NULL,
    ordinal SMALLINT NOT NULL,
    username VARCHAR(30) NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_category TEXT,
    http_status SMALLINT,
    request_count SMALLINT NOT NULL DEFAULT 1,
    latency_ms INTEGER NOT NULL DEFAULT 100,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    profile_snapshot JSONB,
    PRIMARY KEY (request_id, job_key, attempt, username),
    UNIQUE (request_id, job_key, attempt, ordinal),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_v2_profile_fetch_batches(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT outcomes_ordinal_check CHECK (ordinal BETWEEN 1 AND 30),
    CONSTRAINT outcomes_attempt_check CHECK (
        attempt IN ('primary', 'fallback', 'repair', 'fresh_apify')
    ),
    CONSTRAINT outcomes_source_check CHECK (
        (attempt = 'primary' AND source IN ('cache', 'selfhosted'))
        OR (attempt IN ('fallback', 'repair', 'fresh_apify') AND source = 'apify')
    ),
    CONSTRAINT outcomes_status_check CHECK (status IN ('success', 'unavailable', 'failed')),
    CONSTRAINT outcomes_result_check CHECK (
        (status = 'success' AND failure_category IS NULL AND profile_snapshot IS NOT NULL)
        OR (status = 'unavailable' AND failure_category IN ('not_found', 'empty_user')
            AND profile_snapshot IS NULL)
        OR (status = 'failed' AND failure_category IN (
                'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                'transport', 'http', 'unknown'
            ) AND profile_snapshot IS NULL)
    )
);

CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id UUID PRIMARY KEY, mode TEXT, policy_version TEXT
);
CREATE TABLE public.analysis_revenue_run_ledgers (
    request_id UUID PRIMARY KEY, status TEXT, preflight_id UUID, user_id UUID,
    plan_id TEXT, access_mode TEXT, target_username_hmac TEXT,
    preflight_refreshed_at TIMESTAMPTZ, request_started_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_revenue_dispatch_guards (
    request_id UUID PRIMARY KEY, state TEXT, reason_code TEXT
);

${definition(
    migration('20260713213000_harden_analysis_v2_result_runtime_boundary'),
    'analysis_v2_assert_result_job_fence',
)}
${definition(freshness, 'analysis_v2_profile_checkpoint_snapshot')}
${definition(freshness, 'assert_analysis_revenue_dispatch_guard_v1')}
${definition(scheduler, 'continue_analysis_v2_scheduler_job').replace(
    'continue_analysis_v2_scheduler_job(',
    'continue_analysis_v2_scheduler_job_unfenced_20260811(',
)}
${definition(freshness, 'continue_analysis_v2_scheduler_job')}
`;
