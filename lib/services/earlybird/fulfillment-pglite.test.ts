import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql',
        import.meta.url
    ),
    'utf8'
);
const freshAdmissionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714030000_add_analysis_v2_fresh_admission_gate.sql',
        import.meta.url
    ),
    'utf8'
);
const automaticFulfillmentMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728120000_add_earlybird_automatic_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);
const scrubbedPreflightMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730140000_rehydrate_earlybird_paid_preflight_snapshot.sql',
        import.meta.url
    ),
    'utf8'
);
const expiredPaidPreflightRebindMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730150000_rebind_expired_paid_earlybird_preflights.sql',
        import.meta.url
    ),
    'utf8'
);
const repairedPaidPreflightRebindMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731000000_repair_paid_preflight_rebind.sql',
        import.meta.url
    ),
    'utf8'
);
const schemaFailedFulfillmentRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730170000_recover_schema_failed_earlybird_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);
const approvedEntitlementRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730180000_preserve_schema_recovery_approved_entitlement.sql',
        import.meta.url
    ),
    'utf8'
);
const canonicalTargetSchemaFailureRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730190000_recover_schema_failed_fulfillment_canonical_target.sql',
        import.meta.url
    ),
    'utf8'
);
const scrubbedTargetSchemaFailureRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730200000_admit_scrubbed_target_in_schema_failure_recovery.sql',
        import.meta.url
    ),
    'utf8'
);
const transientJobExhaustionRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730230000_recover_transient_job_exhaustion_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);
const freshnessRaceMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731020000_fix_earlybird_fulfillment_admission_freshness_race.sql',
        import.meta.url
    ),
    'utf8'
);
const capacitySafeCountDriftMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731030000_allow_capacity_safe_earlybird_admission_count_drift.sql',
        import.meta.url
    ),
    'utf8'
);
const scrubbedFreshnessRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731040000_recover_scrubbed_earlybird_freshness_conflict.sql',
        import.meta.url
    ),
    'utf8'
);
const recoveredRequestGenerationMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731050000_bound_recovered_earlybird_request_generation.sql',
        import.meta.url
    ),
    'utf8'
);
const providerRunAdoptionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731060000_adopt_recovery_provider_runs.sql',
        import.meta.url
    ),
    'utf8'
);
const fullyScrubbedProviderRunAdoptionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731070000_allow_fully_scrubbed_provider_run_adoption.sql',
        import.meta.url
    ),
    'utf8'
);
const pendingDispatchProviderRunAdoptionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731080000_allow_pending_dispatch_recovery_adoption.sql',
        import.meta.url
    ),
    'utf8'
);
const providerRunResolverShapeMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731090000_adopt_capacity_safe_relationship_provider_runs.sql',
        import.meta.url
    ),
    'utf8'
);
const adoptionPolicyFailureRearmMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731100000_rearm_zero_spend_adoption_policy_failure.sql',
        import.meta.url
    ),
    'utf8'
);

const USER = '123e4567-e89b-42d3-a456-426614174001';
const PREFLIGHT = '223e4567-e89b-42d3-a456-426614174001';
const ORDER = '323e4567-e89b-42d3-a456-426614174001';
const CLAIM = '423e4567-e89b-42d3-a456-426614174001'; // gitleaks:allow
const FAILED_REQUEST = '523e4567-e89b-42d3-a456-426614174001';
const ADMISSION_TOKEN = '623e4567-e89b-42d3-a456-426614174001';
const DISPATCH_TOKEN = '723e4567-e89b-42d3-a456-426614174001';
const ADMISSION_CLAIM = '823e4567-e89b-42d3-a456-426614174001';
const ACTIVE_REQUEST = '923e4567-e89b-42d3-a456-426614174001';
const UNLINKED_USER = 'a23e4567-e89b-42d3-a456-426614174001';
const UNLINKED_PREFLIGHT = 'b23e4567-e89b-42d3-a456-426614174001';
const RECOVERY_PREFLIGHT = 'c23e4567-e89b-42d3-a456-426614174001';

const catalog = {
    basic: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 400, following: 400 },
        detailedMutualLimit: 300,
    },
    standard: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
    },
    plus: {
        launchStatus: 'test_only',
        relationshipCapacity: { followers: 1200, following: 1200 },
        detailedMutualLimit: 900,
    },
};
const cards = {
    basic: {
        ...catalog.basic,
        selectionState: 'required',
        unavailableReason: null,
    },
    standard: {
        ...catalog.standard,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
    plus: {
        ...catalog.plus,
        selectionState: 'unavailable',
        unavailableReason: 'launch_gate',
    },
};
const standardCapacityCatalog = {
    basic: catalog.basic,
    standard: {
        ...catalog.standard,
        launchStatus: 'test_only',
    },
    plus: {
        ...catalog.plus,
        launchStatus: 'production',
    },
};
const approvedStandardCards = {
    basic: {
        ...catalog.basic,
        selectionState: 'unavailable',
        unavailableReason: 'below_required_plan',
    },
    standard: {
        ...catalog.standard,
        selectionState: 'required',
        unavailableReason: null,
    },
    plus: {
        ...standardCapacityCatalog.plus,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
};
const mismatchedRequiredCards = {
    ...cards,
    basic: {
        ...cards.basic,
        selectionState: 'available_upgrade',
    },
    standard: {
        ...cards.standard,
        selectionState: 'required',
    },
};
const standardRequiredCards = {
    basic: {
        ...catalog.basic,
        selectionState: 'unavailable',
        unavailableReason: 'below_required_plan',
    },
    standard: {
        ...catalog.standard,
        selectionState: 'required',
        unavailableReason: null,
    },
    plus: {
        ...catalog.plus,
        selectionState: 'unavailable',
        unavailableReason: 'launch_gate',
    },
};

type FulfillmentIdentity = {
    order_id: string;
    fulfillment_status: string;
    preflight_id: string;
    user_id: string;
    plan_id: 'basic' | 'standard';
    request_id: string | null;
};

let db: PGlite;

async function asService<T>(
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

function admissionHash(orderId = ORDER): string {
    return createHash('sha256')
        .update(`earlybird-fulfillment-admission-v1\n${orderId}`, 'utf8')
        .digest('hex');
}

async function admit(): Promise<FulfillmentIdentity> {
    return (await asService<FulfillmentIdentity>(
        'SELECT * FROM public.admit_earlybird_fulfillment($1)',
        [ORDER]
    )).rows[0];
}

async function rebind(): Promise<string> {
    return (await asService<{ rebind_expired_paid_earlybird_preflight: string }>(
        'SELECT public.rebind_expired_paid_earlybird_preflight($1)',
        [ORDER]
    )).rows[0].rebind_expired_paid_earlybird_preflight;
}

async function boundPreflightId(): Promise<string> {
    return (await db.query<{ preflight_id: string }>(
        'SELECT preflight_id FROM public.earlybird_orders WHERE id = $1',
        [ORDER]
    )).rows[0].preflight_id;
}

type PreflightRow = {
    id: string;
    idempotency_key: string;
    status: string;
};

async function preflightsByAge(): Promise<PreflightRow[]> {
    return (await db.query<PreflightRow>(
        `SELECT id, idempotency_key, status
         FROM public.analysis_preflights
         ORDER BY created_at, id`
    )).rows;
}

/**
 * Pushes the preflight the order currently points at past its immutable TTL
 * while leaving its status alone. The live casualty was still `ready` when it
 * expired, which is exactly what makes the replacement collide with
 * idx_analysis_preflights_one_active_per_user.
 */
async function expireBoundPreflight(minutesAgo = 90): Promise<string> {
    const bound = await boundPreflightId();
    const createdAt = new Date(
        Date.now() - (minutesAgo + 30) * 60_000
    ).toISOString();
    await db.query(
        `UPDATE public.analysis_preflights
         SET created_at = $2::TIMESTAMPTZ,
             ready_at = $2::TIMESTAMPTZ,
             expires_at = $2::TIMESTAMPTZ + INTERVAL '30 minutes'
         WHERE id = $1`,
        [bound, createdAt]
    );
    return bound;
}

async function makeAdmissionReady(
    preflightId = PREFLIGHT,
    followers = 120,
    following = 140
): Promise<void> {
    await db.query(
        `UPDATE public.analysis_preflights
         SET admission_status = 'ready',
             admission_selected_plan_id = 'basic',
             admission_entitlement_jti_hash = $2,
             admission_token = '523e4567-e89b-42d3-a456-426614174001',
             admission_refreshed_at = pg_catalog.clock_timestamp(),
             admission_target_followers_count = $4,
             admission_target_following_count = $5,
             admission_capacity_required_plan_id = 'basic',
             admission_required_plan_id = 'basic',
             admission_plan_cards_snapshot = $3::JSONB
         WHERE id = $1`,
        [preflightId, admissionHash(), JSON.stringify(cards), followers, following]
    );
}

async function seedLegacyStaleSnapshotConflict(): Promise<string> {
    await admit();
    await makeAdmissionReady();
    await db.query(
        `UPDATE public.analysis_preflights
         SET admission_refreshed_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes 1 second'
         WHERE id = $1`,
        [PREFLIGHT]
    );
    await db.query(
        `UPDATE public.earlybird_fulfillments
         SET status = 'manual_review', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'SNAPSHOT_CONFLICT',
             manual_review_at = pg_catalog.clock_timestamp()
         WHERE order_id = $1`,
        [ORDER]
    );
    return (await db.query<{ manual_review_at: string }>(
        'SELECT manual_review_at FROM public.earlybird_fulfillments WHERE order_id = $1',
        [ORDER]
    )).rows[0].manual_review_at;
}

async function seedScrubbedStaleSnapshotConflict(): Promise<string> {
    const manualReviewAt = await seedLegacyStaleSnapshotConflict();
    await db.query(
        `UPDATE public.analysis_preflights
         SET status = 'expired',
             target_instagram_id = 'retained.'
                || pg_catalog.substr(pg_catalog.replace(id::TEXT, '-', ''), 1, 20),
             target_full_name = NULL, target_bio = NULL,
             target_profile_image_url = NULL,
             target_followers_count = NULL, target_following_count = NULL,
             target_is_private = NULL, capacity_required_plan_id = NULL,
             required_plan_id = NULL, plan_cards_snapshot = NULL,
             error_code = NULL, blocked_at = NULL, ready_at = NULL,
             exclusion_decision = 'skip', excluded_instagram_id = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             pii_scrubbed_at = pg_catalog.clock_timestamp(),
             created_at = TIMESTAMPTZ '2020-01-01 00:00:00+00',
             expires_at = TIMESTAMPTZ '2020-01-01 00:30:00+00'
         WHERE id = $1`,
        [PREFLIGHT]
    );
    return manualReviewAt;
}

async function claim() {
    return (await asService<{
        claimed: boolean;
        fulfillment_status: string;
        lease_token: string | null;
        lease_fence: number;
        attempt_count: number;
    }>(
        `SELECT * FROM public.claim_earlybird_fulfillment(
            $1, $2, 300
        )`,
        [ORDER, CLAIM]
    )).rows[0];
}

/**
 * The exact token `analysis_v2_scrub_terminal_request_pii` writes over
 * `analysis_requests.target_instagram_id` on terminal failure.
 */
function canonicalScrubToken(requestId: string): string {
    return `retained.${requestId.replace(/-/g, '').slice(0, 20)}`;
}

async function seedRecoveredRequestCollision(): Promise<string> {
    const requestKey = `earlybird:${ORDER}`;
    const preflightKey = `earlybird.fulfillment.${ORDER.replace(/-/g, '')}.r1`;
    await db.query(
        `UPDATE public.analysis_preflights
         SET idempotency_key = $2
         WHERE id = $1`,
        [PREFLIGHT, preflightKey]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(
            id, user_id, idempotency_key, target_instagram_id,
            target_followers_count, target_following_count, target_is_private,
            exclusion_decision, excluded_instagram_id, status, access_mode,
            launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
            pricing_version, pricing_snapshot, policy_versions_snapshot,
            capacity_required_plan_id, required_plan_id,
            admission_status, admission_selected_plan_id,
            admission_entitlement_jti_hash, admission_token,
            admission_refreshed_at, admission_target_followers_count,
            admission_target_following_count,
            admission_capacity_required_plan_id, admission_required_plan_id,
            admission_plan_cards_snapshot,
            created_at, updated_at, expires_at, ready_at, pii_scrubbed_at
         )
         SELECT $2, user_id, $3, $4,
            NULL, NULL, NULL,
            'skip', NULL, 'expired', access_mode,
            launch_status_snapshot, plan_catalog_snapshot, NULL,
            pricing_version, pricing_snapshot, policy_versions_snapshot,
            NULL, NULL,
            'ready', 'basic', $5, $6,
            pg_catalog.clock_timestamp() - INTERVAL '2 hours',
            target_followers_count, target_following_count,
            capacity_required_plan_id, required_plan_id, plan_cards_snapshot,
            pg_catalog.clock_timestamp() - INTERVAL '2 hours',
            pg_catalog.clock_timestamp() - INTERVAL '90 minutes',
            pg_catalog.clock_timestamp() - INTERVAL '90 minutes',
            NULL,
            pg_catalog.clock_timestamp() - INTERVAL '80 minutes'
         FROM public.analysis_preflights
         WHERE id = $1`,
        [
            PREFLIGHT,
            RECOVERY_PREFLIGHT,
            `earlybird.schema-recovery.${ORDER.replace(/-/g, '')}`,
            canonicalScrubToken(RECOVERY_PREFLIGHT),
            admissionHash(),
            ADMISSION_TOKEN,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_requests(
            id, user_id, target_instagram_id, target_gender, status,
            error_message, progress, idempotency_key, pipeline_version
         ) VALUES (
            $1, $2, $3, 'male', 'failed',
            'JOB_ATTEMPTS_EXHAUSTED', 100, $4, 'v2'
         )`,
        [FAILED_REQUEST, USER, canonicalScrubToken(FAILED_REQUEST), requestKey]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
         VALUES ($1, 'JOB_ATTEMPTS_EXHAUSTED')`,
        [FAILED_REQUEST]
    );
    await db.query(
        `INSERT INTO public.earlybird_schema_failure_recoveries(
            order_id, failed_request_id, recovery_preflight_id,
            prior_attempt_count
         ) VALUES ($1, $2, $3, 4)`,
        [ORDER, FAILED_REQUEST, RECOVERY_PREFLIGHT]
    );
    return requestKey;
}

async function seedDirectRecoveredRequestCollision(): Promise<string> {
    const requestKey = `earlybird:${ORDER}`;
    await db.query(
        `INSERT INTO public.analysis_requests(
            id, user_id, target_instagram_id, target_gender, status,
            error_message, progress, idempotency_key, pipeline_version
         ) VALUES (
            $1, $2, $3, 'male', 'failed',
            'JOB_ATTEMPTS_EXHAUSTED', 100, $4, 'v2'
         )`,
        [FAILED_REQUEST, USER, canonicalScrubToken(FAILED_REQUEST), requestKey]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
         VALUES ($1, 'JOB_ATTEMPTS_EXHAUSTED')`,
        [FAILED_REQUEST]
    );
    await db.query(
        `INSERT INTO public.earlybird_schema_failure_recoveries(
            order_id, failed_request_id, recovery_preflight_id,
            prior_attempt_count
         ) VALUES ($1, $2, $3, 4)`,
        [ORDER, FAILED_REQUEST, PREFLIGHT]
    );
    return requestKey;
}

async function fullyScrubRecoveryAdmissionAndDriftCurrent(): Promise<void> {
    await db.query(
        `UPDATE public.analysis_preflights
         SET admission_status = 'idle',
             admission_selected_plan_id = NULL,
             admission_entitlement_jti_hash = NULL,
             admission_token = NULL,
             admission_requested_at = NULL,
             admission_refreshed_at = NULL,
             admission_claim_token = NULL,
             admission_lease_expires_at = NULL,
             admission_dispatch_state = 'idle',
             admission_dispatch_token = NULL,
             admission_dispatch_reserved_at = NULL,
             admission_dispatched_at = NULL,
             admission_error_code = NULL,
             admission_target_followers_count = NULL,
             admission_target_following_count = NULL,
             admission_capacity_required_plan_id = NULL,
             admission_required_plan_id = NULL,
             admission_plan_cards_snapshot = NULL,
             admission_last_error_code = NULL
         WHERE id = $1`,
        [RECOVERY_PREFLIGHT]
    );
    await makeAdmissionReady();
    await db.query(
        `UPDATE public.analysis_preflights
         SET target_followers_count = 180,
             target_following_count = 190,
             admission_target_followers_count = 180,
             admission_target_following_count = 190
         WHERE id = $1`,
        [PREFLIGHT]
    );
}

async function pendingDispatchRecoveryAdmissionAndDriftCurrent(): Promise<void> {
    await db.query(
        `UPDATE public.analysis_preflights
         SET admission_status = 'pending',
             admission_selected_plan_id = 'basic',
             admission_entitlement_jti_hash = encode(
                 extensions.digest(
                     convert_to(
                         'earlybird-fulfillment-admission-v1' || chr(10) || lower($2),
                         'UTF8'
                     ),
                     'sha256'
                 ),
                 'hex'
             ),
             admission_token = $3,
             admission_requested_at = pii_scrubbed_at - INTERVAL '3 minutes',
             admission_refreshed_at = NULL,
             admission_claim_token = NULL,
             admission_lease_expires_at = NULL,
             admission_dispatch_state = 'enqueued',
             admission_dispatch_generation = 1,
             admission_dispatch_token = $4,
             admission_dispatch_reserved_at = pii_scrubbed_at - INTERVAL '2 minutes',
             admission_dispatched_at = pii_scrubbed_at - INTERVAL '1 minute',
             admission_error_code = NULL,
             admission_target_followers_count = NULL,
             admission_target_following_count = NULL,
             admission_capacity_required_plan_id = NULL,
             admission_required_plan_id = NULL,
             admission_plan_cards_snapshot = NULL,
             admission_failure_count = 0,
             admission_last_error_code = NULL
         WHERE id = $1`,
        [RECOVERY_PREFLIGHT, ORDER, ADMISSION_TOKEN, DISPATCH_TOKEN]
    );
    await makeAdmissionReady();
    await db.query(
        `UPDATE public.analysis_preflights
         SET target_followers_count = 180,
             target_following_count = 190,
             admission_target_followers_count = 180,
             admission_target_following_count = 190
         WHERE id = $1`,
        [PREFLIGHT]
    );
}

/**
 * Replays `analysis_v2_scrub_terminal_request_pii` verbatim. Production runs this on every
 * terminal V2 failure, so it scrubs the consumed preflight as well as the request. Copying
 * the statements rather than hand-writing the end state keeps this fixture from drifting
 * away from the function whose output recovery actually has to survive.
 */
async function applyTerminalPiiScrub(requestId: string): Promise<void> {
    await db.query(
        `UPDATE public.analysis_preflights AS preflight
         SET target_instagram_id = 'retained.'
                 || pg_catalog.substr(
                     pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
                 ),
             target_full_name = NULL,
             target_bio = NULL,
             target_profile_image_url = NULL,
             exclusion_decision = 'skip',
             excluded_instagram_id = NULL,
             pii_scrubbed_at = COALESCE(preflight.pii_scrubbed_at, $2),
             updated_at = $2
         WHERE preflight.consumed_request_id = $1
           AND preflight.status = 'consumed'`,
        [requestId, new Date().toISOString()]
    );
    await db.query(
        `UPDATE public.analysis_requests AS analysis_request
         SET target_instagram_id = 'retained.'
                 || pg_catalog.substr(
                     pg_catalog.replace(analysis_request.id::TEXT, '-', ''), 1, 20
                 ),
             exclusion_decision_snapshot = 'skip',
             excluded_instagram_id = NULL
         WHERE analysis_request.id = $1
           AND analysis_request.pipeline_version = 'v2'`,
        [requestId]
    );
}

const SCHEMA_FAILURE = 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR';

async function seedSchemaFailedManualReview(
    requestTarget: string,
    failure: { requestError?: string; receiptError?: string } = {}
): Promise<void> {
    const requestError = failure.requestError ?? SCHEMA_FAILURE;
    const receiptError = failure.receiptError ?? requestError;
    await db.query(
        `INSERT INTO public.analysis_requests(
            id, user_id, target_instagram_id, target_gender, status,
            progress, pipeline_version, preflight_id, error_message,
            completed_at
        ) VALUES (
            $1, $2, $3, 'male', 'failed', 100, 'v2', $4,
            $5,
            pg_catalog.clock_timestamp()
        )`,
        [FAILED_REQUEST, USER, requestTarget, PREFLIGHT, requestError]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
         VALUES ($1, $2)`,
        [FAILED_REQUEST, receiptError]
    );
    await db.query(
        `UPDATE public.analysis_preflights
         SET status = 'consumed', consumed_request_id = $2,
             consumed_at = pg_catalog.clock_timestamp()
         WHERE id = $1`,
        [PREFLIGHT, FAILED_REQUEST]
    );
    await db.query(
        `UPDATE public.earlybird_orders
         SET status = 'analysis_in_progress', result_request_id = $2
         WHERE id = $1`,
        [ORDER, FAILED_REQUEST]
    );
    await db.query(
        `UPDATE public.earlybird_fulfillments
         SET status = 'manual_review', request_id = $2, attempt_count = 1,
             operator_admitted_at = pg_catalog.clock_timestamp(),
             manual_review_at = pg_catalog.clock_timestamp()
         WHERE order_id = $1`,
        [ORDER, FAILED_REQUEST]
    );
}

describe('operator-approved earlybird fulfillment migration', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

            CREATE TABLE public.users (
                id UUID PRIMARY KEY,
                email TEXT,
                provider TEXT,
                analysis_count INTEGER NOT NULL DEFAULT 0,
                is_paid_user BOOLEAN NOT NULL DEFAULT FALSE
            );
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES public.users(id),
                target_instagram_id TEXT NOT NULL,
                target_gender TEXT NOT NULL,
                status TEXT NOT NULL,
                error_message TEXT,
                completed_at TIMESTAMP WITH TIME ZONE,
                progress INTEGER NOT NULL,
                progress_step TEXT,
                current_step TEXT,
                step_data JSONB,
                gender_stats JSONB,
                plan_type TEXT,
                background_processing BOOLEAN,
                idempotency_key TEXT,
                pipeline_version TEXT,
                preflight_id UUID,
                excluded_instagram_id TEXT,
                exclusion_decision_snapshot TEXT,
                plan_access_mode_snapshot TEXT,
                capacity_required_plan_id_snapshot TEXT,
                required_plan_id_snapshot TEXT,
                selected_plan_id_snapshot TEXT,
                plan_launch_status_snapshot JSONB,
                plan_cards_snapshot JSONB,
                pricing_version_snapshot TEXT,
                pricing_snapshot JSONB,
                analysis_scope_snapshot JSONB,
                policy_versions_snapshot JSONB
            );
            CREATE UNIQUE INDEX idx_analysis_requests_user_idempotency
                ON public.analysis_requests(user_id, idempotency_key)
                WHERE idempotency_key IS NOT NULL;
            CREATE TABLE public.analysis_preflights (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES public.users(id),
                idempotency_key TEXT NOT NULL DEFAULT 'test-preflight-key',
                target_instagram_id TEXT NOT NULL,
                target_followers_count INTEGER,
                target_following_count INTEGER,
                target_is_private BOOLEAN,
                exclusion_decision TEXT,
                excluded_instagram_id TEXT,
                status TEXT NOT NULL,
                access_mode TEXT NOT NULL,
                launch_status_snapshot JSONB,
                plan_catalog_snapshot JSONB,
                plan_cards_snapshot JSONB,
                pricing_version TEXT,
                pricing_snapshot JSONB,
                policy_versions_snapshot JSONB,
                capacity_required_plan_id TEXT,
                required_plan_id TEXT,
                consumed_request_id UUID REFERENCES public.analysis_requests(id),
                consumed_at TIMESTAMP WITH TIME ZONE,
                error_code TEXT,
                blocked_at TIMESTAMP WITH TIME ZONE,
                ready_at TIMESTAMP WITH TIME ZONE,
                expires_at TIMESTAMP WITH TIME ZONE,
                pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
                lease_token UUID,
                lease_expires_at TIMESTAMP WITH TIME ZONE,
                target_full_name TEXT,
                target_bio TEXT,
                target_profile_image_url TEXT,
                created_at TIMESTAMP WITH TIME ZONE
                    DEFAULT pg_catalog.clock_timestamp(),
                updated_at TIMESTAMP WITH TIME ZONE
                    DEFAULT pg_catalog.clock_timestamp()
            );
            ALTER TABLE public.analysis_preflights
                ADD CONSTRAINT analysis_preflights_status_payload_check CHECK (
                    (
                        status IN ('ready', 'consumed')
                        AND target_followers_count IS NOT NULL
                        AND target_following_count IS NOT NULL
                        AND target_is_private = FALSE
                        AND capacity_required_plan_id IS NOT NULL
                        AND required_plan_id IS NOT NULL
                        AND plan_cards_snapshot IS NOT NULL
                        AND ready_at IS NOT NULL
                        AND error_code IS NULL
                    )
                    OR status NOT IN ('ready', 'consumed')
                );
            ALTER TABLE public.analysis_preflights
                ADD CONSTRAINT analysis_preflights_ttl_check CHECK (
                    expires_at = created_at + INTERVAL '30 minutes'
                );
            -- Both live uniqueness guarantees. Recovery mints replacement
            -- preflights for a user who already has one, so without these the
            -- fixture cannot reproduce the collisions that strand paid orders.
            CREATE UNIQUE INDEX idx_analysis_preflights_user_idempotency
                ON public.analysis_preflights(user_id, idempotency_key);
            CREATE UNIQUE INDEX idx_analysis_preflights_one_active_per_user
                ON public.analysis_preflights(user_id)
                WHERE status IN ('pending', 'processing', 'ready');
            ALTER TABLE public.analysis_requests
                ADD CONSTRAINT analysis_requests_preflight_fk
                FOREIGN KEY (preflight_id)
                REFERENCES public.analysis_preflights(id)
                DEFERRABLE INITIALLY DEFERRED;
            CREATE TABLE public.earlybird_orders (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES public.users(id),
                preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
                target_instagram_id TEXT NOT NULL,
                target_followers_count INTEGER NOT NULL,
                target_following_count INTEGER NOT NULL,
                exclusion_decision TEXT NOT NULL,
                excluded_instagram_id TEXT,
                plan_id TEXT NOT NULL,
                status TEXT NOT NULL,
                expected_groble_product_id TEXT NOT NULL,
                expected_amount_krw INTEGER NOT NULL,
                payment_id TEXT,
                actual_groble_product_id TEXT,
                actual_amount_krw INTEGER,
                seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE,
                result_request_id UUID REFERENCES public.analysis_requests(id),
                updated_at TIMESTAMP WITH TIME ZONE
                    DEFAULT pg_catalog.clock_timestamp()
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
                job_key TEXT NOT NULL,
                track TEXT NOT NULL,
                kind TEXT NOT NULL,
                batch INTEGER,
                input_hash TEXT NOT NULL,
                required_job_keys TEXT[] NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error_code TEXT,
                lease_token UUID,
                lease_expires_at TIMESTAMP WITH TIME ZONE,
                PRIMARY KEY(request_id, job_key)
            );
            CREATE FUNCTION public.analysis_v2_valid_provider_operation_key(TEXT)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT AS $$
                SELECT $1 ~ '^(relationship-followers|target-likers|target-comments):[0-9a-f]{64}$'
            $$;
            CREATE TABLE public.analysis_v2_provider_runs (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
                job_key TEXT NOT NULL,
                operation_key TEXT NOT NULL,
                input_hash TEXT NOT NULL,
                job_claim_token UUID NOT NULL,
                reservation_token UUID NOT NULL,
                logical_provider TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                max_charge_usd NUMERIC NOT NULL,
                status TEXT NOT NULL,
                run_id TEXT,
                actual_usage_usd NUMERIC,
                reserved_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp(),
                run_started_at TIMESTAMP WITH TIME ZONE,
                terminalized_at TIMESTAMP WITH TIME ZONE,
                usage_reconciled_at TIMESTAMP WITH TIME ZONE,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp(),
                PRIMARY KEY(request_id, job_key, operation_key),
                FOREIGN KEY(request_id, job_key)
                    REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
            );
            CREATE TABLE public.analysis_preflight_provider_runs (
                preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
                status TEXT NOT NULL,
                actual_usage_usd NUMERIC,
                usage_reconciled_at TIMESTAMP WITH TIME ZONE
            );
            CREATE TABLE public.earlybird_waitlist (
                preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id)
            );
            CREATE TABLE public.analysis_v2_failure_receipts (
                request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id),
                error_code TEXT NOT NULL
            );
            CREATE TABLE public.analysis_provider_cost_ledger (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
            );
            CREATE TABLE public.analysis_v2_ai_attempts (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
            );
            CREATE TABLE public.analysis_v2_relationship_sides (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
            );
            CREATE TABLE public.analysis_v2_target_evidence_manifests (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
            );

            CREATE FUNCTION public.checkpoint_analysis_v2_relationship_side(
                p_request_id UUID,
                p_job_key TEXT,
                p_claim_token UUID,
                p_side TEXT,
                p_input_hash TEXT,
                p_declared_count INTEGER,
                p_source_status TEXT,
                p_provider TEXT,
                p_provider_run_id TEXT,
                p_provider_operation_key TEXT,
                p_excluded_username TEXT,
                p_rows JSONB
            )
            RETURNS BOOLEAN
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = ''
            AS $$
            DECLARE
                v_provider_run public.analysis_v2_provider_runs%ROWTYPE;
            BEGIN
                SELECT provider_run.*
                INTO v_provider_run
                FROM public.analysis_v2_provider_runs AS provider_run
                WHERE provider_run.request_id = p_request_id
                  AND provider_run.job_key = p_job_key
                  AND provider_run.operation_key = p_provider_operation_key
                FOR UPDATE;
                IF NOT FOUND
                   OR v_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
                   OR v_provider_run.logical_provider IS DISTINCT FROM p_provider
                   OR v_provider_run.input_hash IS DISTINCT FROM p_input_hash
                   OR v_provider_run.run_id IS DISTINCT FROM p_provider_run_id
                   OR v_provider_run.status <> 'succeeded' THEN
                    RETURN FALSE;
                END IF;
                RETURN TRUE;
            END;
            $$;

            CREATE FUNCTION public.checkpoint_analysis_v2_target_evidence(
                p_request_id UUID,
                p_job_key TEXT,
                p_claim_token UUID,
                p_target_username TEXT,
                p_target_profile_input_hash TEXT,
                p_target_profile_provider TEXT,
                p_target_profile_run_id TEXT,
                p_target_profile_operation_key TEXT,
                p_liker_source JSONB,
                p_comment_source JSONB,
                p_rows JSONB
            )
            RETURNS BOOLEAN
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = ''
            AS $$
            DECLARE
                v_liker_provider_run public.analysis_v2_provider_runs%ROWTYPE;
                v_comment_provider_run public.analysis_v2_provider_runs%ROWTYPE;
            BEGIN
                SELECT provider_run.*
                INTO v_liker_provider_run
                FROM public.analysis_v2_provider_runs AS provider_run
                WHERE provider_run.request_id = p_request_id
                  AND provider_run.job_key = p_job_key
                  AND provider_run.operation_key = p_liker_source->>'provider_operation_key'
                FOR UPDATE;
                IF NOT FOUND
                   OR v_liker_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
                   OR v_liker_provider_run.input_hash IS DISTINCT FROM p_liker_source->>'input_hash'
                   OR v_liker_provider_run.logical_provider IS DISTINCT FROM p_liker_source->>'provider'
                   OR v_liker_provider_run.run_id IS DISTINCT FROM p_liker_source->>'provider_run_id'
                   OR v_liker_provider_run.credential_slot IS DISTINCT FROM
                        p_liker_source->>'provider_credential_slot'
                   OR v_liker_provider_run.status <> 'succeeded' THEN
                    RETURN FALSE;
                END IF;
                SELECT provider_run.*
                INTO v_comment_provider_run
                FROM public.analysis_v2_provider_runs AS provider_run
                WHERE provider_run.request_id = p_request_id
                  AND provider_run.job_key = p_job_key
                  AND provider_run.operation_key = p_comment_source->>'provider_operation_key'
                FOR UPDATE;
                IF NOT FOUND
                   OR v_comment_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
                   OR v_comment_provider_run.input_hash IS DISTINCT FROM p_comment_source->>'input_hash'
                   OR v_comment_provider_run.logical_provider IS DISTINCT FROM p_comment_source->>'provider'
                   OR v_comment_provider_run.run_id IS DISTINCT FROM p_comment_source->>'provider_run_id'
                   OR v_comment_provider_run.credential_slot IS DISTINCT FROM
                        p_comment_source->>'provider_credential_slot'
                   OR v_comment_provider_run.status <> 'succeeded' THEN
                    RETURN FALSE;
                END IF;
                RETURN TRUE;
            END;
            $$;

            CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_scope_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.consume_analysis_v2_test_entitlement(
                UUID, UUID, TEXT, TEXT
            )
            RETURNS TABLE(
                request_id UUID,
                created BOOLEAN,
                initial_job_key TEXT,
                request_status TEXT,
                background_processing BOOLEAN
            )
            LANGUAGE sql AS $$
                SELECT NULL::UUID, NULL::BOOLEAN, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN
                WHERE FALSE
            $$;
        `);
        await db.exec(freshAdmissionMigration);
        await db.exec(
            'ALTER TABLE public.analysis_preflights DROP CONSTRAINT analysis_preflights_admission_payload_check'
        );
        await db.exec(migration);
        await db.exec(automaticFulfillmentMigration);
        await db.exec(scrubbedPreflightMigration);
        await db.exec(expiredPaidPreflightRebindMigration);
        await db.exec(repairedPaidPreflightRebindMigration);
        await db.exec(schemaFailedFulfillmentRecoveryMigration);
        await db.exec(approvedEntitlementRecoveryMigration);
        await db.exec(canonicalTargetSchemaFailureRecoveryMigration);
        await db.exec(scrubbedTargetSchemaFailureRecoveryMigration);
        await db.exec(transientJobExhaustionRecoveryMigration);
        await db.exec(freshnessRaceMigration);
        await db.exec(capacitySafeCountDriftMigration);
        await db.exec(scrubbedFreshnessRecoveryMigration);
        await db.exec(recoveredRequestGenerationMigration);
        // pg_get_functiondef preserves the fixture body's TypeScript indentation.
        // Normalize it to the production definitions' indentation so the real
        // 06000 fail-closed DO rewrite must match and execute verbatim.
        await db.exec(`
            DO $fixture$
            DECLARE
                v_definition TEXT;
            BEGIN
                v_definition := pg_catalog.pg_get_functiondef(
                    'public.checkpoint_analysis_v2_relationship_side(uuid,text,uuid,text,text,integer,text,text,text,text,text,jsonb)'::pg_catalog.regprocedure
                );
                v_definition := pg_catalog.regexp_replace(
                    v_definition, '(?m)^ {12}', '', 'g'
                );
                EXECUTE v_definition;

                v_definition := pg_catalog.pg_get_functiondef(
                    'public.checkpoint_analysis_v2_target_evidence(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure
                );
                v_definition := pg_catalog.regexp_replace(
                    v_definition, '(?m)^ {8}', '', 'g'
                );
                EXECUTE v_definition;
            END;
            $fixture$;
        `);
        await db.exec(providerRunAdoptionMigration);
        await db.exec(fullyScrubbedProviderRunAdoptionMigration);
        await db.exec(pendingDispatchProviderRunAdoptionMigration);
        await db.exec(providerRunResolverShapeMigration);
        await db.exec(adoptionPolicyFailureRearmMigration);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_v2_recovery_provider_run_adoptions,
                public.earlybird_adoption_policy_failure_rearms,
                public.earlybird_schema_failure_recoveries,
                public.earlybird_fulfillments,
                public.analysis_v2_provider_runs,
                public.analysis_pipeline_jobs,
                public.analysis_preflight_provider_runs,
                public.earlybird_waitlist,
                public.earlybird_orders,
                public.analysis_v2_failure_receipts,
                public.analysis_provider_cost_ledger,
                public.analysis_v2_ai_attempts,
                public.analysis_v2_relationship_sides,
                public.analysis_v2_target_evidence_manifests,
                public.analysis_requests,
                public.analysis_preflights,
                public.users;
            INSERT INTO public.users(id) VALUES ('${USER}');
        `);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, target_instagram_id,
                target_followers_count, target_following_count,
                target_is_private, exclusion_decision, status, access_mode,
                launch_status_snapshot, plan_catalog_snapshot,
                plan_cards_snapshot, pricing_version, pricing_snapshot,
                policy_versions_snapshot, capacity_required_plan_id,
                required_plan_id, created_at, ready_at, expires_at, admission_status
            ) VALUES (
                $1, $2, 'sample.account', 120, 140, FALSE, 'skip',
                'ready', 'production',
                '{"basic":"production","standard":"production","plus":"test_only"}',
                $3::JSONB, $4::JSONB, 'deferred',
                '{"basic":{"status":"deferred"},"standard":{"status":"deferred"},"plus":{"status":"deferred"}}',
                '{"pipeline":"v2","risk":"v1","aiStage":"v1"}',
                'basic', 'basic', TIMESTAMPTZ '2030-01-01 00:00:00+00',
                TIMESTAMPTZ '2030-01-01 00:00:00+00',
                TIMESTAMPTZ '2030-01-01 00:30:00+00', 'idle'
            )`,
            [PREFLIGHT, USER, JSON.stringify(catalog), JSON.stringify(cards)]
        );
        await db.query(
            `INSERT INTO public.earlybird_orders(
                id, user_id, preflight_id, target_instagram_id,
                target_followers_count, target_following_count,
                exclusion_decision, plan_id, status,
                expected_groble_product_id, expected_amount_krw,
                payment_id, actual_groble_product_id, actual_amount_krw,
                seller_reference_confirmed_at
            ) VALUES (
                $1, $2, $3, 'sample.account', 120, 140, 'skip',
                'basic', 'paid', 'basic-product', 14900,
                'payment-one', 'basic-product', 14900,
                pg_catalog.clock_timestamp()
            )`,
            [ORDER, USER, PREFLIGHT]
        );
    });

    afterAll(async () => {
        await db.close();
    });

    it('enqueues a confirmed payment but never exposes it to recovery before admission', async () => {
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('awaiting_operator');
        expect((await asService(
            'SELECT * FROM public.list_recoverable_earlybird_fulfillments(20)'
        )).rows).toEqual([]);
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_requests'
        )).rows[0].count).toBe(0);
    });

    it('automatically admits only a reference-confirmed paid waiting row', async () => {
        const admitted = await asService<FulfillmentIdentity>(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
        );
        expect(admitted.rows).toEqual([expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
            preflight_id: PREFLIGHT,
            user_id: USER,
            plan_id: 'basic',
            request_id: null,
        })]);
        expect((await db.query<{ operator_admitted_at: string | null }>(
            'SELECT operator_admitted_at FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].operator_admitted_at).not.toBeNull();

        await expect(asService(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
        )).resolves.toMatchObject({ rows: [] });
    });

    it('rehydrates a scrubbed paid checkout preflight from its immutable admission snapshot', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = NULL,
                 target_following_count = NULL,
                 target_is_private = NULL,
                 capacity_required_plan_id = NULL,
                 required_plan_id = NULL,
                 plan_cards_snapshot = NULL,
                 admission_target_followers_count = 120,
                 admission_target_following_count = 140,
                 admission_capacity_required_plan_id = 'basic',
                 admission_required_plan_id = 'basic',
                 admission_plan_cards_snapshot = $2::JSONB,
                 status = 'expired',
                 created_at = TIMESTAMPTZ '2026-07-01 00:00:00+00',
                 expires_at = TIMESTAMPTZ '2026-07-01 00:30:00+00'
             WHERE id = $1`,
            [PREFLIGHT, JSON.stringify(cards)]
        );

        await expect(asService<FulfillmentIdentity>(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({
                order_id: ORDER,
                fulfillment_status: 'admission_pending',
            })],
        });
        expect((await db.query<{
            status: string;
            target_followers_count: number;
            target_following_count: number;
            target_is_private: boolean;
            capacity_required_plan_id: string;
            required_plan_id: string;
            plan_cards_snapshot: typeof cards;
        }>(
            `SELECT preflight.status, preflight.target_followers_count, preflight.target_following_count,
                    preflight.target_is_private, preflight.capacity_required_plan_id,
                    preflight.required_plan_id, preflight.plan_cards_snapshot
             FROM public.analysis_preflights AS preflight
             JOIN public.earlybird_orders AS earlybird_order
               ON earlybird_order.preflight_id = preflight.id
             WHERE earlybird_order.id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'ready',
            target_followers_count: 120,
            target_following_count: 140,
            target_is_private: false,
            capacity_required_plan_id: 'basic',
            required_plan_id: 'basic',
            plan_cards_snapshot: cards,
        });
    });

    it('rebuilds a scrubbed paid checkout preflight from its immutable catalog when no admission snapshot exists', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = NULL,
                 target_following_count = NULL,
                 target_is_private = NULL,
                 capacity_required_plan_id = NULL,
                 required_plan_id = NULL,
                 plan_cards_snapshot = NULL,
                 status = 'expired',
                 created_at = TIMESTAMPTZ '2026-07-01 00:00:00+00',
                 expires_at = TIMESTAMPTZ '2026-07-01 00:30:00+00'
             WHERE id = $1`,
            [PREFLIGHT]
        );

        await expect(asService<FulfillmentIdentity>(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({
                order_id: ORDER,
                fulfillment_status: 'admission_pending',
            })],
        });
        expect((await db.query<{
            status: string;
            capacity_required_plan_id: string;
            required_plan_id: string;
            plan_cards_snapshot: typeof cards;
        }>(
            `SELECT preflight.status, preflight.capacity_required_plan_id, preflight.required_plan_id,
                    preflight.plan_cards_snapshot
             FROM public.analysis_preflights AS preflight
             JOIN public.earlybird_orders AS earlybird_order
               ON earlybird_order.preflight_id = preflight.id
             WHERE earlybird_order.id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'ready',
            capacity_required_plan_id: 'basic',
            required_plan_id: 'basic',
            plan_cards_snapshot: cards,
        });
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflights'
        )).rows[0].count).toBe(2);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_preflights WHERE id = $1',
            [PREFLIGHT]
        )).rows[0]).toEqual({ status: 'expired' });
    });

    it('never rebinds an unconfirmed or non-admissible lifecycle', async () => {
        const blockedOrderStatuses = [
            'payment_pending', 'cancelled', 'refund_pending',
            'analysis_in_progress', 'completed',
        ];
        for (const status of blockedOrderStatuses) {
            await db.query(
                `UPDATE public.earlybird_orders SET status = $2 WHERE id = $1`,
                [ORDER, status]
            );
            const rebound = await asService<{ rebind_expired_paid_earlybird_preflight: string }>(
                'SELECT public.rebind_expired_paid_earlybird_preflight($1)',
                [ORDER]
            );
            expect(rebound.rows[0].rebind_expired_paid_earlybird_preflight).toBe(PREFLIGHT);
            expect((await db.query<{ count: number }>(
                'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflights'
            )).rows[0].count).toBe(1);
        }
        await db.query(
            `UPDATE public.earlybird_orders SET status = 'paid' WHERE id = $1`,
            [ORDER]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review',
                 operator_admitted_at = pg_catalog.clock_timestamp(),
                 manual_review_at = pg_catalog.clock_timestamp()
             WHERE order_id = $1`,
            [ORDER]
        );
        const terminal = await asService<{ rebind_expired_paid_earlybird_preflight: string }>(
            'SELECT public.rebind_expired_paid_earlybird_preflight($1)',
            [ORDER]
        );
        expect(terminal.rows[0].rebind_expired_paid_earlybird_preflight).toBe(PREFLIGHT);
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflights'
        )).rows[0].count).toBe(1);
    });

    it('reproduces both preflight uniqueness guarantees the rebind must satisfy', async () => {
        const indexes = await db.query<{ indexdef: string }>(
            `SELECT indexdef FROM pg_catalog.pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'analysis_preflights'
               AND indexname = ANY($1::TEXT[])
             ORDER BY indexname`,
            [[
                'idx_analysis_preflights_one_active_per_user',
                'idx_analysis_preflights_user_idempotency',
            ]]
        );
        expect(indexes.rows.map(row => row.indexdef)).toEqual([
            expect.stringMatching(
                /CREATE UNIQUE INDEX .*one_active_per_user.*\(user_id\)[\s\S]*WHERE/
            ),
            expect.stringMatching(
                /CREATE UNIQUE INDEX .*user_idempotency.*\(user_id, idempotency_key\)/
            ),
        ]);

        // Both collisions really fire in this fixture, so a rebind that avoids
        // them is proving something.
        const clone = (id: string, key: string, status: string) => db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, idempotency_key, target_instagram_id,
                target_followers_count, target_following_count,
                target_is_private, exclusion_decision, status, access_mode,
                launch_status_snapshot, plan_catalog_snapshot,
                plan_cards_snapshot, pricing_version, pricing_snapshot,
                policy_versions_snapshot, capacity_required_plan_id,
                required_plan_id, created_at, ready_at, expires_at
            )
            SELECT $2, user_id, $3, target_instagram_id,
                target_followers_count, target_following_count,
                target_is_private, exclusion_decision, $4, access_mode,
                launch_status_snapshot, plan_catalog_snapshot,
                plan_cards_snapshot, pricing_version, pricing_snapshot,
                policy_versions_snapshot, capacity_required_plan_id,
                required_plan_id, created_at, ready_at, expires_at
            FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT, id, key, status]
        );

        await expect(clone(
            '133e4567-e89b-42d3-a456-426614174001', 'a-distinct-key', 'ready'
        )).rejects.toThrow(/idx_analysis_preflights_one_active_per_user/);
        await expect(clone(
            '143e4567-e89b-42d3-a456-426614174001', 'test-preflight-key', 'expired'
        )).rejects.toThrow(/idx_analysis_preflights_user_idempotency/);
    });

    it('retires the outgoing preflight and rebinds a paid order that outlived its TTL', async () => {
        await expireBoundPreflight();
        expect((await preflightsByAge()).map(row => row.status)).toEqual([
            'ready',
        ]);

        const rebound = await rebind();

        expect(rebound).not.toBe(PREFLIGHT);
        expect(await boundPreflightId()).toBe(rebound);
        expect(await preflightsByAge()).toEqual([
            {
                id: PREFLIGHT,
                idempotency_key: 'test-preflight-key',
                status: 'expired',
            },
            {
                id: rebound,
                idempotency_key: `earlybird.fulfillment.${ORDER.replace(/-/g, '')}`,
                status: 'ready',
            },
        ]);
    });

    it('rebinds a second time once the replacement itself outlives its TTL', async () => {
        await expireBoundPreflight();
        const first = await rebind();
        expect(first).not.toBe(PREFLIGHT);

        await expireBoundPreflight();
        const second = await rebind();

        expect(second).not.toBe(first);
        expect(await boundPreflightId()).toBe(second);
        const orderHex = ORDER.replace(/-/g, '');
        expect(await preflightsByAge()).toEqual([
            {
                id: PREFLIGHT,
                idempotency_key: 'test-preflight-key',
                status: 'expired',
            },
            {
                id: first,
                idempotency_key: `earlybird.fulfillment.${orderHex}`,
                status: 'expired',
            },
            {
                id: second,
                idempotency_key: `earlybird.fulfillment.${orderHex}.r1`,
                status: 'ready',
            },
        ]);
    });

    it('refuses to rebind a preflight that is still inside its TTL', async () => {
        expect(await rebind()).toBe(PREFLIGHT);
        expect(await preflightsByAge()).toEqual([
            expect.objectContaining({ id: PREFLIGHT, status: 'ready' }),
        ]);
        expect(await boundPreflightId()).toBe(PREFLIGHT);
    });

    it('refuses to rebind an expired preflight that a request already consumed', async () => {
        await expireBoundPreflight();
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version, preflight_id
            ) VALUES ($1, $2, 'sample.account', 'male', 'failed', 100, 'v2', $3)`,
            [FAILED_REQUEST, USER, PREFLIGHT]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2,
                 consumed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT, FAILED_REQUEST]
        );

        await expect(rebind()).rejects.toThrow(
            'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT'
        );
        expect(await preflightsByAge()).toEqual([
            expect.objectContaining({ id: PREFLIGHT, status: 'consumed' }),
        ]);
        expect(await boundPreflightId()).toBe(PREFLIGHT);
    });

    it('stops minting replacements once the order exhausts its rebind cap', async () => {
        const minted: string[] = [];
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await expireBoundPreflight();
            minted.push(await rebind());
        }
        expect(new Set(minted).size).toBe(10);

        const exhausted = await expireBoundPreflight();

        // The eleventh attempt keeps the preflight the order already holds
        // instead of minting, and leaves it exactly as it found it.
        expect(await rebind()).toBe(exhausted);
        expect(await boundPreflightId()).toBe(exhausted);
        const rows = await preflightsByAge();
        expect(rows).toHaveLength(11);
        expect(rows[rows.length - 1]).toEqual({
            id: exhausted,
            idempotency_key: `earlybird.fulfillment.${ORDER.replace(/-/g, '')}.r9`,
            status: 'ready',
        });
        expect(rows.filter(row => row.status === 'ready')).toHaveLength(1);
    });

    it('leaves a scrubbed checkout preflight waiting when the retained admission snapshot is not eligible', async () => {
        const insufficientCards = {
            ...cards,
            basic: {
                ...cards.basic,
                relationshipCapacity: { followers: 119, following: 140 },
            },
        };
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = NULL,
                 target_following_count = NULL,
                 target_is_private = NULL,
                 capacity_required_plan_id = NULL,
                 required_plan_id = NULL,
                 plan_cards_snapshot = NULL,
                 admission_capacity_required_plan_id = 'basic',
                 admission_required_plan_id = 'basic',
                 admission_plan_cards_snapshot = $2::JSONB,
                 status = 'expired',
                 created_at = TIMESTAMPTZ '2026-07-01 00:00:00+00',
                 expires_at = TIMESTAMPTZ '2026-07-01 00:30:00+00'
             WHERE id = $1`,
            [PREFLIGHT, JSON.stringify(insufficientCards)]
        );

        await expect(asService(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
        )).resolves.toMatchObject({ rows: [expect.objectContaining({
            fulfillment_status: 'admission_pending',
        })] });
        expect((await db.query<{
            status: string;
            plan_cards_snapshot: unknown;
        }>(
            `SELECT status, plan_cards_snapshot
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toEqual({
            status: 'expired',
            plan_cards_snapshot: null,
        });
        expect((await db.query<{ status: string }>(
            `SELECT status FROM public.earlybird_fulfillments
             WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({ status: 'admission_pending' });
    });

    it('retains a paid checkout preflight payload through later expiry cleanup', async () => {
        const purged = await asService<{ purge_expired_analysis_v2_preflights: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(20)'
        );
        expect(purged.rows[0].purge_expired_analysis_v2_preflights).toBe(0);
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
            plan_cards_snapshot: typeof cards;
            pii_scrubbed_at: string | null;
        }>(
            `SELECT status, target_instagram_id, plan_cards_snapshot, pii_scrubbed_at
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toMatchObject({
            status: 'ready',
            target_instagram_id: 'sample.account',
            plan_cards_snapshot: cards,
            pii_scrubbed_at: null,
        });
    });

    it('does not auto-admit invalid, refunded, or ambiguous payment rows', async () => {
        await db.query(
            `UPDATE public.earlybird_orders
             SET seller_reference_confirmed_at = NULL
             WHERE id = $1`,
            [ORDER]
        );
        await expect(asService(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
        )).resolves.toMatchObject({ rows: [] });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('awaiting_operator');
    });

    it('does not let old snapshot conflicts starve a later eligible order at the promotion limit', async () => {
        const invalidPreflights = [
            '623e4567-e89b-42d3-a456-426614174001',
            '723e4567-e89b-42d3-a456-426614174001',
        ];
        const invalidOrders = [
            '823e4567-e89b-42d3-a456-426614174001',
            '923e4567-e89b-42d3-a456-426614174001',
        ];
        // Each competing order belongs to its own buyer. One user can only ever
        // hold one active preflight, so cloning them onto a single user would
        // describe a state idx_analysis_preflights_one_active_per_user forbids.
        const invalidUsers = [
            'a23e4567-e89b-42d3-a456-426614174001',
            'b23e4567-e89b-42d3-a456-426614174001',
        ];
        for (let index = 0; index < invalidPreflights.length; index += 1) {
            await db.query(
                'INSERT INTO public.users(id) VALUES ($1)',
                [invalidUsers[index]]
            );
            await db.query(
                `INSERT INTO public.analysis_preflights(
                    id, user_id, idempotency_key, target_instagram_id,
                    target_followers_count, target_following_count,
                    target_is_private, exclusion_decision, status, access_mode,
                    launch_status_snapshot, plan_catalog_snapshot,
                    plan_cards_snapshot, pricing_version, pricing_snapshot,
                    policy_versions_snapshot, capacity_required_plan_id,
                    required_plan_id, created_at, ready_at, expires_at, admission_status
                )
                SELECT $2, $4, 'test-preflight-key' || $3, target_instagram_id || $3,
                    target_followers_count, target_following_count,
                    target_is_private, exclusion_decision, status, 'test',
                    launch_status_snapshot, plan_catalog_snapshot,
                    plan_cards_snapshot, pricing_version, pricing_snapshot,
                    policy_versions_snapshot, capacity_required_plan_id,
                    required_plan_id, created_at, ready_at, expires_at, admission_status
                FROM public.analysis_preflights WHERE id = $1`,
                [
                    PREFLIGHT,
                    invalidPreflights[index],
                    `-invalid-${index}`,
                    invalidUsers[index],
                ]
            );
            await db.query(
                `INSERT INTO public.earlybird_orders(
                    id, user_id, preflight_id, target_instagram_id,
                    target_followers_count, target_following_count,
                    exclusion_decision, plan_id, status,
                    expected_groble_product_id, expected_amount_krw,
                    payment_id, actual_groble_product_id, actual_amount_krw,
                    seller_reference_confirmed_at
                )
                SELECT $2, $5, $3, target_instagram_id || $4,
                    target_followers_count, target_following_count,
                    exclusion_decision, plan_id, status,
                    expected_groble_product_id, expected_amount_krw,
                    payment_id || $4, actual_groble_product_id,
                    actual_amount_krw, seller_reference_confirmed_at
                FROM public.earlybird_orders WHERE id = $1`,
                [
                    ORDER,
                    invalidOrders[index],
                    invalidPreflights[index],
                    `-invalid-${index}`,
                    invalidUsers[index],
                ]
            );
        }
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET created_at = pg_catalog.clock_timestamp() - INTERVAL '1 day'
             WHERE order_id = ANY($1::UUID[])`,
            [invalidOrders]
        );

        const admitted = await asService<FulfillmentIdentity>(
            'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(1)'
        );

        expect(admitted.rows).toEqual([expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
        })]);
        expect((await db.query<{ status: string }>(
            `SELECT status FROM public.earlybird_fulfillments
             WHERE order_id = ANY($1::UUID[]) ORDER BY order_id`,
            [invalidOrders]
        )).rows).toEqual([
            { status: 'awaiting_operator' },
            { status: 'awaiting_operator' },
        ]);
    });

    it('reactivates only the immutable paid preflight after explicit admission', async () => {
        await expect(admit()).resolves.toMatchObject({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
            preflight_id: PREFLIGHT,
            user_id: USER,
            plan_id: 'basic',
            request_id: null,
        });
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
            access_mode: string;
        }>(
            `SELECT status, target_instagram_id, access_mode
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toEqual({
            status: 'ready',
            target_instagram_id: 'sample.account',
            access_mode: 'production',
        });
        expect((await asService<FulfillmentIdentity>(
            'SELECT * FROM public.list_recoverable_earlybird_fulfillments(20)'
        )).rows).toHaveLength(1);
    });

    it('creates one owner-linked production V2 request and safely replays it', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        expect(lease).toMatchObject({
            claimed: true,
            fulfillment_status: 'admission_pending',
            lease_token: CLAIM,
            lease_fence: 1,
            attempt_count: 1,
        });
        const first = (await asService<{
            fulfillment_status: string;
            request_id: string | null;
            created: boolean;
            initial_job_key: string | null;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(first).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            created: true,
            initial_job_key: 'coordinator:bootstrap',
        });
        expect(first.request_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );

        const replay = (await asService<{
            fulfillment_status: string;
            request_id: string | null;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(replay).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            request_id: first.request_id,
            created: false,
        });
        await expect(admit()).resolves.toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            request_id: first.request_id,
        });
        expect((await db.query<{
            count: number;
            access_mode: string;
            user_id: string;
        }>(
            `SELECT pg_catalog.count(*) OVER ()::INTEGER AS count,
                    plan_access_mode_snapshot AS access_mode,
                    user_id::TEXT
             FROM public.analysis_requests`
        )).rows[0]).toEqual({
            count: 1,
            access_mode: 'production',
            user_id: USER,
        });
    });

    it('uses one bounded generation after an exact failed recovery request collision', async () => {
        const baseKey = await seedRecoveredRequestCollision();

        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        const first = (await asService<{
            request_id: string;
            fulfillment_status: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(first).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            created: true,
        });
        expect((await db.query<{
            id: string;
            idempotency_key: string;
            status: string;
            target_instagram_id: string;
        }>(
            `SELECT id, idempotency_key, status, target_instagram_id
             FROM public.analysis_requests
             ORDER BY idempotency_key`
        )).rows).toEqual([
            {
                id: FAILED_REQUEST,
                idempotency_key: baseKey,
                status: 'failed',
                target_instagram_id: canonicalScrubToken(FAILED_REQUEST),
            },
            {
                id: first.request_id,
                idempotency_key: `${baseKey}.r1`,
                status: 'pending',
                target_instagram_id: 'sample.account',
            },
        ]);

        await expect(asService<{
            request_id: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            request_id: first.request_id,
            created: false,
        }] });
    });

    it('also opens r1 while the current preflight is the exact recorded recovery preflight', async () => {
        const baseKey = await seedDirectRecoveredRequestCollision();
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        const created = (await asService<{
            request_id: string;
            fulfillment_status: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(created).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            created: true,
        });
        expect((await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [created.request_id]
        )).rows[0].idempotency_key).toBe(`${baseKey}.r1`);
    });

    it.each([
        [
            'missing receipt',
            `DELETE FROM public.analysis_v2_failure_receipts
             WHERE request_id = $1`,
        ],
        [
            'non-failed source',
            `UPDATE public.analysis_requests SET status = 'completed'
             WHERE id = $1`,
        ],
        [
            'non-v2 source',
            `UPDATE public.analysis_requests SET pipeline_version = 'v1'
             WHERE id = $1`,
        ],
    ])('refuses a recovered key collision with %s', async (
        _case,
        mutation
    ) => {
        await seedRecoveredRequestCollision();
        await db.query(mutation, [FAILED_REQUEST]);
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await expect(asService<{ fulfillment_status: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
        }] });
        expect((await db.query<{ last_error_code: string }>(
            `SELECT last_error_code
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0].last_error_code).toBe('REQUEST_CONFLICT');
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_requests`
        )).rows[0].count).toBe(1);
    });

    it.each([
        {
            shape: 'failed-only',
            status: 'failed',
            runId: 'FailedRun1234',
            actualUsageUsd: 0.2,
            usageReconciledAt: new Date().toISOString(),
        },
        {
            shape: 'starting',
            status: 'starting',
            runId: null,
            actualUsageUsd: null,
            usageReconciledAt: null,
        },
        {
            shape: 'unreconciled succeeded',
            status: 'succeeded',
            runId: 'UnreconciledRun1234',
            actualUsageUsd: null,
            usageReconciledAt: null,
        },
    ])('fails closed before creating a generation for a $shape recovery provider run', async ({
        status,
        runId,
        actualUsageUsd,
        usageReconciledAt,
    }) => {
        await seedRecoveredRequestCollision();
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash, required_job_keys
             ) VALUES (
                $1, 'coordinator:bootstrap', 'coordinator', 'bootstrap',
                $2, '{}'::TEXT[]
             )`,
            [FAILED_REQUEST, 'a'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, usage_reconciled_at
             ) VALUES (
                $1, 'coordinator:bootstrap', $2, $3, $4, $5,
                'apify', 'apify/relationship-scraper', 'secondary',
                1.25, $6, $7, $8, $9
             )`,
            [
                FAILED_REQUEST,
                `relationship-followers:${'b'.repeat(64)}`,
                'c'.repeat(64),
                CLAIM,
                ADMISSION_CLAIM,
                status,
                runId,
                actualUsageUsd,
                usageReconciledAt,
            ]
        );

        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await expect(asService<{
            fulfillment_status: string;
            request_id: string | null;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
            request_id: null,
            created: false,
        }] });
        expect((await db.query<{
            status: string;
            last_error_code: string;
            request_id: string | null;
        }>(
            `SELECT status, last_error_code, request_id
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'manual_review',
            last_error_code: 'PROVIDER_RUN_ADOPTION_REQUIRED',
            request_id: null,
        });
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_requests`
        )).rows[0].count).toBe(1);
    });

    it('creates r1 and adopts one reconciled source run through the live claim and evidence writers', async () => {
        const requestKey = await seedRecoveredRequestCollision();
        const operationKey = `relationship-followers:${'d'.repeat(64)}`;
        const inputHash = 'e'.repeat(64);
        const sourceRunId = 'RecoveredRun1234';
        const sourceJobKey = 'coordinator:bootstrap';
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status
             ) VALUES (
                $1, $2, 'coordinator', 'bootstrap', $3,
                '{}'::TEXT[], 'completed'
             )`,
            [FAILED_REQUEST, sourceJobKey, 'f'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, run_started_at, terminalized_at,
                usage_reconciled_at
             ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify',
                'apify/relationship-scraper', 'secondary', 1.25,
                'succeeded', $7, 0.42,
                pg_catalog.clock_timestamp() - INTERVAL '10 minutes',
                pg_catalog.clock_timestamp() - INTERVAL '9 minutes',
                pg_catalog.clock_timestamp() - INTERVAL '8 minutes'
             )`,
            [
                FAILED_REQUEST,
                sourceJobKey,
                operationKey,
                inputHash,
                CLAIM,
                ADMISSION_CLAIM,
                sourceRunId,
            ]
        );

        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready(
                $1, $2, $3
             ) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(true);
        expect((await db.query<{
            target_instagram_id: string;
            followers_scrubbed: boolean;
            pii_scrubbed: boolean;
        }>(
            `SELECT target_instagram_id,
                    target_followers_count IS NULL AS followers_scrubbed,
                    pii_scrubbed_at >= expires_at AS pii_scrubbed
             FROM public.analysis_preflights WHERE id = $1`,
            [RECOVERY_PREFLIGHT]
        )).rows[0]).toEqual({
            target_instagram_id: canonicalScrubToken(RECOVERY_PREFLIGHT),
            followers_scrubbed: true,
            pii_scrubbed: true,
        });

        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        const created = (await asService<{
            request_id: string;
            fulfillment_status: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(created).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            created: true,
        });
        expect((await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [created.request_id]
        )).rows[0].idempotency_key).toBe(`${requestKey}.r1`);

        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET status = 'processing', lease_token = $3,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE request_id = $1 AND job_key = $2`,
            [created.request_id, sourceJobKey, DISPATCH_TOKEN]
        );
        const resolveArgs = [
            created.request_id,
            sourceJobKey,
            DISPATCH_TOKEN,
            operationKey,
            inputHash,
            'apify',
            'apify/relationship-scraper',
            'secondary',
            1.25,
        ];
        const adopted = (await asService<{ adopted: Record<string, unknown> }>(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, $6, $7, $8, $9
             ) AS adopted`,
            resolveArgs
        )).rows[0].adopted;
        expect(adopted).toMatchObject({
            sourceRequestId: FAILED_REQUEST,
            sourceJobKey,
            operationKey,
            inputHash,
            runId: sourceRunId,
            actualUsageUsd: 0.42,
        });
        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, $6, $7, $8, $9
             )`,
            resolveArgs
        )).resolves.toMatchObject({ rows: [{
            resolve_analysis_v2_recovery_provider_run: adopted,
        }] });
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_recovery_provider_run_adoptions`
        )).rows[0].count).toBe(1);

        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, $6, $7, $8, $9
             ) AS adopted`,
            resolveArgs.map((value, index) => index === 4 ? '0'.repeat(64) : value)
        )).rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE/);
        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, $6, $7, $8, $9
             ) AS adopted`,
            resolveArgs.map((value, index) => (
                index === 3
                    ? `relationship-followers:${'0'.repeat(64)}`
                    : value
            ))
        )).rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_recovery_provider_run_adoptions`
        )).rows[0].count).toBe(1);

        const source = {
            input_hash: inputHash,
            provider: 'apify',
            provider_run_id: sourceRunId,
            provider_operation_key: operationKey,
            provider_credential_slot: 'secondary',
        };
        await expect(asService<{ accepted: boolean }>(
            `SELECT public.checkpoint_analysis_v2_relationship_side(
                $1, $2, $3, 'followers', $4, 120, 'collected',
                'apify', $5, $6, NULL, '[]'::JSONB
             ) AS accepted`,
            [
                created.request_id,
                sourceJobKey,
                DISPATCH_TOKEN,
                inputHash,
                sourceRunId,
                operationKey,
            ]
        )).resolves.toMatchObject({ rows: [{ accepted: true }] });
        await expect(asService<{ accepted: boolean }>(
            `SELECT public.checkpoint_analysis_v2_target_evidence(
                $1, $2, $3, 'sample.account', $4, 'apify', $5, $6,
                $7::JSONB, $7::JSONB, '[]'::JSONB
             ) AS accepted`,
            [
                created.request_id,
                sourceJobKey,
                DISPATCH_TOKEN,
                inputHash,
                sourceRunId,
                operationKey,
                JSON.stringify(source),
            ]
        )).resolves.toMatchObject({ rows: [{ accepted: true }] });
        await expect(asService<{ accepted: boolean }>(
            `SELECT public.checkpoint_analysis_v2_relationship_side(
                $1, $2, $3, 'followers', $4, 120, 'collected',
                'apify', 'ForeignRun1234', $5, NULL, '[]'::JSONB
             ) AS accepted`,
            [
                created.request_id,
                sourceJobKey,
                DISPATCH_TOKEN,
                inputHash,
                operationKey,
            ]
        )).resolves.toMatchObject({ rows: [{ accepted: false }] });
        await expect(db.query(
            `UPDATE public.analysis_v2_recovery_provider_run_adoptions
             SET source_run_id = 'ForeignRun1234'
             WHERE request_id = $1`,
            [created.request_id]
        )).rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IMMUTABLE/);
    });

    it.each([
        [
            'status',
            `UPDATE public.analysis_preflights
             SET admission_status = 'blocked',
                 admission_error_code = 'ANALYSIS_V2_TARGET_PRIVATE'
             WHERE id = $1`,
            [] as unknown[],
        ],
        [
            'selected plan',
            `UPDATE public.analysis_preflights
             SET admission_selected_plan_id = 'standard'
             WHERE id = $1`,
            [] as unknown[],
        ],
        [
            'entitlement hash',
            `UPDATE public.analysis_preflights
             SET admission_entitlement_jti_hash = $2
             WHERE id = $1`,
            ['0'.repeat(64)],
        ],
    ])('rejects retained-admission %s drift before creating a successor', async (
        _field,
        mutation,
        extraParams
    ) => {
        await seedRecoveredRequestCollision();
        const operationKey = `relationship-followers:${'8'.repeat(64)}`;
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status
             ) VALUES (
                $1, 'coordinator:bootstrap', 'coordinator', 'bootstrap', $2,
                '{}'::TEXT[], 'completed'
             )`,
            [FAILED_REQUEST, '7'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, run_started_at, terminalized_at,
                usage_reconciled_at
             ) VALUES (
                $1, 'coordinator:bootstrap', $2, $3, $4, $5, 'apify',
                'apify/relationship-scraper', 'secondary', 1.25,
                'succeeded', 'WitnessRun1234', 0.42,
                pg_catalog.clock_timestamp() - INTERVAL '10 minutes',
                pg_catalog.clock_timestamp() - INTERVAL '9 minutes',
                pg_catalog.clock_timestamp() - INTERVAL '8 minutes'
             )`,
            [
                FAILED_REQUEST,
                operationKey,
                '9'.repeat(64),
                CLAIM,
                ADMISSION_CLAIM,
            ]
        );
        await db.query(mutation, [RECOVERY_PREFLIGHT, ...extraParams]);
        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready(
                $1, $2, $3
             ) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(false);

        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await expect(asService(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
            request_id: null,
            created: false,
        }] });
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_requests
             WHERE idempotency_key LIKE 'earlybird:%r%'`
        )).rows[0].count).toBe(0);
    });

    it('adopts after a second full scrub with legitimate current count drift', async () => {
        const requestKey = await seedRecoveredRequestCollision();
        const operationKey = `relationship-followers:${'1'.repeat(64)}`;
        const inputHash = '2'.repeat(64);
        const sourceRunId = 'FullyScrubbedRun1234';
        const sourceJobKey = 'coordinator:bootstrap';
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status
             ) VALUES (
                $1, $2, 'coordinator', 'bootstrap', $3,
                '{}'::TEXT[], 'completed'
             )`,
            [FAILED_REQUEST, sourceJobKey, '3'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, run_started_at, terminalized_at,
                usage_reconciled_at
             ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify',
                'apify/relationship-scraper', 'secondary', 1.25,
                'succeeded', $7, 0.42,
                pg_catalog.clock_timestamp() - INTERVAL '10 minutes',
                pg_catalog.clock_timestamp() - INTERVAL '9 minutes',
                pg_catalog.clock_timestamp() - INTERVAL '8 minutes'
             )`,
            [
                FAILED_REQUEST,
                sourceJobKey,
                operationKey,
                inputHash,
                CLAIM,
                ADMISSION_CLAIM,
                sourceRunId,
            ]
        );

        await admit();
        await fullyScrubRecoveryAdmissionAndDriftCurrent();
        expect((await db.query<{
            recovery_admission_status: string;
            recovery_admission_count: number | null;
            current_followers: number;
            order_followers: number;
        }>(
            `SELECT recovery.admission_status AS recovery_admission_status,
                    recovery.admission_target_followers_count
                        AS recovery_admission_count,
                    current.target_followers_count AS current_followers,
                    earlybird_order.target_followers_count AS order_followers
             FROM public.earlybird_orders AS earlybird_order
             JOIN public.analysis_preflights AS current
               ON current.id = earlybird_order.preflight_id
             JOIN public.earlybird_schema_failure_recoveries AS lineage
               ON lineage.order_id = earlybird_order.id
             JOIN public.analysis_preflights AS recovery
               ON recovery.id = lineage.recovery_preflight_id
             WHERE earlybird_order.id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            recovery_admission_status: 'idle',
            recovery_admission_count: null,
            current_followers: 180,
            order_followers: 120,
        });
        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready(
                $1, $2, $3
             ) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(true);

        const lease = await claim();
        const created = (await asService<{
            request_id: string;
            fulfillment_status: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(created).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            created: true,
        });
        expect((await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [created.request_id]
        )).rows[0].idempotency_key).toBe(`${requestKey}.r1`);

        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET status = 'processing', lease_token = $3,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE request_id = $1 AND job_key = $2`,
            [created.request_id, sourceJobKey, DISPATCH_TOKEN]
        );
        const adopted = (await asService<{ adopted: Record<string, unknown> }>(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify',
                'apify/relationship-scraper', 'secondary', 1.25
             ) AS adopted`,
            [
                created.request_id,
                sourceJobKey,
                DISPATCH_TOKEN,
                operationKey,
                inputHash,
            ]
        )).rows[0].adopted;
        expect(adopted).toMatchObject({
            sourceRequestId: FAILED_REQUEST,
            operationKey,
            runId: sourceRunId,
        });
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_recovery_provider_run_adoptions`
        )).rows[0].count).toBe(1);
    });

    it('adopts an exact pending/enqueued recovery tombstone', async () => {
        const requestKey = await seedRecoveredRequestCollision();
        const operationKey = `relationship-followers:${'4'.repeat(64)}`;
        const inputHash = '5'.repeat(64);
        const sourceJobKey = 'coordinator:bootstrap';
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status
             ) VALUES ($1, $2, 'coordinator', 'bootstrap', $3, '{}', 'completed')`,
            [FAILED_REQUEST, sourceJobKey, '6'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, run_started_at, terminalized_at,
                usage_reconciled_at
             ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify',
                'apify/relationship-scraper', 'secondary', 1.25,
                'succeeded', 'HybridRun1234', 0.42,
                clock_timestamp() - INTERVAL '10 minutes',
                clock_timestamp() - INTERVAL '9 minutes',
                clock_timestamp() - INTERVAL '8 minutes'
             )`,
            [FAILED_REQUEST, sourceJobKey, operationKey, inputHash, CLAIM, ADMISSION_CLAIM]
        );
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(true);
        const lease = await claim();
        const created = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect((await db.query<{ idempotency_key: string }>(
            'SELECT idempotency_key FROM public.analysis_requests WHERE id = $1',
            [created.request_id]
        )).rows[0].idempotency_key).toBe(`${requestKey}.r1`);
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET status = 'processing', lease_token = $3,
                 lease_expires_at = clock_timestamp() + INTERVAL '5 minutes'
             WHERE request_id = $1 AND job_key = $2`,
            [created.request_id, sourceJobKey, DISPATCH_TOKEN]
        );
        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify',
                'apify/relationship-scraper', 'secondary', 1.25
             )`,
            [created.request_id, sourceJobKey, DISPATCH_TOKEN, operationKey, inputHash]
        )).resolves.toMatchObject({ rows: [{
            resolve_analysis_v2_recovery_provider_run: expect.objectContaining({
                runId: 'HybridRun1234',
            }),
        }] });
    });

    it('cross-adopts one exact-side relationship Dataset after scrubbed count drift', async () => {
        await seedRecoveredRequestCollision();
        const sourceJobKey = 'track:relationships:collect';
        const sourceIdentity = (await db.query<{
            operation_key: string;
            input_hash: string;
        }>(
            `SELECT * FROM public.analysis_v2_relationship_provider_identity(
                'followers', 'sample.account', 120, 'basic', FALSE
             )`
        )).rows[0];
        const actorId =
            'scraping_solutions/instagram-scraper-followers-following-no-cookies';
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status
             ) VALUES ($1, $2, 'relationships', 'collection', $3, '{}', 'completed')`,
            [FAILED_REQUEST, sourceJobKey, '9'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, run_started_at, terminalized_at,
                usage_reconciled_at
             ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify',
                $7, 'secondary', 0.85, 'succeeded', 'CountDriftRun1',
                0.4, clock_timestamp() - INTERVAL '10 minutes',
                clock_timestamp() - INTERVAL '9 minutes',
                clock_timestamp() - INTERVAL '8 minutes'
             )`,
            [
                FAILED_REQUEST,
                sourceJobKey,
                sourceIdentity.operation_key,
                sourceIdentity.input_hash,
                CLAIM,
                ADMISSION_CLAIM,
                actorId,
            ]
        );
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        const lease = await claim();
        const created = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status, lease_token, lease_expires_at
             ) VALUES (
                $1, $2, 'relationships', 'collection', $3, '{}',
                'processing', $4, clock_timestamp() + INTERVAL '5 minutes'
             )`,
            [created.request_id, sourceJobKey, 'a'.repeat(64), DISPATCH_TOKEN]
        );
        const destination = (await db.query<{
            operation_key: string;
            input_hash: string;
        }>(
            `SELECT * FROM public.analysis_v2_relationship_provider_identity(
                'followers', 'sample.account', 180, 'basic', FALSE
             )`
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_preflights
             SET access_mode = 'test_entitlement' WHERE id = $1`,
            [RECOVERY_PREFLIGHT]
        );
        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify', $6, 'secondary', 0.153
             )`,
            [
                created.request_id, sourceJobKey, DISPATCH_TOKEN,
                destination.operation_key, destination.input_hash, actorId,
            ]
        )).rejects.toThrow('ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT');
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_recovery_provider_run_adoptions`
        )).rows[0].count).toBe(0);
        await db.query(
            `UPDATE public.analysis_preflights
             SET access_mode = 'production' WHERE id = $1`,
            [RECOVERY_PREFLIGHT]
        );
        await db.query(
            `INSERT INTO public.users(id) VALUES ($1)`,
            [UNLINKED_USER]
        );
        await db.query(
            `UPDATE public.analysis_preflights SET user_id = $2 WHERE id = $1`,
            [RECOVERY_PREFLIGHT, UNLINKED_USER]
        );
        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify', $6, 'secondary', 0.153
             )`,
            [
                created.request_id, sourceJobKey, DISPATCH_TOKEN,
                destination.operation_key, destination.input_hash, actorId,
            ]
        )).rejects.toThrow('ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT');
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_recovery_provider_run_adoptions`
        )).rows[0].count).toBe(0);
        await db.query(
            `UPDATE public.analysis_preflights SET user_id = $2 WHERE id = $1`,
            [RECOVERY_PREFLIGHT, USER]
        );
        const adopted = (await asService<{ adopted: Record<string, unknown> }>(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify', $6, 'secondary', 0.153
             ) AS adopted`,
            [
                created.request_id,
                sourceJobKey,
                DISPATCH_TOKEN,
                destination.operation_key,
                destination.input_hash,
                actorId,
            ]
        )).rows[0].adopted;
        expect(adopted).toMatchObject({
            operationKey: destination.operation_key,
            inputHash: destination.input_hash,
            runId: 'CountDriftRun1',
        });
        expect((await db.query<{
            operation_key: string;
            source_operation_key: string;
            destination_input_hash: string;
        }>(
            `SELECT operation_key, source_operation_key, destination_input_hash
             FROM public.analysis_v2_recovery_provider_run_adoptions
             WHERE request_id = $1`,
            [created.request_id]
        )).rows[0]).toEqual({
            operation_key: destination.operation_key,
            source_operation_key: sourceIdentity.operation_key,
            destination_input_hash: destination.input_hash,
        });
        expect((await asService<{ accepted: boolean }>(
            `SELECT public.checkpoint_analysis_v2_relationship_side(
                $1, $2, $3, 'followers', $4, 180, 'collected',
                'apify', 'CountDriftRun1', $5, NULL, '[]'::JSONB
             ) AS accepted`,
            [
                created.request_id,
                sourceJobKey,
                DISPATCH_TOKEN,
                destination.input_hash,
                destination.operation_key,
            ]
        )).rows[0].accepted).toBe(true);
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_token = $3
             WHERE request_id = $1 AND job_key = $2`,
            [created.request_id, sourceJobKey, ADMISSION_CLAIM]
        );
        await expect(asService(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify', $6, 'secondary', 0.153
             )`,
            [
                created.request_id, sourceJobKey, DISPATCH_TOKEN,
                destination.operation_key, destination.input_hash, actorId,
            ]
        )).rejects.toThrow('ANALYSIS_V2_PROVIDER_RUN_ADOPTION_FENCE_MISMATCH');
    });

    it('rearms the exact zero-spend r1 failure to r2 and cross-adopts without a new run', async () => {
        const requestKey = await seedRecoveredRequestCollision();
        const jobKey = 'track:relationships:collect';
        const actorId =
            'scraping_solutions/instagram-scraper-followers-following-no-cookies';
        const sourceIdentity = (await db.query<{
            operation_key: string;
            input_hash: string;
        }>(
            `SELECT * FROM public.analysis_v2_relationship_provider_identity(
                'followers', 'sample.account', 120, 'basic', FALSE
             )`
        )).rows[0];
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status
             ) VALUES ($1, $2, 'relationships', 'collection', $3, '{}', 'completed')`,
            [FAILED_REQUEST, jobKey, 'b'.repeat(64)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                job_claim_token, reservation_token, logical_provider,
                actor_id, credential_slot, max_charge_usd, status, run_id,
                actual_usage_usd, usage_reconciled_at
             ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify', $7, 'secondary',
                0.85, 'succeeded', 'RearmSourceRun1', 0.4, clock_timestamp()
             )`,
            [
                FAILED_REQUEST, jobKey, sourceIdentity.operation_key,
                sourceIdentity.input_hash, CLAIM, ADMISSION_CLAIM, actorId,
            ]
        );
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        const firstLease = await claim();
        const r1 = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, firstLease.lease_fence]
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET status = 'completed', attempt_count = 1
             WHERE request_id = $1 AND job_key = 'coordinator:bootstrap'`,
            [r1.request_id]
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash,
                required_job_keys, status, attempt_count, last_error_code
             ) VALUES
             ($1, 'track:relationships:collect', 'relationships', 'collection',
              $2, '{}', 'failed', 1, 'ANALYSIS_V2_JOB_HANDLER_FAILED'),
             ($1, 'track:target-evidence:collect', 'target_evidence', 'collection',
              $3, '{}', 'cancelled', 0, 'REQUEST_TERMINATED')`,
            [r1.request_id, 'c'.repeat(64), 'd'.repeat(64)]
        );
        const manualReviewAt = '2031-01-02T03:04:05.000Z';
        await db.query(
            `UPDATE public.analysis_requests
             SET status = 'failed',
                 error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED',
                 target_instagram_id = 'retained.' || substr(replace(id::TEXT, '-', ''), 1, 20)
             WHERE id = $1`,
            [r1.request_id]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_instagram_id = 'retained.' || substr(replace(id::TEXT, '-', ''), 1, 20),
                 exclusion_decision = 'skip', excluded_instagram_id = NULL,
                 pii_scrubbed_at = clock_timestamp()
             WHERE consumed_request_id = $1`,
            [r1.request_id]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'ANALYSIS_V2_JOB_HANDLER_FAILED')`,
            [r1.request_id]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review', request_id = $1, attempt_count = 5,
                 last_error_code = 'ANALYSIS_FAILED',
                 manual_review_at = $2::TIMESTAMPTZ
             WHERE order_id = $3`,
            [r1.request_id, manualReviewAt, ORDER]
        );
        const rearmed = (await asService<{
            preflight_id: string;
            fulfillment_status: string;
        }>(
            `SELECT * FROM public.rearm_earlybird_zero_spend_adoption_policy_failure(
                $1, $2, $3::TIMESTAMPTZ
             )`,
            [ORDER, r1.request_id, manualReviewAt]
        )).rows[0];
        expect(rearmed.fulfillment_status).toBe('admission_pending');
        expect((await asService(
            `SELECT * FROM public.rearm_earlybird_zero_spend_adoption_policy_failure(
                $1, $2, $3::TIMESTAMPTZ
             )`,
            [ORDER, r1.request_id, manualReviewAt]
        )).rows[0]).toMatchObject({ preflight_id: rearmed.preflight_id });
        await expect(asService(
            `SELECT * FROM public.rearm_earlybird_zero_spend_adoption_policy_failure(
                $1, $2, ($3::TIMESTAMPTZ + INTERVAL '1 second')
             )`,
            [ORDER, r1.request_id, manualReviewAt]
        )).rejects.toThrow('EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_CONFLICT');
        await expect(db.query(
            `UPDATE public.earlybird_adoption_policy_failure_rearms
             SET expected_fulfillment_attempt_count = 4 WHERE order_id = $1`,
            [ORDER]
        )).rejects.toThrow(
            'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_IMMUTABLE'
        );

        await makeAdmissionReady(rearmed.preflight_id, 180, 190);
        const r2Lease = await claim();
        const r2 = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
             )`,
            [ORDER, CLAIM, r2Lease.lease_fence]
        )).rows[0];
        expect((await db.query<{ idempotency_key: string }>(
            'SELECT idempotency_key FROM public.analysis_requests WHERE id = $1',
            [r2.request_id]
        )).rows[0].idempotency_key).toBe(`${requestKey}.r2`);
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, track, kind, input_hash, required_job_keys,
                status, lease_token, lease_expires_at
             ) VALUES (
                $1, $2, 'relationships', 'collection', $3, '{}',
                'processing', $4, clock_timestamp() + INTERVAL '5 minutes'
             )`,
            [r2.request_id, jobKey, 'e'.repeat(64), DISPATCH_TOKEN]
        );
        const destination = (await db.query<{
            operation_key: string;
            input_hash: string;
        }>(
            `SELECT * FROM public.analysis_v2_relationship_provider_identity(
                'followers', 'sample.account', 180, 'basic', FALSE
             )`
        )).rows[0];
        const adopted = (await asService<{ adopted: { runId: string } }>(
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                $1, $2, $3, $4, $5, 'apify', $6, 'secondary', 0.153
             ) AS adopted`,
            [
                r2.request_id, jobKey, DISPATCH_TOKEN,
                destination.operation_key, destination.input_hash, actorId,
            ]
        )).rows[0].adopted;
        expect(adopted.runId).toBe('RearmSourceRun1');
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs WHERE request_id IN ($1, $2)`,
            [r1.request_id, r2.request_id]
        )).rows[0].count).toBe(0);
    });

    it.each([
        [
            'status',
            `UPDATE public.analysis_preflights
             SET admission_status = 'processing',
                 admission_claim_token = $2,
                 admission_lease_expires_at = clock_timestamp() + INTERVAL '1 minute'
             WHERE id = $1`,
            [RECOVERY_PREFLIGHT, CLAIM] as unknown[],
        ],
        [
            'selected plan',
            `UPDATE public.analysis_preflights
             SET admission_selected_plan_id = 'standard'
             WHERE id = $1`,
            [RECOVERY_PREFLIGHT] as unknown[],
        ],
        [
            'entitlement hash',
            `UPDATE public.analysis_preflights
             SET admission_entitlement_jti_hash = $2
             WHERE id = $1`,
            [RECOVERY_PREFLIGHT, '0'.repeat(64)] as unknown[],
        ],
        [
            'dispatch state',
            `UPDATE public.analysis_preflights
             SET admission_dispatch_state = 'reserved',
                 admission_dispatched_at = NULL
             WHERE id = $1`,
            [RECOVERY_PREFLIGHT] as unknown[],
        ],
    ])('rejects pending/enqueued hybrid %s drift', async (_field, mutation, params) => {
        await seedRecoveredRequestCollision();
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        await db.query(mutation, params);
        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(false);
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_requests
             WHERE idempotency_key LIKE 'earlybird:%r%'`
        )).rows[0].count).toBe(0);
    });

    it('rejects pending/enqueued hybrid timestamp-order drift at the row constraint', async () => {
        await seedRecoveredRequestCollision();
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        await expect(db.query(
            `UPDATE public.analysis_preflights
             SET admission_dispatch_reserved_at =
                    admission_dispatched_at + INTERVAL '1 second'
             WHERE id = $1`,
            [RECOVERY_PREFLIGHT]
        )).rejects.toThrow(/analysis_preflights_admission_time_check/);
    });

    it.each([
        ['token', 'admission_token = NULL'],
        ['requested time', 'admission_requested_at = NULL'],
        ['unexpected refresh', 'admission_refreshed_at = clock_timestamp()'],
    ])('rejects pending/enqueued hybrid missing %s in readiness', async (
        _field,
        assignment
    ) => {
        await seedRecoveredRequestCollision();
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        await db.query(
            `UPDATE public.analysis_preflights SET ${assignment} WHERE id = $1`,
            [RECOVERY_PREFLIGHT]
        );
        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(false);
    });

    it.each([
        ['dispatch token', 'admission_dispatch_token = NULL'],
        ['dispatch time', 'admission_dispatched_at = NULL'],
    ])('rejects pending/enqueued hybrid missing %s at the row constraint', async (
        _field,
        assignment
    ) => {
        await seedRecoveredRequestCollision();
        await admit();
        await pendingDispatchRecoveryAdmissionAndDriftCurrent();
        await expect(db.query(
            `UPDATE public.analysis_preflights SET ${assignment} WHERE id = $1`,
            [RECOVERY_PREFLIGHT]
        )).rejects.toThrow(/analysis_preflights_admission_/);
    });

    it.each([
        [
            'retained sentinel',
            `UPDATE public.analysis_preflights
             SET target_instagram_id = 'retained.notcanonical'
             WHERE id = $1`,
            [RECOVERY_PREFLIGHT] as unknown[],
        ],
        [
            'immutable snapshot',
            `UPDATE public.analysis_preflights
             SET pricing_version = 'different'
             WHERE id = $1`,
            [PREFLIGHT] as unknown[],
        ],
        [
            'current cards',
            `UPDATE public.analysis_preflights
             SET plan_cards_snapshot = $2::JSONB
             WHERE id = $1`,
            [PREFLIGHT, JSON.stringify(standardRequiredCards)] as unknown[],
        ],
        [
            'current admission parity',
            `UPDATE public.analysis_preflights
             SET admission_selected_plan_id = 'standard'
             WHERE id = $1`,
            [PREFLIGHT] as unknown[],
        ],
        [
            'selected-card order capacity',
            `UPDATE public.earlybird_orders
             SET target_followers_count = 401
             WHERE id = $1`,
            [ORDER] as unknown[],
        ],
        [
            'failure receipt',
            `UPDATE public.analysis_v2_failure_receipts
             SET error_code = 'ANALYSIS_V2_JOB_ATTEMPTS_EXHAUSTED'
             WHERE request_id = $1`,
            [FAILED_REQUEST] as unknown[],
        ],
    ])('rejects fully scrubbed %s drift', async (_field, mutation, params) => {
        await seedRecoveredRequestCollision();
        await admit();
        await fullyScrubRecoveryAdmissionAndDriftCurrent();
        await db.query(mutation, params);
        expect((await db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready(
                $1, $2, $3
             ) AS ready`,
            [ORDER, FAILED_REQUEST, PREFLIGHT]
        )).rows[0].ready).toBe(false);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_requests
             WHERE idempotency_key LIKE 'earlybird:%r%'`
        )).rows[0].count).toBe(0);
    });

    it('refuses an unproven recovery descendant instead of opening the suffix namespace', async () => {
        await seedRecoveredRequestCollision();
        await db.query(
            `UPDATE public.analysis_preflights
             SET idempotency_key = 'unrelated.ready.preflight'
             WHERE id = $1`,
            [PREFLIGHT]
        );

        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await expect(asService<{ fulfillment_status: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
        }] });
        expect((await db.query<{ last_error_code: string }>(
            `SELECT last_error_code
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0].last_error_code).toBe('REQUEST_CONFLICT');
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_requests`
        )).rows[0].count).toBe(1);
    });

    it('stops before request generation ten without mutating the failed source', async () => {
        const baseKey = await seedRecoveredRequestCollision();
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                error_message, progress, idempotency_key, pipeline_version
             )
             SELECT extensions.gen_random_uuid(), $1, 'retained.capped',
                'male', 'failed', 'JOB_ATTEMPTS_EXHAUSTED', 100,
                $2 || '.r' || generation::TEXT, 'v2'
             FROM pg_catalog.generate_series(1, 9) AS generation`,
            [USER, baseKey]
        );

        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await expect(asService<{ fulfillment_status: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
        }] });
        expect((await db.query<{
            last_error_code: string;
            request_id: string | null;
        }>(
            `SELECT last_error_code, request_id
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            last_error_code: 'REQUEST_IDEMPOTENCY_EXHAUSTED',
            request_id: null,
        });
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
        }>(
            `SELECT status, target_instagram_id
             FROM public.analysis_requests WHERE id = $1`,
            [FAILED_REQUEST]
        )).rows[0]).toEqual({
            status: 'failed',
            target_instagram_id: canonicalScrubToken(FAILED_REQUEST),
        });
    });

    it('reopens only a post-claim stale admission and creates exactly one request after refresh', async () => {
        await admit();
        await makeAdmissionReady();
        const staleLease = await claim();
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_refreshed_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes 1 second'
             WHERE id = $1`,
            [PREFLIGHT]
        );

        await expect(asService<{
            fulfillment_status: string;
            request_id: string | null;
            created: boolean;
        }>(
            'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
            [ORDER, CLAIM, staleLease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'retryable_failure',
            request_id: null,
            created: false,
        }] });
        const staleRaceFulfillment = (await db.query<{
            status: string;
            lease_token: string | null;
            lease_expires_at: string | null;
            request_id: string | null;
            manual_review_at: string | null;
            last_error_code: string | null;
            last_error_at: string | null;
            next_attempt_at: string | null;
            attempt_count: number;
        }>(
            `SELECT status, lease_token, lease_expires_at, request_id, manual_review_at,
                    last_error_code, last_error_at, next_attempt_at, attempt_count
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0];
        expect(staleRaceFulfillment).toMatchObject({
            status: 'retryable_failure',
            lease_token: null,
            lease_expires_at: null,
            request_id: null,
            manual_review_at: null,
            last_error_code: 'ADMISSION_FRESHNESS_EXPIRED',
            attempt_count: 1,
        });
        expect(staleRaceFulfillment.next_attempt_at).toEqual(
            staleRaceFulfillment.last_error_at
        );
        expect((await asService<FulfillmentIdentity>(
            'SELECT * FROM public.list_recoverable_earlybird_fulfillments(20)'
        )).rows).toEqual([expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'retryable_failure',
        })]);

        await makeAdmissionReady();
        const freshLease = await claim();
        const created = (await asService<{
            request_id: string;
            fulfillment_status: string;
            created: boolean;
        }>(
            'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
            [ORDER, CLAIM, freshLease.lease_fence]
        )).rows[0];
        expect(created).toMatchObject({
            fulfillment_status: 'analysis_in_progress', created: true,
        });
        await expect(asService<{
            request_id: string;
            created: boolean;
        }>(
            'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
            [ORDER, CLAIM, freshLease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            request_id: created.request_id,
            created: false,
        }] });
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_requests'
        )).rows[0].count).toBe(1);
    });

    it('does not expire an admission exactly on the two-minute lower boundary', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await db.exec(`
            CREATE OR REPLACE FUNCTION public.earlybird_fulfillment_clock()
            RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql VOLATILE
            AS $$ SELECT TIMESTAMPTZ '2026-01-01 00:00:00+00' $$;
        `);
        try {
            await db.query(
                `UPDATE public.analysis_preflights
                 SET admission_refreshed_at = TIMESTAMPTZ '2025-12-31 23:58:00+00'
                 WHERE id = $1`,
                [PREFLIGHT]
            );
            await expect(asService<{ fulfillment_status: string }>(
                'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
                [ORDER, CLAIM, lease.lease_fence]
            )).resolves.toMatchObject({ rows: [{
                fulfillment_status: 'analysis_in_progress',
            }] });
        } finally {
            await db.exec(`
                CREATE OR REPLACE FUNCTION public.earlybird_fulfillment_clock()
                RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql VOLATILE
                AS $$ SELECT pg_catalog.clock_timestamp() $$;
            `);
        }
    });

    it('does not reject an admission exactly on the thirty-second upper boundary', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await db.exec(`
            CREATE OR REPLACE FUNCTION public.earlybird_fulfillment_clock()
            RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql VOLATILE
            AS $$ SELECT TIMESTAMPTZ '2026-01-01 00:00:00+00' $$;
        `);
        try {
            await db.query(
                `UPDATE public.analysis_preflights
                 SET admission_refreshed_at = TIMESTAMPTZ '2026-01-01 00:00:30+00'
                 WHERE id = $1`,
                [PREFLIGHT]
            );
            await expect(asService<{ fulfillment_status: string }>(
                'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
                [ORDER, CLAIM, lease.lease_fence]
            )).resolves.toMatchObject({ rows: [{
                fulfillment_status: 'analysis_in_progress',
            }] });
        } finally {
            await db.exec(`
                CREATE OR REPLACE FUNCTION public.earlybird_fulfillment_clock()
                RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql VOLATILE
                AS $$ SELECT pg_catalog.clock_timestamp() $$;
            `);
        }
    });

    it('never reopens null, future, fresh, or immutable conflicting admissions', async () => {
        const cases = [
            { sql: 'NULL::TIMESTAMPTZ', expectedStatus: 'manual_review', code: 'SNAPSHOT_CONFLICT' },
            { sql: "pg_catalog.clock_timestamp() + INTERVAL '31 seconds'", expectedStatus: 'manual_review', code: 'SNAPSHOT_CONFLICT' },
            { sql: 'pg_catalog.clock_timestamp()', expectedStatus: 'analysis_in_progress', code: null },
        ];
        for (const testCase of cases) {
            await admit();
            await makeAdmissionReady();
            const lease = await claim();
            await db.exec(
                `UPDATE public.analysis_preflights SET admission_refreshed_at = ${testCase.sql}
                 WHERE id = '${PREFLIGHT}'`
            );
            await expect(asService<{ fulfillment_status: string }>(
                'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
                [ORDER, CLAIM, lease.lease_fence]
            )).resolves.toMatchObject({ rows: [{
                fulfillment_status: testCase.expectedStatus,
            }] });
            expect((await db.query<{ last_error_code: string | null }>(
                'SELECT last_error_code FROM public.earlybird_fulfillments WHERE order_id = $1',
                [ORDER]
            )).rows[0].last_error_code).toBe(testCase.code);
            await db.query(
                `UPDATE public.earlybird_fulfillments
                 SET status = 'admission_pending', lease_token = NULL,
                     lease_expires_at = NULL, last_error_code = NULL,
                     last_error_at = NULL, manual_review_at = NULL
                 WHERE order_id = $1`,
                [ORDER]
            );
        }
    });

    it.each([
        ['target', "UPDATE public.analysis_preflights SET target_instagram_id = 'other.account' WHERE id = $1", 'SNAPSHOT_CONFLICT'],
        ['exclusion', "UPDATE public.analysis_preflights SET exclusion_decision = 'exclude', excluded_instagram_id = 'other.account' WHERE id = $1", 'SNAPSHOT_CONFLICT'],
        ['payment', 'UPDATE public.earlybird_orders SET actual_amount_krw = expected_amount_krw + 1 WHERE preflight_id = $1', 'SNAPSHOT_CONFLICT'],
        ['card', "UPDATE public.analysis_preflights SET plan_cards_snapshot = jsonb_set(plan_cards_snapshot, '{basic,launchStatus}', '\"test_only\"'), admission_plan_cards_snapshot = jsonb_set(admission_plan_cards_snapshot, '{basic,launchStatus}', '\"test_only\"') WHERE id = $1", 'PLAN_NOT_ALLOWED'],
    ])('keeps a changed %s invariant in manual review instead of reopening it', async (
        _name,
        mutation,
        expectedCode
    ) => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await db.query(mutation, [PREFLIGHT]);
        await expect(asService<{ fulfillment_status: string }>(
            'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
        }] });
        expect((await db.query<{ last_error_code: string }>(
            'SELECT last_error_code FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].last_error_code).toBe(expectedCode);
    });

    it.each([
        ['payment evidence', 'UPDATE public.earlybird_orders SET actual_amount_krw = expected_amount_krw + 1 WHERE id = $1', ORDER],
        ['card', "UPDATE public.analysis_preflights SET plan_cards_snapshot = jsonb_set(plan_cards_snapshot, '{basic,launchStatus}', '\"test_only\"') WHERE id = $1", PREFLIGHT],
        ['capacity', 'UPDATE public.analysis_preflights SET target_followers_count = 200 WHERE id = $1', PREFLIGHT],
    ])('rejects a legacy freshness recovery with changed %s evidence without mutation', async (
        _name,
        mutation,
        mutationId
    ) => {
        const manualReviewAt = await seedLegacyStaleSnapshotConflict();
        await db.query(mutation, [mutationId]);
        await expect(asService(
            `SELECT * FROM public.recover_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/EARLYBIRD_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT/);
        expect((await db.query<{
            status: string;
            manual_review_at: string;
            last_error_code: string;
        }>(
            `SELECT status, manual_review_at, last_error_code
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'manual_review',
            manual_review_at: manualReviewAt,
            last_error_code: 'SNAPSHOT_CONFLICT',
        });
    });

    it('accepts only capacity-safe profile-count drift in a legacy freshness recovery', async () => {
        const manualReviewAt = await seedLegacyStaleSnapshotConflict();
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 200, target_following_count = 220,
                 admission_target_followers_count = 200,
                 admission_target_following_count = 220
             WHERE id = $1`,
            [PREFLIGHT]
        );
        await expect(asService<{
            fulfillment_status: string;
        }>(
            `SELECT * FROM public.recover_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'retryable_failure',
        }] });
    });

    it('creates for capacity-safe refreshed profile-count drift without changing the paid order', async () => {
        await admit();
        await makeAdmissionReady();
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 200, target_following_count = 220,
                 admission_target_followers_count = 200,
                 admission_target_following_count = 220
             WHERE id = $1`,
            [PREFLIGHT]
        );
        const lease = await claim();
        await expect(asService<{
            fulfillment_status: string;
        }>(
            'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'analysis_in_progress',
        }] });
        expect((await db.query<{
            target_followers_count: number;
            target_following_count: number;
        }>(
            `SELECT target_followers_count, target_following_count
             FROM public.earlybird_orders WHERE id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            target_followers_count: 120,
            target_following_count: 140,
        });
    });

    it('keeps an unwitnessed profile-count mutation in manual review', async () => {
        await admit();
        await makeAdmissionReady();
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 200, target_following_count = 220
             WHERE id = $1`,
            [PREFLIGHT]
        );
        const lease = await claim();
        await expect(asService<{ fulfillment_status: string }>(
            'SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)',
            [ORDER, CLAIM, lease.lease_fence]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'manual_review',
        }] });
        expect((await db.query<{ last_error_code: string }>(
            'SELECT last_error_code FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].last_error_code).toBe('SNAPSHOT_CONFLICT');
    });

    it('recovers one legacy stale snapshot conflict with a manual-review CAS', async () => {
        await admit();
        await makeAdmissionReady();
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_refreshed_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes 1 second'
             WHERE id = $1`,
            [PREFLIGHT]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review', lease_token = NULL, lease_expires_at = NULL,
                 last_error_code = 'SNAPSHOT_CONFLICT',
                 manual_review_at = pg_catalog.clock_timestamp()
             WHERE order_id = $1`,
            [ORDER]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'expired', expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE id = $1`,
            [PREFLIGHT]
        );
        const manualReviewAt = (await db.query<{ manual_review_at: string }>(
            'SELECT manual_review_at FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].manual_review_at;

        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version
            ) VALUES ($1, $2, 'other.account', 'male', 'pending', 0, 'v2')`,
            [ACTIVE_REQUEST, USER]
        );
        await expect(asService(
            `SELECT * FROM public.recover_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/EARLYBIRD_FRESHNESS_RECOVERY_ACTIVE_REQUEST_CONFLICT/);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('manual_review');
        await db.query('DELETE FROM public.analysis_requests WHERE id = $1', [
            ACTIVE_REQUEST,
        ]);

        await expect(asService(
            `SELECT * FROM public.recover_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, '2026-01-01T00:00:00.000Z']
        )).rejects.toThrow(/EARLYBIRD_FRESHNESS_RECOVERY_CAS_MISMATCH/);
        await expect(asService<{
            fulfillment_status: string;
            preflight_id: string;
        }>(
            `SELECT * FROM public.recover_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).resolves.toMatchObject({ rows: [{
            fulfillment_status: 'retryable_failure', preflight_id: PREFLIGHT,
        }] });
        expect((await db.query<{
            status: string;
            manual_review_at: string | null;
            last_error_code: string;
        }>(
            `SELECT status, manual_review_at, last_error_code
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'retryable_failure',
            manual_review_at: null,
            last_error_code: 'ADMISSION_FRESHNESS_EXPIRED',
        });
        await expect(asService(
            `SELECT * FROM public.recover_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/EARLYBIRD_FRESHNESS_RECOVERY_STATE_INVALID/);
    });

    it('retires linked expiry evidence without scrubbing it and fully scrubs only unlinked expiry', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET created_at = TIMESTAMPTZ '2020-01-01 00:00:00+00',
                 ready_at = TIMESTAMPTZ '2020-01-01 00:00:00+00',
                 expires_at = TIMESTAMPTZ '2020-01-01 00:30:00+00'
             WHERE id = $1`,
            [PREFLIGHT]
        );
        const created = (await asService<{
            preflight_id: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                $1, 'owner@example.com', 'email', 'fresh.account',
                'fresh-linked-key-0001', 'production',
                $2::JSONB, $3::JSONB, 'deferred', $4::JSONB, $5::JSONB
            )`,
            [
                USER,
                JSON.stringify({
                    basic: 'production',
                    standard: 'production',
                    plus: 'test_only',
                }),
                JSON.stringify(catalog),
                JSON.stringify({
                    basic: { status: 'deferred' },
                    standard: { status: 'deferred' },
                    plus: { status: 'deferred' },
                }),
                JSON.stringify({ pipeline: 'v2', risk: 'v1', aiStage: 'v1' }),
            ]
        )).rows[0];
        expect(created.created).toBe(true);
        expect(created.preflight_id).not.toBe(PREFLIGHT);
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
            target_followers_count: number;
            plan_cards_snapshot: object;
            pii_scrubbed_at: string | null;
        }>(
            `SELECT status, target_instagram_id, target_followers_count,
                    plan_cards_snapshot, pii_scrubbed_at
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toEqual({
            status: 'expired',
            target_instagram_id: 'sample.account',
            target_followers_count: 120,
            plan_cards_snapshot: cards,
            pii_scrubbed_at: null,
        });

        await db.query('INSERT INTO public.users(id) VALUES ($1)', [UNLINKED_USER]);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, idempotency_key, target_instagram_id, status,
                exclusion_decision, access_mode, launch_status_snapshot,
                plan_catalog_snapshot, pricing_version, pricing_snapshot,
                policy_versions_snapshot, created_at, updated_at, expires_at
             ) VALUES (
                $1, $2, 'expired-unlinked-key', 'unlinked.account', 'pending',
                'pending', 'production', $3::JSONB, $4::JSONB, 'deferred',
                $5::JSONB, $6::JSONB, TIMESTAMPTZ '2020-01-01 00:00:00+00',
                TIMESTAMPTZ '2020-01-01 00:00:00+00',
                TIMESTAMPTZ '2020-01-01 00:30:00+00'
             )`,
            [
                UNLINKED_PREFLIGHT,
                UNLINKED_USER,
                JSON.stringify({
                    basic: 'production',
                    standard: 'production',
                    plus: 'test_only',
                }),
                JSON.stringify(catalog),
                JSON.stringify({
                    basic: { status: 'deferred' },
                    standard: { status: 'deferred' },
                    plus: { status: 'deferred' },
                }),
                JSON.stringify({ pipeline: 'v2', risk: 'v1', aiStage: 'v1' }),
            ]
        );
        await asService(
            `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                $1, 'unlinked@example.com', 'email', 'next.account',
                'fresh-unlinked-key-01', 'production',
                $2::JSONB, $3::JSONB, 'deferred', $4::JSONB, $5::JSONB
            )`,
            [
                UNLINKED_USER,
                JSON.stringify({
                    basic: 'production',
                    standard: 'production',
                    plus: 'test_only',
                }),
                JSON.stringify(catalog),
                JSON.stringify({
                    basic: { status: 'deferred' },
                    standard: { status: 'deferred' },
                    plus: { status: 'deferred' },
                }),
                JSON.stringify({ pipeline: 'v2', risk: 'v1', aiStage: 'v1' }),
            ]
        );
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
            target_followers_count: number | null;
            plan_cards_snapshot: object | null;
            pii_scrubbed_at: string | null;
        }>(
            `SELECT status, target_instagram_id, target_followers_count,
                    plan_cards_snapshot, pii_scrubbed_at
             FROM public.analysis_preflights WHERE id = $1`,
            [UNLINKED_PREFLIGHT]
        )).rows[0]).toEqual({
            status: 'expired',
            target_instagram_id: 'retained.b23e4567e89b42d3a456',
            target_followers_count: null,
            plan_cards_snapshot: null,
            pii_scrubbed_at: expect.any(Date),
        });
    });

    it('atomically rebinds the exact scrubbed freshness tombstone once', async () => {
        const manualReviewAt = await seedScrubbedStaleSnapshotConflict();
        const recovered = (await asService<{
            fulfillment_status: string;
            preflight_id: string;
        }>(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rows[0];
        expect(recovered).toMatchObject({
            fulfillment_status: 'retryable_failure',
        });
        expect(recovered.preflight_id).not.toBe(PREFLIGHT);
        expect(await boundPreflightId()).toBe(recovered.preflight_id);
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
            admission_status: string;
            admission_refreshed_at: string | null;
            consumed_request_id: string | null;
        }>(
            `SELECT status, target_instagram_id, admission_status,
                    admission_refreshed_at, consumed_request_id
             FROM public.analysis_preflights WHERE id = $1`,
            [recovered.preflight_id]
        )).rows[0]).toEqual({
            status: 'ready',
            target_instagram_id: 'sample.account',
            admission_status: 'idle',
            admission_refreshed_at: null,
            consumed_request_id: null,
        });
        await expect(asService(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_STATE_INVALID/);
    });

    it('rebinds witnessed cross-tier drift using order-count canonical primary cards', async () => {
        const manualReviewAt = await seedScrubbedStaleSnapshotConflict();
        await db.query(
            `UPDATE public.earlybird_orders
             SET plan_id = 'standard',
                 expected_groble_product_id = 'standard-product',
                 actual_groble_product_id = 'standard-product',
                 expected_amount_krw = 29900,
                 actual_amount_krw = 29900
             WHERE id = $1`,
            [ORDER]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_selected_plan_id = 'standard',
                 admission_target_followers_count = 500,
                 admission_target_following_count = 500,
                 admission_capacity_required_plan_id = 'standard',
                 admission_required_plan_id = 'standard',
                 admission_plan_cards_snapshot = $2::JSONB
             WHERE id = $1`,
            [PREFLIGHT, JSON.stringify(standardRequiredCards)]
        );
        const recovered = (await asService<{ preflight_id: string }>(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rows[0];
        expect((await db.query<{
            capacity_required_plan_id: string;
            required_plan_id: string;
            plan_cards_snapshot: object;
        }>(
            `SELECT capacity_required_plan_id, required_plan_id,
                    plan_cards_snapshot
             FROM public.analysis_preflights WHERE id = $1`,
            [recovered.preflight_id]
        )).rows[0]).toEqual({
            capacity_required_plan_id: 'basic',
            required_plan_id: 'basic',
            plan_cards_snapshot: cards,
        });
    });

    it('rejects a cross-tier witness whose retained canonical cards were altered', async () => {
        const manualReviewAt = await seedScrubbedStaleSnapshotConflict();
        await db.query(
            `UPDATE public.earlybird_orders
             SET plan_id = 'standard',
                 expected_groble_product_id = 'standard-product',
                 actual_groble_product_id = 'standard-product'
             WHERE id = $1`,
            [ORDER]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_selected_plan_id = 'standard',
                 admission_target_followers_count = 500,
                 admission_target_following_count = 500,
                 admission_capacity_required_plan_id = 'standard',
                 admission_required_plan_id = 'standard',
                 admission_plan_cards_snapshot = $2::JSONB
             WHERE id = $1`,
            [PREFLIGHT, JSON.stringify(cards)]
        );
        await expect(asService(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT/);
        expect(await boundPreflightId()).toBe(PREFLIGHT);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('manual_review');
    });

    it.each([
        ['payment evidence', 'UPDATE public.earlybird_orders SET actual_amount_krw = expected_amount_krw + 1 WHERE id = $1', ORDER],
        ['tombstone target', "UPDATE public.analysis_preflights SET target_instagram_id = 'retained.notcanonical' WHERE id = $1", PREFLIGHT],
        ['admission evidence', "UPDATE public.analysis_preflights SET admission_required_plan_id = 'standard' WHERE id = $1", PREFLIGHT],
        ['capacity', 'UPDATE public.analysis_preflights SET admission_target_followers_count = 401 WHERE id = $1', PREFLIGHT],
    ])('rolls back scrubbed recovery when %s changed', async (
        _name,
        mutation,
        mutationId
    ) => {
        const manualReviewAt = await seedScrubbedStaleSnapshotConflict();
        await db.query(mutation, [mutationId]);
        await expect(asService(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT/);
        expect((await db.query<{ status: string; preflight_id: string }>(
            `SELECT fulfillment.status, earlybird_order.preflight_id
             FROM public.earlybird_fulfillments AS fulfillment
             JOIN public.earlybird_orders AS earlybird_order
               ON earlybird_order.id = fulfillment.order_id
             WHERE fulfillment.order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'manual_review',
            preflight_id: PREFLIGHT,
        });
    });

    it('rejects active work and stale CAS without mutating the scrubbed order', async () => {
        const manualReviewAt = await seedScrubbedStaleSnapshotConflict();
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version
             ) VALUES ($1, $2, 'other.account', 'male', 'pending', 0, 'v2')`,
            [ACTIVE_REQUEST, USER]
        );
        await expect(asService(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/ACTIVE_REQUEST_CONFLICT/);
        await db.query('DELETE FROM public.analysis_requests WHERE id = $1', [
            ACTIVE_REQUEST,
        ]);
        await expect(asService(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, TIMESTAMPTZ '2020-01-01 00:00:00+00'
            )`,
            [ORDER]
        )).rejects.toThrow(/CAS_MISMATCH/);
        expect(await boundPreflightId()).toBe(PREFLIGHT);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('manual_review');
    });

    it('rolls back the retryable transition when the capped rebind refuses', async () => {
        const manualReviewAt = await seedScrubbedStaleSnapshotConflict();
        for (let generation = 0; generation < 10; generation += 1) {
            const suffix = generation === 0 ? '' : `.r${generation}`;
            await db.query(
                `INSERT INTO public.analysis_preflights(
                    id, user_id, idempotency_key, target_instagram_id, status,
                    exclusion_decision, access_mode, launch_status_snapshot,
                    plan_catalog_snapshot, pricing_version, pricing_snapshot,
                    policy_versions_snapshot, created_at, updated_at, expires_at
                 ) VALUES (
                    extensions.gen_random_uuid(), $1, $2, 'retired.account',
                    'expired', 'skip', 'production', $3::JSONB, $4::JSONB,
                    'deferred', $5::JSONB, $6::JSONB,
                    TIMESTAMPTZ '2020-01-01 00:00:00+00',
                    TIMESTAMPTZ '2020-01-01 00:00:00+00',
                    TIMESTAMPTZ '2020-01-01 00:30:00+00'
                 )`,
                [
                    USER,
                    `earlybird.fulfillment.${ORDER.replaceAll('-', '')}${suffix}`,
                    JSON.stringify({
                        basic: 'production',
                        standard: 'production',
                        plus: 'test_only',
                    }),
                    JSON.stringify(catalog),
                    JSON.stringify({
                        basic: { status: 'deferred' },
                        standard: { status: 'deferred' },
                        plus: { status: 'deferred' },
                    }),
                    JSON.stringify({ pipeline: 'v2', risk: 'v1', aiStage: 'v1' }),
                ]
            );
        }
        await expect(asService(
            `SELECT * FROM public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
                $1, $2::TIMESTAMPTZ
            )`,
            [ORDER, manualReviewAt]
        )).rejects.toThrow(/REBIND_REFUSED/);
        expect(await boundPreflightId()).toBe(PREFLIGHT);
        expect((await db.query<{ status: string; manual_review_at: string }>(
            `SELECT status, manual_review_at
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'manual_review',
            manual_review_at: manualReviewAt,
        });
    });

    it('recovers expired claims and reconciles completed requests without admitting others', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await db.exec(`
            UPDATE public.earlybird_fulfillments
            SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
            WHERE order_id = '${ORDER}';
        `);
        await expect(asService<{
            retryable: number;
        }>(
            'SELECT * FROM public.reconcile_earlybird_fulfillments(100)'
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({ retryable: 1 })],
        });

        await makeAdmissionReady();
        const nextLease = await claim();
        expect(nextLease.lease_fence).toBe(lease.lease_fence + 1);
        const created = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, nextLease.lease_fence]
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed'
             WHERE id = $1`,
            [created.request_id]
        );
        const summary = (await asService<{
            completed: number;
            manual_review: number;
        }>(
            'SELECT * FROM public.reconcile_earlybird_fulfillments(100)'
        )).rows[0];
        expect(summary).toMatchObject({ completed: 1, manual_review: 0 });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('completed');
    });

    it('never overwrites a refund-state order with a completed analysis', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        const created = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed'
             WHERE id = $1`,
            [created.request_id]
        );
        await db.query(
            `UPDATE public.earlybird_orders SET status = 'refund_pending'
             WHERE id = $1`,
            [ORDER]
        );

        const summary = (await asService<{
            completed: number;
            manual_review: number;
        }>(
            'SELECT * FROM public.reconcile_earlybird_fulfillments(100)'
        )).rows[0];
        expect(summary).toMatchObject({ completed: 0, manual_review: 1 });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [ORDER]
        )).rows[0].status).toBe('refund_pending');
    });

    it('rebinds only the recorded schema-stage failure into one fresh paid execution', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version, preflight_id, error_message,
                completed_at
            ) VALUES (
                $1, $2, 'sample.account', 'male', 'failed', 100, 'v2', $3,
                'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
                pg_catalog.clock_timestamp()
            )`,
            [FAILED_REQUEST, USER, PREFLIGHT]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR')`,
            [FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2,
                 consumed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'analysis_in_progress', result_request_id = $2
             WHERE id = $1`,
            [ORDER, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review', request_id = $2, attempt_count = 1,
                 operator_admitted_at = pg_catalog.clock_timestamp(),
                 manual_review_at = pg_catalog.clock_timestamp()
             WHERE order_id = $1`,
            [ORDER, FAILED_REQUEST]
        );

        const recovered = await asService<{
            order_id: string;
            fulfillment_status: string;
            preflight_id: string;
        }>(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        );
        expect(recovered.rows).toEqual([expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
            preflight_id: expect.not.stringMatching(new RegExp(`^${PREFLIGHT}$`)),
        })]);

        const recoveryPreflightId = recovered.rows[0].preflight_id;
        expect((await db.query<{
            status: string;
            result_request_id: string | null;
            preflight_id: string;
        }>(
            `SELECT status, result_request_id, preflight_id
             FROM public.earlybird_orders WHERE id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'paid',
            result_request_id: null,
            preflight_id: recoveryPreflightId,
        });
        expect((await db.query<{
            status: string;
            request_id: string | null;
            manual_review_at: string | null;
            attempt_count: number;
        }>(
            `SELECT status, request_id, manual_review_at, attempt_count
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toMatchObject({
            status: 'admission_pending',
            request_id: null,
            manual_review_at: null,
            attempt_count: 0,
        });
        expect((await db.query<{
            status: string;
            error_message: string;
        }>(
            `SELECT status, error_message FROM public.analysis_requests
             WHERE id = $1`,
            [FAILED_REQUEST]
        )).rows[0]).toEqual({
            status: 'failed',
            error_message: 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
        });
        expect((await db.query<{
            failed_request_id: string;
            recovery_preflight_id: string;
            prior_attempt_count: number;
        }>(
            `SELECT failed_request_id, recovery_preflight_id, prior_attempt_count
             FROM public.earlybird_schema_failure_recoveries WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            failed_request_id: FAILED_REQUEST,
            recovery_preflight_id: recoveryPreflightId,
            prior_attempt_count: 1,
        });

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).resolves.toMatchObject({ rows: [expect.objectContaining({
            preflight_id: recoveryPreflightId,
        })] });
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(1);
    });

    it('recovers only a legacy request target that is canonically equivalent to the paid order target', async () => {
        await seedSchemaFailedManualReview(' @SAMPLE.ACCOUNT ');

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).resolves.toMatchObject({ rows: [expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
        })] });
    });

    it('recovers a paid order whose analysis exhausted its job attempts', async () => {
        // JOB_ATTEMPTS_EXHAUSTED means the pipeline ran out of retries -- e.g. AI capacity
        // starvation. Once capacity is restored the paid analysis must be retryable.
        await seedSchemaFailedManualReview('sample.account', {
            requestError: 'JOB_ATTEMPTS_EXHAUSTED',
        });

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).resolves.toMatchObject({ rows: [expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
        })] });
    });

    it('recovers an attempt-exhausted request whose target was scrubbed on failure', async () => {
        await seedSchemaFailedManualReview(canonicalScrubToken(FAILED_REQUEST), {
            requestError: 'JOB_ATTEMPTS_EXHAUSTED',
        });

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).resolves.toMatchObject({ rows: [expect.objectContaining({
            fulfillment_status: 'admission_pending',
        })] });
    });

    it('refuses to recover an attempt-exhausted request on a schema-failure receipt', async () => {
        // Widening the accepted set must never let one failure reason borrow another's receipt.
        await seedSchemaFailedManualReview('sample.account', {
            requestError: 'JOB_ATTEMPTS_EXHAUSTED',
            receiptError: 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
        });

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
    });

    it('refuses to recover a schema-failed request on an attempt-exhausted receipt', async () => {
        await seedSchemaFailedManualReview('sample.account', {
            requestError: 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
            receiptError: 'JOB_ATTEMPTS_EXHAUSTED',
        });

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
    });

    it('still refuses target-quality failures that must stay in manual review', async () => {
        // These say the target itself could not be analysed, so a blind retry would
        // burn the customer's payment again on the same dead end.
        await seedSchemaFailedManualReview('sample.account');
        for (const code of [
            'SCRAPING_INCOMPLETE_ERROR',
            'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE',
            'SCRAPING_PROVIDER_QUOTA_ERROR',
        ]) {
            await db.query(
                'UPDATE public.analysis_requests SET error_message = $2 WHERE id = $1',
                [FAILED_REQUEST, code]
            );
            await db.query(
                'UPDATE public.analysis_v2_failure_receipts SET error_code = $2 WHERE request_id = $1',
                [FAILED_REQUEST, code]
            );

            await expect(asService(
                'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
                [ORDER]
            )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
        }
    });

    it('refuses a schema-failed request whose target is not canonically equivalent to the paid order', async () => {
        await seedSchemaFailedManualReview('different.account');

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(0);
    });

    it('refuses malformed legacy handle decoration instead of normalizing arbitrary input', async () => {
        await seedSchemaFailedManualReview('@@sample.account');

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
    });

    it('recovers a schema-failed request whose target is its own canonical scrub token', async () => {
        const token = canonicalScrubToken(FAILED_REQUEST);
        expect(token).toBe('retained.523e4567e89b42d3a456');
        // The pre-existing handle guard must keep admitting the 29-character token.
        expect(token).toMatch(/^@?[a-z0-9._]{1,30}$/);
        await seedSchemaFailedManualReview(token);

        const recovered = await asService<{
            order_id: string;
            fulfillment_status: string;
            preflight_id: string;
        }>(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        );
        expect(recovered.rows).toEqual([expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
        })]);
        expect((await db.query<{
            failed_request_id: string;
            recovery_preflight_id: string;
        }>(
            `SELECT failed_request_id, recovery_preflight_id
             FROM public.earlybird_schema_failure_recoveries WHERE order_id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            failed_request_id: FAILED_REQUEST,
            recovery_preflight_id: recovered.rows[0].preflight_id,
        });
        // The recovery preflight is rebuilt from the paid order, never from the token.
        expect((await db.query<{ target_instagram_id: string }>(
            'SELECT target_instagram_id FROM public.analysis_preflights WHERE id = $1',
            [recovered.rows[0].preflight_id]
        )).rows[0].target_instagram_id).toBe('sample.account');
    });

    it('recovers the production state where the consumed preflight is scrubbed too', async () => {
        // Both stuck production orders sit in exactly this state: the terminal-failure scrub
        // rewrote the request AND its consumed preflight. Nothing may be read back from the
        // scrubbed preflight that the paid order is the authority for.
        await db.query(
            `UPDATE public.earlybird_orders
             SET exclusion_decision = 'exclude', excluded_instagram_id = 'ex.partner'
             WHERE id = $1`,
            [ORDER]
        );
        await seedSchemaFailedManualReview('sample.account');
        await applyTerminalPiiScrub(FAILED_REQUEST);

        // Prove the fixture really is the scrubbed shape before recovery runs.
        expect((await db.query<{
            target_instagram_id: string;
            status: string;
            exclusion_decision: string | null;
            excluded_instagram_id: string | null;
            scrubbed: boolean;
        }>(
            `SELECT target_instagram_id, status, exclusion_decision, excluded_instagram_id,
                    (pii_scrubbed_at IS NOT NULL) AS scrubbed
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toEqual({
            target_instagram_id: canonicalScrubToken(PREFLIGHT),
            status: 'consumed',
            exclusion_decision: 'skip',
            excluded_instagram_id: null,
            scrubbed: true,
        });
        expect((await db.query<{ target_instagram_id: string }>(
            'SELECT target_instagram_id FROM public.analysis_requests WHERE id = $1',
            [FAILED_REQUEST]
        )).rows[0].target_instagram_id).toBe(canonicalScrubToken(FAILED_REQUEST));

        const recovered = await asService<{
            order_id: string;
            fulfillment_status: string;
            preflight_id: string;
        }>(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        );
        expect(recovered.rows).toEqual([expect.objectContaining({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
        })]);

        // The replacement preflight is rebuilt from the ORDER, never inherited from the
        // scrubbed predecessor: real handle, order-owned exclusion, and no scrub stamp.
        expect((await db.query<{
            target_instagram_id: string;
            exclusion_decision: string | null;
            excluded_instagram_id: string | null;
            status: string;
            access_mode: string;
            user_id: string;
            target_followers_count: number;
            target_following_count: number;
            scrubbed: boolean;
        }>(
            `SELECT target_instagram_id, exclusion_decision, excluded_instagram_id, status,
                    access_mode, user_id, target_followers_count, target_following_count,
                    (pii_scrubbed_at IS NOT NULL) AS scrubbed
             FROM public.analysis_preflights WHERE id = $1`,
            [recovered.rows[0].preflight_id]
        )).rows[0]).toEqual({
            target_instagram_id: 'sample.account',
            exclusion_decision: 'exclude',
            excluded_instagram_id: 'ex.partner',
            status: 'ready',
            access_mode: 'production',
            user_id: USER,
            target_followers_count: 120,
            target_following_count: 140,
            scrubbed: false,
        });

        // The scrubbed predecessor is left exactly as the scrub left it.
        expect((await db.query<{
            target_instagram_id: string;
            status: string;
            excluded_instagram_id: string | null;
        }>(
            `SELECT target_instagram_id, status, excluded_instagram_id
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toEqual({
            target_instagram_id: canonicalScrubToken(PREFLIGHT),
            status: 'consumed',
            excluded_instagram_id: null,
        });
    });

    it('refuses a scrub token minted from any request other than the failed one', async () => {
        await seedSchemaFailedManualReview(canonicalScrubToken(ADMISSION_TOKEN));

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(0);
    });

    it.each([
        ['truncated', canonicalScrubToken(FAILED_REQUEST).slice(0, -1)],
        ['extended', `${canonicalScrubToken(FAILED_REQUEST)}4`],
        ['decorated', `@${canonicalScrubToken(FAILED_REQUEST)}`],
    ])('refuses the %s imitation of the failed request scrub token', async (_, imitation) => {
        await seedSchemaFailedManualReview(imitation);

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(0);
    });

    it('still refuses a genuinely different target once scrub tokens are admitted', async () => {
        await seedSchemaFailedManualReview('another.account');

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(0);
    });

    it('refuses every manual-review failure other than the recorded schema-stage error', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version, preflight_id, error_message,
                completed_at
            ) VALUES (
                $1, $2, 'sample.account', 'male', 'failed', 100, 'v2', $3,
                'ANALYSIS_V2_OTHER_FAILURE', pg_catalog.clock_timestamp()
            )`,
            [FAILED_REQUEST, USER, PREFLIGHT]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'ANALYSIS_V2_OTHER_FAILURE')`,
            [FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2,
                 consumed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'analysis_in_progress', result_request_id = $2
             WHERE id = $1`,
            [ORDER, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review', request_id = $2, attempt_count = 1,
                 operator_admitted_at = pg_catalog.clock_timestamp(),
                 manual_review_at = pg_catalog.clock_timestamp()
             WHERE order_id = $1`,
            [ORDER, FAILED_REQUEST]
        );

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(0);
        expect((await db.query<{ status: string; result_request_id: string | null }>(
            `SELECT status, result_request_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER]
        )).rows[0]).toEqual({
            status: 'analysis_in_progress',
            result_request_id: FAILED_REQUEST,
        });
    });

    it('rejects a recovery whose immutable required card does not match its required plan', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET plan_cards_snapshot = $2::JSONB
             WHERE id = $1`,
            [PREFLIGHT, JSON.stringify(mismatchedRequiredCards)]
        );
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version, preflight_id, error_message,
                completed_at
            ) VALUES (
                $1, $2, 'sample.account', 'male', 'failed', 100, 'v2', $3,
                'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
                pg_catalog.clock_timestamp()
            )`,
            [FAILED_REQUEST, USER, PREFLIGHT]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR')`,
            [FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2,
                 consumed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'analysis_in_progress', result_request_id = $2
             WHERE id = $1`,
            [ORDER, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review', request_id = $2,
                 operator_admitted_at = pg_catalog.clock_timestamp(),
                 manual_review_at = pg_catalog.clock_timestamp()
             WHERE order_id = $1`,
            [ORDER, FAILED_REQUEST]
        );

        await expect(asService(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_schema_failure_recoveries`
        )).rows[0].count).toBe(0);
    });

    it('preserves the immutable approved Standard entitlement when recomputation would demand Plus', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 500, target_following_count = 500,
                 capacity_required_plan_id = 'standard', required_plan_id = 'standard',
                 launch_status_snapshot = $2::JSONB,
                 plan_catalog_snapshot = $3::JSONB,
                 plan_cards_snapshot = $4::JSONB
             WHERE id = $1`,
            [
                PREFLIGHT,
                JSON.stringify({
                    basic: 'production', standard: 'test_only', plus: 'production',
                }),
                JSON.stringify(standardCapacityCatalog),
                JSON.stringify(approvedStandardCards),
            ]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET plan_id = 'standard', target_followers_count = 500,
                 target_following_count = 500
             WHERE id = $1`,
            [ORDER]
        );
        await db.query(
            `INSERT INTO public.analysis_requests(
                id, user_id, target_instagram_id, target_gender, status,
                progress, pipeline_version, preflight_id, error_message,
                completed_at
            ) VALUES (
                $1, $2, 'sample.account', 'male', 'failed', 100, 'v2', $3,
                'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
                pg_catalog.clock_timestamp()
            )`,
            [FAILED_REQUEST, USER, PREFLIGHT]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR')`,
            [FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2,
                 consumed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'analysis_in_progress', result_request_id = $2
             WHERE id = $1`,
            [ORDER, FAILED_REQUEST]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status = 'manual_review', request_id = $2, attempt_count = 1,
                 operator_admitted_at = pg_catalog.clock_timestamp(),
                 manual_review_at = pg_catalog.clock_timestamp()
             WHERE order_id = $1`,
            [ORDER, FAILED_REQUEST]
        );

        const recovered = await asService<{
            preflight_id: string;
        }>(
            'SELECT * FROM public.recover_earlybird_schema_failed_fulfillment($1)',
            [ORDER]
        );
        const recoveredPreflightId = recovered.rows[0].preflight_id;
        expect((await db.query<{
            capacity_required_plan_id: string;
            required_plan_id: string;
            plan_cards_snapshot: typeof approvedStandardCards;
        }>(
            `SELECT capacity_required_plan_id, required_plan_id, plan_cards_snapshot
             FROM public.analysis_preflights WHERE id = $1`,
            [recoveredPreflightId]
        )).rows[0]).toEqual({
            capacity_required_plan_id: 'standard',
            required_plan_id: 'standard',
            plan_cards_snapshot: approvedStandardCards,
        });

        const reserved = await asService<{
            admission_generation: number;
            dispatch_generation: number;
            dispatch_token: string;
        }>(
            `SELECT * FROM public.reserve_analysis_v2_preflight_admission(
                $1, $2, 'standard', $3, $4, $5
            )`,
            [
                recoveredPreflightId,
                USER,
                admissionHash(),
                ADMISSION_TOKEN,
                DISPATCH_TOKEN,
            ]
        );
        const reservation = reserved.rows[0];
        await expect(asService(
            `SELECT * FROM public.claim_analysis_v2_preflight_admission(
                $1, $2, $3, $4, $5, 300
            )`,
            [
                recoveredPreflightId,
                reservation.admission_generation,
                reservation.dispatch_generation,
                reservation.dispatch_token,
                ADMISSION_CLAIM,
            ]
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({
                claimed: true,
                admission_status: 'processing',
            })],
        });
        await expect(asService<{
            admission_status: string;
            admission_error_code: string | null;
        }>(
            `SELECT * FROM public.complete_analysis_v2_preflight_admission(
                $1, $2, $3, 'sample.account', 500, 500, FALSE
            )`,
            [
                recoveredPreflightId,
                reservation.admission_generation,
                ADMISSION_CLAIM,
            ]
        )).resolves.toMatchObject({
            rows: [{ admission_status: 'ready', admission_error_code: null }],
        });
        expect((await db.query<{
            admission_status: string;
            admission_required_plan_id: string;
            admission_plan_cards_snapshot: typeof approvedStandardCards;
        }>(
            `SELECT admission_status, admission_required_plan_id, admission_plan_cards_snapshot
             FROM public.analysis_preflights WHERE id = $1`,
            [recoveredPreflightId]
        )).rows[0]).toEqual({
            admission_status: 'ready',
            admission_required_plan_id: 'standard',
            admission_plan_cards_snapshot: approvedStandardCards,
        });
    });
});
