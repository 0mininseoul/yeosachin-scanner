import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

function readMigration(fileName: string): string {
    return readFileSync(
        new URL(`../../../supabase/migrations/${fileName}`, import.meta.url),
        'utf8'
    );
}

/**
 * Slices a real migration file so the pglite bootstrap runs the same DDL text that
 * production ran, without pulling in the parts of the file that depend on tables this
 * suite does not model. Slicing (rather than hand-writing a stub) is load bearing: the
 * telemetry CHECK and its trigger must be the real ones or the repair-telemetry test
 * passes vacuously.
 */
function sliceThrough(source: string, marker: string): string {
    const index = source.indexOf(marker);
    if (index < 0) {
        throw new Error(`migration slice marker not found: ${marker}`);
    }
    return source.slice(0, index + marker.length);
}

function sliceLines(source: string, firstLine: number, lastLine: number): string {
    const lines = source.split('\n');
    if (lines.length < lastLine) {
        throw new Error(`migration has ${lines.length} lines, needed ${lastLine}`);
    }
    return lines.slice(firstLine - 1, lastLine).join('\n');
}

const checkpointMigration = readMigration(
    '20260713164030_add_analysis_v2_profile_fetch_checkpoints.sql'
);

// Real telemetry table (with its inline source CHECK), the real capture trigger function,
// the real backfill, and the real trigger binding — everything up to and including the
// `analysis_v2_profile_fetch_telemetry_capture` trigger.
const telemetryMigration = sliceThrough(
    readMigration('20260714033000_add_analysis_v2_operational_observability.sql'),
    'FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry();'
);

// The 546-line finalizer body as it lives in production: created under the pre-rename name
// by 20260713185711 and renamed by 20260713213000:230. No migration has replaced it since.
const internalFinalizerSource = sliceLines(
    readMigration('20260713185711_add_analysis_v2_result_finalization.sql'),
    2651,
    3197
).replace(
    'CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge(',
    'CREATE OR REPLACE FUNCTION public.analysis_v2_complete_result_and_purge_internal('
);

const aiUnavailableMigration = readMigration(
    '20260716162523_harden_analysis_v2_ai_unavailable_replay_policy.sql'
);
const repairMigration = readMigration(
    '20260720130000_add_analysis_v2_profile_repair_attempt.sql'
);
const terminalOutcomeMigration = readMigration(
    '20260720140000_read_analysis_v2_profile_repair_terminal_outcome.sql'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PREFLIGHT_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '33333333-3333-4333-8333-333333333333';
const PROFILE_JOB_KEY = 'track:profiles:batch:0';
const FINALIZE_JOB_KEY = 'coordinator:finalize';
const INPUT_HASH = 'a'.repeat(64);
const TARGET = 'target.account';
const CANDIDATE = 'repaired.one';
const CANDIDATE_ID = `candidate:${CANDIDATE}`;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    pipeline_version TEXT,
    target_instagram_id TEXT,
    excluded_instagram_id TEXT,
    analysis_scope_snapshot JSONB,
    selected_plan_id_snapshot TEXT,
    policy_versions_snapshot JSONB,
    exclusion_decision_snapshot TEXT,
    progress INTEGER,
    background_processing BOOLEAN,
    progress_step TEXT,
    current_step TEXT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT pg_catalog.clock_timestamp(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    consumed_request_id UUID UNIQUE REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    target_followers_count INTEGER,
    target_following_count INTEGER
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL,
    track TEXT,
    kind TEXT,
    batch INTEGER,
    status TEXT NOT NULL DEFAULT 'processing',
    input_hash VARCHAR(64) NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    completion_token UUID,
    completion_fanout_hash TEXT,
    required_job_keys TEXT[] NOT NULL DEFAULT '{}',
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE TABLE public.analysis_v2_provider_runs (request_id UUID, status TEXT);

CREATE TABLE public.analysis_v2_relationship_manifests (
    request_id UUID,
    job_key TEXT,
    result_hash TEXT,
    followers_result_hash TEXT,
    following_result_hash TEXT,
    excluded_username TEXT,
    detailed_mutual_limit INTEGER,
    detailed_public_count INTEGER,
    public_count INTEGER,
    private_count INTEGER,
    mutual_count INTEGER,
    exclusion_decision_hash TEXT
);
CREATE TABLE public.analysis_v2_relationship_sides (
    request_id UUID,
    job_key TEXT,
    side TEXT,
    declared_count INTEGER,
    collected_count INTEGER,
    result_hash TEXT
);
CREATE TABLE public.analysis_v2_dag_scopes (
    request_id UUID,
    plan_id TEXT,
    excluded_count INTEGER,
    exclusion_decision_hash TEXT
);
CREATE TABLE public.analysis_v2_dag_stage_manifests (
    request_id UUID,
    stage_kind TEXT,
    result_hash TEXT,
    producer_input_hash TEXT,
    detected_mutual_count INTEGER,
    public_count INTEGER,
    private_count INTEGER,
    detailed_selected_public_count INTEGER,
    interactor_count INTEGER,
    verified_female_count INTEGER,
    shortlist_count INTEGER,
    featured_high_risk_count INTEGER,
    narrative_count INTEGER
);
CREATE TABLE public.analysis_v2_target_evidence_manifests (
    request_id UUID,
    job_key TEXT,
    result_hash TEXT,
    interactor_count INTEGER,
    target_username TEXT,
    excluded_username TEXT
);
CREATE TABLE public.analysis_v2_dag_batch_topology (
    request_id UUID,
    topology_kind TEXT,
    batch INTEGER,
    item_count INTEGER
);
CREATE TABLE public.analysis_v2_dag_batch_results (
    request_id UUID,
    result_kind TEXT,
    batch INTEGER,
    item_count INTEGER,
    producer_input_hash TEXT,
    result_hash TEXT
);
CREATE TABLE public.analysis_v2_candidate_feature_manifests (
    request_id UUID,
    batch INTEGER,
    item_count INTEGER,
    row_count INTEGER,
    producer_input_hash TEXT
);
CREATE TABLE public.analysis_v2_private_name_manifests (
    request_id UUID,
    batch INTEGER,
    item_count INTEGER,
    producer_input_hash TEXT,
    result_hash TEXT
);
CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
    request_id UUID,
    stage_kind TEXT,
    batch_key INTEGER,
    producer_input_hash TEXT,
    result_hash TEXT,
    item_count INTEGER,
    payload JSONB
);
CREATE TABLE public.analysis_v2_mutual_rows (
    request_id UUID,
    job_key TEXT,
    username TEXT,
    is_private BOOLEAN,
    detailed_ordinal INTEGER
);
CREATE TABLE public.analysis_v2_candidate_feature_rows (
    request_id UUID,
    batch INTEGER,
    candidate_id TEXT,
    instagram_id TEXT,
    terminal_classification TEXT,
    full_name TEXT,
    profile_image_url TEXT,
    bio TEXT,
    one_line_overview TEXT
);
CREATE TABLE public.analysis_v2_private_name_rows (
    request_id UUID,
    candidate_id TEXT,
    instagram_id TEXT,
    full_name TEXT,
    profile_image_url TEXT,
    name_female_score INTEGER,
    name_confidence INTEGER
);
CREATE TABLE public.analysis_v2_preliminary_score_manifests (
    request_id UUID,
    producer_input_hash TEXT,
    item_count INTEGER
);
CREATE TABLE public.analysis_v2_preliminary_score_rows (
    request_id UUID,
    candidate_id TEXT,
    verification_shortlist_rank INTEGER
);
CREATE TABLE public.analysis_v2_reverse_like_manifests (
    request_id UUID,
    producer_input_hash TEXT
);
CREATE TABLE public.analysis_v2_partner_safety_manifests (
    request_id UUID,
    producer_input_hash TEXT
);
CREATE TABLE public.analysis_v2_candidate_score_manifests (
    request_id UUID,
    producer_input_hash TEXT,
    item_count INTEGER
);
CREATE TABLE public.analysis_v2_narrative_manifests (
    request_id UUID,
    producer_input_hash TEXT,
    item_count INTEGER
);
CREATE TABLE public.analysis_v2_candidate_score_rows (
    request_id UUID,
    candidate_id TEXT,
    display_score INTEGER,
    risk_band TEXT,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER
);
CREATE TABLE public.analysis_v2_narrative_rows (
    request_id UUID,
    candidate_id TEXT,
    line_one TEXT,
    line_two TEXT
);
CREATE TABLE public.analysis_v2_female_results (
    request_id UUID,
    candidate_id TEXT,
    sort_ordinal SMALLINT,
    instagram_id TEXT,
    full_name TEXT,
    profile_image_url TEXT,
    bio TEXT,
    display_score INTEGER,
    risk_band TEXT,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER,
    analysis_depth TEXT,
    one_line_overview TEXT,
    narrative_line_one TEXT,
    narrative_line_two TEXT
);
CREATE TABLE public.analysis_v2_private_results (
    request_id UUID,
    candidate_id TEXT,
    sort_ordinal SMALLINT,
    instagram_id TEXT,
    full_name TEXT,
    profile_image_url TEXT
);
CREATE TABLE public.analysis_progress_state (
    request_id UUID PRIMARY KEY,
    revision BIGINT,
    status TEXT,
    progress_bp INTEGER,
    background_processing BOOLEAN,
    tracks JSONB,
    active_profile JSONB,
    eta_range JSONB,
    last_event_seq BIGINT,
    snapshot_fingerprint TEXT,
    updated_at TIMESTAMP WITH TIME ZONE
);
CREATE TABLE public.analysis_progress_events (
    request_id UUID,
    seq BIGINT,
    event_key TEXT,
    revision BIGINT,
    snapshot_fingerprint TEXT,
    occurred_at TIMESTAMP WITH TIME ZONE,
    event_state TEXT,
    event_code TEXT,
    copy_code TEXT,
    aggregate_count INTEGER
);

CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY,
    target_instagram_id TEXT NOT NULL,
    target_profile_image_url TEXT,
    plan_id TEXT NOT NULL,
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    exclusion_applied BOOLEAN NOT NULL,
    score_policy_version TEXT NOT NULL,
    finalizer_input_hash TEXT,
    CONSTRAINT analysis_v2_result_summary_count_check CHECK (TRUE)
);
CREATE TABLE public.analysis_v2_result_coverage_telemetry (
    request_id UUID PRIMARY KEY,
    plan_id TEXT NOT NULL,
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    CONSTRAINT analysis_v2_result_coverage_telemetry_counts_check CHECK (TRUE)
);
CREATE OR REPLACE FUNCTION public.capture_analysis_v2_result_coverage_telemetry()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END; $fn$;
CREATE TRIGGER analysis_v2_result_coverage_telemetry_capture
AFTER INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_result_coverage_telemetry();

CREATE TABLE public.analysis_v2_ai_attempts (
    request_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000',
    job_key TEXT NOT NULL DEFAULT 'track:test:batch:0',
    operation_key TEXT NOT NULL DEFAULT 'op',
    attempt SMALLINT NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'privateAccountName',
    PRIMARY KEY (request_id, operation_key, attempt),
    CONSTRAINT analysis_v2_ai_attempt_status_check CHECK (
        status IN ('reserved', 'success', 'rate_limited', 'ambiguous', 'rejected')
    )
);

CREATE OR REPLACE FUNCTION public.analysis_v2_terminalize_ai_attempt_internal(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_operation_key TEXT,
    p_attempt SMALLINT, p_reservation_token UUID, p_status TEXT, p_telemetry JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
BEGIN
    IF p_status NOT IN ('success', 'rate_limited', 'ambiguous', 'rejected') THEN
        RAISE EXCEPTION 'invalid';
    END IF;
    RETURN '{}'::JSONB;
END;
$fn$;
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_private_names(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT,
    p_batch INTEGER, p_source TEXT, p_operation_key TEXT, p_ai_result_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
        WHERE ai_attempt.request_id = p_request_id
          AND ai_attempt.status = 'rejected'
    ) THEN
        RETURN '{}'::JSONB;
    END IF;
    RETURN '{}'::JSONB;
END;
$fn$;
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_narratives(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
        WHERE ai_attempt.request_id = p_request_id
          AND ai_attempt.status = 'rejected'
    ) THEN
        RETURN '{}'::JSONB;
    END IF;
    RETURN '{}'::JSONB;
END;
$fn$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    p_request_id UUID, p_partner_job_key TEXT, p_value JSONB
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $fn$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
        WHERE ai_attempt.request_id = p_request_id
          AND ai_attempt.status = 'rejected'
    );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_operational_observability(UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
AS $fn$ SELECT '{"summary":{"resultCoverage":null}}'::JSONB; $fn$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_image_path(p_path TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $fn$ SELECT TRUE; $fn$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_candidate_id(p_username TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$ SELECT 'candidate:' || p_username; $fn$;
CREATE OR REPLACE FUNCTION public.analysis_v2_dag_hash_json(p_payload JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$ SELECT pg_catalog.md5(p_payload::TEXT); $fn$;
CREATE OR REPLACE FUNCTION public.analysis_v2_scrub_terminal_request_pii(
    p_request_id UUID, p_now TIMESTAMP WITH TIME ZONE
) RETURNS VOID LANGUAGE sql AS $fn$ SELECT NULL::VOID; $fn$;
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(
    p_request_id UUID, p_purge BOOLEAN
) RETURNS VOID LANGUAGE sql AS $fn$ SELECT NULL::VOID; $fn$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_summary_json(
    p_summary public.analysis_v2_result_summaries
) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
    SELECT pg_catalog.jsonb_build_object('requestId', p_summary.request_id);
$fn$;
`;

const resetSql = `
DO $reset$
DECLARE
    v_table RECORD;
BEGIN
    FOR v_table IN
        SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE 'TRUNCATE TABLE public.' || pg_catalog.quote_ident(v_table.tablename)
            || ' CASCADE';
    END LOOP;
END;
$reset$;
`;

interface ProfileSnapshot {
    username: string;
    followersCount: number;
    followingCount: number;
    postsCount: number;
    isPrivate: boolean;
    isVerified: boolean;
}

interface OutcomeSpec {
    username: string;
    source: 'cache' | 'selfhosted' | 'apify';
    status: 'success' | 'unavailable' | 'failed';
    failureCategory?: string;
    httpStatus?: number;
}

interface Outcome {
    username: string;
    source: string;
    status: string;
    failure_category: string | null;
    http_status: number | null;
    request_count: number;
    latency_ms: number;
    captured_at: string;
    profile: ProfileSnapshot | null;
}

function outcome(spec: OutcomeSpec): Outcome {
    return {
        username: spec.username,
        source: spec.source,
        status: spec.status,
        failure_category: spec.failureCategory ?? null,
        http_status: spec.httpStatus ?? null,
        request_count: 1,
        latency_ms: 120,
        captured_at: '2026-07-20T10:00:00.000Z',
        profile: spec.status === 'success'
            ? {
                username: spec.username,
                followersCount: 120,
                followingCount: 80,
                postsCount: 12,
                isPrivate: false,
                isVerified: false,
            }
            : null,
    };
}

let db: PGlite;

async function seedRequest(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, status, pipeline_version, target_instagram_id, excluded_instagram_id,
            analysis_scope_snapshot, selected_plan_id_snapshot, policy_versions_snapshot,
            exclusion_decision_snapshot
         ) VALUES (
            $1, 'processing', 'v2', $2, NULL,
            '{"detailedMutualLimit":10}'::JSONB, 'basic',
            '{"risk":"risk-policy-v2.2"}'::JSONB, 'keep'
         )`,
        [REQUEST_ID, TARGET]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, consumed_request_id, status, target_followers_count, target_following_count
         ) VALUES ($1, $2, 'consumed', 100, 100)`,
        [PREFLIGHT_ID, REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, track, kind, batch, status, input_hash,
            lease_token, lease_expires_at, required_job_keys
         ) VALUES
            ($1, $2, 'track', 'profiles', 0, 'processing', $4, $3,
                pg_catalog.clock_timestamp() + INTERVAL '10 minutes', '{}'),
            ($1, $5, 'coordinator', 'finalizer', NULL, 'processing', $4, $3,
                pg_catalog.clock_timestamp() + INTERVAL '10 minutes', ARRAY[$2])`,
        [REQUEST_ID, PROFILE_JOB_KEY, CLAIM_TOKEN, INPUT_HASH, FINALIZE_JOB_KEY]
    );
}

async function checkpointPrimary(
    requested: readonly string[],
    outcomes: readonly Outcome[]
): Promise<void> {
    await db.query(
        `SELECT public.checkpoint_analysis_v2_profile_primary(
            $1, $2, $3, $4, $5::TEXT[], $6::JSONB
         )`,
        [
            REQUEST_ID,
            PROFILE_JOB_KEY,
            CLAIM_TOKEN,
            INPUT_HASH,
            `{${requested.join(',')}}`,
            JSON.stringify(outcomes),
        ]
    );
}

async function checkpointFallback(outcomes: readonly Outcome[]): Promise<void> {
    await db.query(
        `SELECT public.checkpoint_analysis_v2_profile_fallback($1, $2, $3, $4, $5::JSONB)`,
        [REQUEST_ID, PROFILE_JOB_KEY, CLAIM_TOKEN, INPUT_HASH, JSON.stringify(outcomes)]
    );
}

async function checkpointRepair(outcomes: readonly Outcome[]) {
    return db.query(
        `SELECT public.checkpoint_analysis_v2_profile_repair($1, $2, $3, $4, $5::JSONB)`,
        [REQUEST_ID, PROFILE_JOB_KEY, CLAIM_TOKEN, INPUT_HASH, JSON.stringify(outcomes)]
    );
}

type AttemptStatus = 'success' | 'failed';

/**
 * Drives the real checkpoint RPCs so `CANDIDATE` freezes after a failed primary and then
 * reaches whichever terminal attempt the scenario asks for.
 */
async function seedProfileAttempts(input: {
    fallback: AttemptStatus;
    repair?: AttemptStatus;
}): Promise<void> {
    await checkpointPrimary(
        [CANDIDATE],
        [outcome({
            username: CANDIDATE,
            source: 'selfhosted',
            status: 'failed',
            failureCategory: 'timeout',
        })]
    );
    await checkpointFallback([
        input.fallback === 'success'
            ? outcome({ username: CANDIDATE, source: 'apify', status: 'success' })
            : outcome({
                username: CANDIDATE,
                source: 'apify',
                status: 'failed',
                failureCategory: 'rate_limit',
                httpStatus: 429,
            }),
    ]);
    if (input.repair) {
        await checkpointRepair([
            input.repair === 'success'
                ? outcome({ username: CANDIDATE, source: 'apify', status: 'success' })
                : outcome({
                    username: CANDIDATE,
                    source: 'apify',
                    status: 'failed',
                    failureCategory: 'timeout',
                }),
        ]);
    }
}

async function terminalAttempt(
    username: string,
    frozen: readonly string[]
): Promise<string | null> {
    const result = await db.query<{ attempt: string | null }>(
        `SELECT public.analysis_v2_profile_terminal_attempt($1, $2, $3, $4::TEXT[]) AS attempt`,
        [REQUEST_ID, PROFILE_JOB_KEY, username, `{${frozen.join(',')}}`]
    );
    return result.rows[0]?.attempt ?? null;
}

async function insertFeatureRow(classification: string): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_v2_candidate_feature_rows (
            request_id, batch, candidate_id, instagram_id, terminal_classification,
            full_name, profile_image_url, bio, one_line_overview
         ) VALUES ($1, 0, $2, $3, $4, 'Repaired One', NULL, NULL, 'overview')`,
        [REQUEST_ID, CANDIDATE_ID, CANDIDATE, classification]
    );
}

/** Everything the internal finalizer's readiness gates need besides the profile batch. */
async function seedFinalizerWorkingSet(): Promise<void> {
    await db.query(
        `UPDATE public.analysis_pipeline_jobs
         SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
             completion_token = $2
         WHERE request_id = $1 AND job_key = $3`,
        [REQUEST_ID, CLAIM_TOKEN, PROFILE_JOB_KEY]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_relationship_manifests (
            request_id, job_key, result_hash, followers_result_hash,
            following_result_hash, excluded_username, detailed_mutual_limit,
            detailed_public_count, public_count, private_count, mutual_count,
            exclusion_decision_hash
         ) VALUES (
            $1, 'track:relationships:collect', 'rel-result', 'fw-hash', 'fg-hash',
            NULL, 10, 1, 1, 0, 1, 'excl-hash'
         )`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_relationship_sides (
            request_id, job_key, side, declared_count, collected_count, result_hash
         ) VALUES
            ($1, 'track:relationships:collect', 'followers', 100, 100, 'fw-hash'),
            ($1, 'track:relationships:collect', 'following', 100, 100, 'fg-hash')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_dag_scopes (
            request_id, plan_id, excluded_count, exclusion_decision_hash
         ) VALUES ($1, 'basic', 0, 'excl-hash')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_dag_stage_manifests (
            request_id, stage_kind, result_hash, producer_input_hash,
            detected_mutual_count, public_count, private_count,
            detailed_selected_public_count, interactor_count, verified_female_count,
            shortlist_count, featured_high_risk_count, narrative_count
         ) VALUES
            ($1, 'relationships', 'rel-result', 'rel-in', 1, 1, 0, 1, NULL, NULL, NULL, NULL, NULL),
            ($1, 'target_evidence', 'evi-result', 'evi-in', NULL, NULL, NULL, NULL, 3, NULL, NULL, NULL, NULL),
            ($1, 'primary_join', 'pj-out', 'pj-in', NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL),
            ($1, 'screening', 'sc-out', 'sc-in', NULL, NULL, NULL, NULL, NULL, 1, 1, NULL, NULL),
            ($1, 'reverse_likes', 'rl-out', 'rl-in', NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL),
            ($1, 'partner_safety', 'ps-out', 'ps-in', NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL),
            ($1, 'final_score', 'fs-out', 'fs-in', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0),
            ($1, 'narrative', 'nr-out', 'nr-in', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_target_evidence_manifests (
            request_id, job_key, result_hash, interactor_count, target_username,
            excluded_username
         ) VALUES ($1, 'track:target-evidence:collect', 'evi-result', 3, $2, NULL)`,
        [REQUEST_ID, TARGET]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_dag_batch_topology (
            request_id, topology_kind, batch, item_count
         ) VALUES ($1, 'profile', 0, 1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_dag_batch_results (
            request_id, result_kind, batch, item_count, producer_input_hash, result_hash
         ) VALUES
            ($1, 'profile_fetch', 0, 1, 'pf-in', 'pf-out'),
            ($1, 'profile_ai', 0, 1, 'ai-in', 'ai-out')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_candidate_feature_manifests (
            request_id, batch, item_count, row_count, producer_input_hash
         ) VALUES ($1, 0, 1, 1, 'ai-in')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints (
            request_id, stage_kind, batch_key, producer_input_hash, result_hash,
            item_count, payload
         ) VALUES
            ($1, 'profile_ai_batch', 0, 'ai-in', 'ai-out', 1, '{"outcomes":[]}'::JSONB),
            ($1, 'primary_join', -1, 'pj-in', 'pj-out', 1, '{}'::JSONB),
            ($1, 'screening', -1, 'sc-in', 'sc-out', 1, '{}'::JSONB),
            ($1, 'reverse_likes', -1, 'rl-in', 'rl-out', 1, '{}'::JSONB),
            ($1, 'partner_safety', -1, 'ps-in', 'ps-out', 1, '{}'::JSONB),
            ($1, 'final_score', -1, 'fs-in', 'fs-out', 1, '{}'::JSONB),
            ($1, 'narrative', -1, 'nr-in', 'nr-out', 1, '{}'::JSONB)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_mutual_rows (
            request_id, job_key, username, is_private, detailed_ordinal
         ) VALUES ($1, 'track:relationships:collect', $2, FALSE, 1)`,
        [REQUEST_ID, CANDIDATE]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_preliminary_score_manifests (
            request_id, producer_input_hash, item_count
         ) VALUES ($1, 'sc-in', 1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_preliminary_score_rows (
            request_id, candidate_id, verification_shortlist_rank
         ) VALUES ($1, $2, 1)`,
        [REQUEST_ID, CANDIDATE_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_reverse_like_manifests (
            request_id, producer_input_hash
         ) VALUES ($1, 'rl-in')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_partner_safety_manifests (
            request_id, producer_input_hash
         ) VALUES ($1, 'ps-in')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_candidate_score_manifests (
            request_id, producer_input_hash, item_count
         ) VALUES ($1, 'fs-in', 1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_narrative_manifests (
            request_id, producer_input_hash, item_count
         ) VALUES ($1, 'nr-in', 0)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_candidate_score_rows (
            request_id, candidate_id, display_score, risk_band, featured_rank,
            recent_mutual_rank
         ) VALUES ($1, $2, 55, 'medium', NULL, NULL)`,
        [REQUEST_ID, CANDIDATE_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_progress_state (
            request_id, revision, status, progress_bp, background_processing, tracks,
            last_event_seq, snapshot_fingerprint, updated_at
         ) VALUES (
            $1, 1, 'processing', 5000, TRUE,
            '{"relationshipAi":{"total":1,"stageCode":"A"},
              "interactions":{"total":1,"stageCode":"B"},
              "finalization":{"total":1,"stageCode":"C"}}'::JSONB,
            0, 'fingerprint', pg_catalog.clock_timestamp()
         )`,
        [REQUEST_ID]
    );
}

async function finalizeInternal() {
    return db.query<{ result: Record<string, unknown> }>(
        `SELECT public.analysis_v2_complete_result_and_purge_internal(
            $1, $2, $3, $4, NULL
         ) AS result`,
        [REQUEST_ID, FINALIZE_JOB_KEY, CLAIM_TOKEN, INPUT_HASH]
    );
}

describe('analysis V2 profile repair terminal outcome PGlite migration', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(checkpointMigration);
        await db.exec(telemetryMigration);
        await db.exec(repairMigration);
        await db.exec(internalFinalizerSource);
        await db.exec(aiUnavailableMigration);
        await db.exec(terminalOutcomeMigration);
    }, 120_000);

    afterAll(async () => {
        await db.close();
    });

    beforeEach(async () => {
        await db.exec(resetSql);
        await seedRequest();
    });

    it('records a repair outcome under its own telemetry source', async () => {
        await seedProfileAttempts({ fallback: 'failed', repair: 'success' });

        const telemetry = await db.query<{ source: string; status: string }>(
            `SELECT source, status
             FROM public.analysis_v2_profile_fetch_telemetry
             WHERE request_id = $1
             ORDER BY source`,
            [REQUEST_ID]
        );
        expect(telemetry.rows).toEqual([
            { source: 'fallback', status: 'failed' },
            { source: 'repair', status: 'success' },
            { source: 'selfhosted', status: 'failed' },
        ]);
    });

    it('selects the repair attempt ahead of the frozen fallback attempt', async () => {
        await seedProfileAttempts({ fallback: 'failed', repair: 'success' });
        await expect(terminalAttempt(CANDIDATE, [CANDIDATE])).resolves.toBe('repair');
    });

    it('selects the fallback attempt for a frozen username with no repair row', async () => {
        await seedProfileAttempts({ fallback: 'failed' });
        await expect(terminalAttempt(CANDIDATE, [CANDIDATE])).resolves.toBe('fallback');
    });

    it('selects the primary attempt for a username that never froze', async () => {
        await seedProfileAttempts({ fallback: 'failed' });
        await expect(terminalAttempt(CANDIDATE, [])).resolves.toBe('primary');
    });

    it('classifies a repaired-to-success unavailable row as an AI-response failure', async () => {
        await seedProfileAttempts({ fallback: 'failed', repair: 'success' });
        await insertFeatureRow('unavailable');

        const rows = await db.query<{ reason: string }>(
            `SELECT unavailable_reason AS reason
             FROM public.analysis_v2_candidate_feature_rows
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(rows.rows).toEqual([{ reason: 'ai_response' }]);
    });

    it('still classifies a never-repaired frozen failure as a profile-fetch failure', async () => {
        await seedProfileAttempts({ fallback: 'failed' });
        await insertFeatureRow('unavailable');

        const rows = await db.query<{ reason: string }>(
            `SELECT unavailable_reason AS reason
             FROM public.analysis_v2_candidate_feature_rows
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(rows.rows).toEqual([{ reason: 'profile_fetch' }]);
    });

    it('finalizes a scored candidate whose terminal outcome is a repair success', async () => {
        await seedProfileAttempts({ fallback: 'failed', repair: 'success' });
        await insertFeatureRow('verified_female');
        await seedFinalizerWorkingSet();

        const finalized = await finalizeInternal();
        expect(finalized.rows[0]?.result).toMatchObject({
            finalized: true,
            requestStatus: 'completed',
        });
    });

    it('still refuses to finalize when the repair attempt itself failed', async () => {
        await seedProfileAttempts({ fallback: 'failed', repair: 'failed' });
        await insertFeatureRow('verified_female');
        await seedFinalizerWorkingSet();

        await expect(finalizeInternal()).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
    });

    it('finalizes a frozen fallback success with no repair row at all', async () => {
        await seedProfileAttempts({ fallback: 'success' });
        await insertFeatureRow('verified_female');
        await seedFinalizerWorkingSet();

        const finalized = await finalizeInternal();
        expect(finalized.rows[0]?.result).toMatchObject({
            finalized: true,
            requestStatus: 'completed',
        });
    });

    it('still refuses to finalize a frozen fallback failure with no repair row', async () => {
        await seedProfileAttempts({ fallback: 'failed' });
        await insertFeatureRow('verified_female');
        await seedFinalizerWorkingSet();

        await expect(finalizeInternal()).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
    });

    it('routes every terminal-attempt reader through the shared selector', async () => {
        const definitions = await db.query<{ name: string; definition: string }>(
            `SELECT routine.proname AS name,
                    pg_catalog.pg_get_functiondef(routine.oid) AS definition
             FROM pg_catalog.pg_proc AS routine
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname = 'public'
               AND routine.proname IN (
                    'analysis_v2_set_feature_unavailable_reason',
                    'complete_analysis_v2_result_and_purge',
                    'analysis_v2_complete_result_and_purge_internal'
               )
             ORDER BY routine.proname`
        );
        expect(definitions.rows).toHaveLength(3);
        for (const row of definitions.rows) {
            expect(row.definition, row.name).toContain(
                'public.analysis_v2_profile_terminal_attempt('
            );
            expect(row.definition, row.name).not.toContain("THEN 'fallback' ELSE 'primary' END");
        }
    });
});
