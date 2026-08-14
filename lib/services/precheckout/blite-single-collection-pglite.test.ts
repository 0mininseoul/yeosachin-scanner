import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationName = readdirSync(new URL('../../../supabase/migrations/', import.meta.url))
    .find(name => name.endsWith('_precheckout_blite_single_collection.sql'));
if (!migrationName) throw new Error('PRECHECKOUT_BLITE_MIGRATION_MISSING');
const migration = readFileSync(new URL(
    `../../../supabase/migrations/${migrationName}`,
    import.meta.url,
), 'utf8');
const statusFailOpenMigrationName = readdirSync(new URL('../../../supabase/migrations/', import.meta.url))
    .find(name => name.endsWith('_precheckout_blite_missing_source_status_fail_open.sql'));
if (!statusFailOpenMigrationName) throw new Error('PRECHECKOUT_BLITE_STATUS_FAIL_OPEN_MIGRATION_MISSING');
const statusFailOpenMigration = readFileSync(new URL(
    `../../../supabase/migrations/${statusFailOpenMigrationName}`,
    import.meta.url,
), 'utf8');
const deadlineMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260814150000_precheckout_blite_deadline_90.sql',
    import.meta.url,
), 'utf8');
const claimedTargetHashMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260814160000_read_claimed_preflight_target_hash.sql',
    import.meta.url,
), 'utf8');

const USER_ID = '10000000-0000-4000-8000-000000000001';
const PREFLIGHT_A = '20000000-0000-4000-8000-000000000001';
const PREFLIGHT_B = '20000000-0000-4000-8000-000000000002';
const PREFLIGHT_C = '20000000-0000-4000-8000-000000000003';
const PREFLIGHT_D = '20000000-0000-4000-8000-000000000004';
const PREFLIGHT_E = '20000000-0000-4000-8000-000000000005';
const PREFLIGHT_LEGACY = '20000000-0000-4000-8000-000000000006';
const PREFLIGHT_ORIGIN = '20000000-0000-4000-8000-000000000007';
const PREFLIGHT_ORIGIN_INSERT = '20000000-0000-4000-8000-000000000008';
const PREFLIGHT_PII_SCRUB = '20000000-0000-4000-8000-000000000009';
const PREFLIGHT_CASCADE = '20000000-0000-4000-8000-000000000010';
const PREFLIGHT_FLAG_OFF_PURGE = '20000000-0000-4000-8000-000000000011';
const PREFLIGHT_PARALLEL = '20000000-0000-4000-8000-000000000012';
const PREFLIGHT_DEADLINE = '20000000-0000-4000-8000-000000000013';
const PREFLIGHT_NEW_CLOCK = '20000000-0000-4000-8000-000000000014';
const PREFLIGHT_LEGACY_CLOCK = '20000000-0000-4000-8000-000000000015';
const PREFLIGHT_HASH_DRIFT = '20000000-0000-4000-8000-000000000016';
const DRIFTED_TARGET_HASH = 'b'.repeat(64);
const TARGET_HASH = 'a'.repeat(64);
const PROVIDER_REFERENCE = 'ApifyRun123456';
const PROVIDER_OPERATION_KEY = 'target-profile-fallback';
const FRESH_PROVIDER_OPERATION_KEY = 'target-profile-fresh-admission:g1';
const FRESH_PROVIDER_REFERENCE = 'ApifyFresh12345';
const CLAIM_TOKEN = '40000000-0000-4000-8000-000000000001';
const SOURCE_PAYLOAD = JSON.stringify({
    schemaVersion: 1,
    fullName: null,
    posts: [],
    media: [],
});
const PAYLOAD_HASH = createHash('sha256').update(
    JSON.stringify({ fullName: null, media: [], posts: [], schemaVersion: 1 }),
    'utf8',
).digest('hex');
const OTHER_PAYLOAD_HASH = 'd'.repeat(64);
const EMPTY_PAYLOAD_HASH = createHash('sha256').update('{}', 'utf8').digest('hex');
const VALID_DTO = JSON.stringify({
    schemaVersion: 1,
    persona: { headline: '분석 헤드라인', summary: '분석 요약 문장입니다' },
    signals: [
        { claim: '신호 하나', category: '관계', confidence: 0.8, band: 'high' },
        { claim: '신호 둘', category: '관계', confidence: 0.6, band: 'medium' },
        { claim: '신호 셋', category: '관계', confidence: 0.4, band: 'low' },
        { claim: '신호 넷', category: '관계', confidence: 0.7, band: 'high' },
    ],
    candidateRange: { min: 1, max: 2 },
    genderRead: {
        likelyFemale: true,
        confidence: 0.8,
        reasons: ['이유 하나', '이유 둘', '이유 셋'],
    },
    postCount: 0,
    evidenceFields: ['post.caption'],
});
const VALID_DTO_WITH_ALL_EVIDENCE_FIELDS = JSON.stringify({
    ...JSON.parse(VALID_DTO),
    evidenceFields: [
        'post.caption', 'post.hashtags', 'post.type', 'post.mediaItems',
        'post.declaredMediaCount', 'post.likesCount', 'post.commentsCount',
        'post.likesCountHidden', 'post.commentsCountHidden', 'post.taggedUsers',
        'post.mentionedUsers', 'post.imageUrl', 'post.thumbnailUrl',
        'profile.fullName', 'profile.profilePicUrl',
    ],
});

const bootstrap = `
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE OR REPLACE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$
    SELECT (
        substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 9, 4) || '-' ||
        '4' || substr(md5(random()::text || clock_timestamp()::text), 14, 3) || '-' ||
        '8' || substr(md5(random()::text || clock_timestamp()::text), 18, 3) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 21, 12)
    )::uuid
$$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID,
    status TEXT NOT NULL,
    ready_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
    target_input_hash VARCHAR(64),
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    target_full_name TEXT,
    target_bio TEXT,
    target_profile_image_url TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL DEFAULT 'target-profile-fallback',
    input_hash VARCHAR(64) NOT NULL,
    logical_provider TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id VARCHAR(64),
    PRIMARY KEY (preflight_id, operation_key)
);
CREATE TABLE public.precheckout_blite_cache (
    preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
    lease_token UUID NOT NULL,
    lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    dto JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT precheckout_blite_cache_payload_check CHECK (
        (state = 'pending' AND dto IS NULL AND completed_at IS NULL)
        OR (state = 'complete' AND dto IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT precheckout_blite_cache_timestamp_check CHECK (
        updated_at >= created_at
        AND lease_expires_at >= created_at
        AND (completed_at IS NULL OR completed_at >= created_at)
    )
);

CREATE FUNCTION public.claim_precheckout_blite_v1(p_preflight_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease UUID := extensions.gen_random_uuid();
    v_cache public.precheckout_blite_cache%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = p_preflight_id
          AND preflight.status = 'ready'
          AND preflight.ready_at IS NOT NULL
          AND preflight.expires_at > v_now
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.precheckout_blite_cache (
        preflight_id, state, lease_token, lease_expires_at, created_at, updated_at
    ) VALUES (
        p_preflight_id, 'pending', v_lease, v_now + INTERVAL '2 minutes', v_now, v_now
    ) ON CONFLICT (preflight_id) DO NOTHING;

    SELECT * INTO v_cache
    FROM public.precheckout_blite_cache
    WHERE preflight_id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();

    IF v_cache.state = 'complete' THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'complete', 'dto', v_cache.dto);
    END IF;
    IF v_cache.lease_token = v_lease THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'claimed', 'leaseToken', v_cache.lease_token
        );
    END IF;
    IF v_cache.lease_expires_at <= v_now THEN
        UPDATE public.precheckout_blite_cache
        SET lease_token = v_lease,
            lease_expires_at = v_now + INTERVAL '2 minutes',
            updated_at = v_now
        WHERE preflight_id = p_preflight_id;
        RETURN pg_catalog.jsonb_build_object('disposition', 'claimed', 'leaseToken', v_lease);
    END IF;
    RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
END;
$$;
CREATE FUNCTION public.complete_precheckout_blite_v1(
    p_preflight_id UUID,
    p_lease_token UUID,
    p_dto JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_dto IS NULL OR pg_catalog.jsonb_typeof(p_dto) <> 'object' THEN
        RETURN FALSE;
    END IF;
    UPDATE public.precheckout_blite_cache
    SET state = 'complete', dto = p_dto,
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE preflight_id = p_preflight_id
      AND state = 'pending'
      AND lease_token = p_lease_token
      AND lease_expires_at > pg_catalog.clock_timestamp();
    RETURN FOUND;
END;
$$;
CREATE FUNCTION public.release_precheckout_blite_v1(
    p_preflight_id UUID,
    p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.precheckout_blite_cache
    WHERE preflight_id = p_preflight_id
      AND state = 'pending'
      AND lease_token = p_lease_token;
    RETURN FOUND;
END;
$$;
CREATE FUNCTION public.complete_analysis_v2_preflight(
    p_preflight_id UUID, p_user_id UUID, p_claim_token UUID,
    p_target_full_name TEXT, p_target_bio TEXT, p_target_profile_image_url TEXT,
    p_target_followers_count INTEGER, p_target_following_count INTEGER,
    p_target_is_private BOOLEAN, p_capacity_required_plan_id TEXT,
    p_required_plan_id TEXT, p_plan_cards_snapshot JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.analysis_preflights
    SET status = 'ready', ready_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL
    WHERE id = p_preflight_id AND user_id = p_user_id AND lease_token = p_claim_token;
    RETURN FOUND;
END;
$$;
CREATE FUNCTION public.complete_anonymous_analysis_v2_preflight(
    p_preflight_id UUID, p_claim_token UUID,
    p_target_full_name TEXT, p_target_bio TEXT, p_target_profile_image_url TEXT,
    p_target_followers_count INTEGER, p_target_following_count INTEGER,
    p_target_is_private BOOLEAN, p_capacity_required_plan_id TEXT,
    p_required_plan_id TEXT, p_plan_cards_snapshot JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.analysis_preflights
    SET status = 'ready', ready_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL
    WHERE id = p_preflight_id AND user_id IS NULL AND lease_token = p_claim_token;
    RETURN FOUND;
END;
$$;
CREATE FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
RETURNS INTEGER LANGUAGE sql AS $$ SELECT 0 $$;
`;

let db: PGlite | undefined;

async function createDb(): Promise<PGlite> {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(bootstrap);
    await db.exec(migration);
    await db.exec(statusFailOpenMigration);
    await db.query(
        `INSERT INTO public.analysis_preflights(
            id,status,expires_at,created_at,precheckout_blite_cohort
        ) VALUES ($1,'processing',clock_timestamp() + interval '10 minutes',
            clock_timestamp() - interval '1 day',true)`,
        [PREFLIGHT_LEGACY_CLOCK],
    );
    await db.exec(deadlineMigration);
    await db.exec(claimedTargetHashMigration);
    return db;
}

function nowIso(offsetMs: number): string {
    return new Date(Date.now() + offsetMs).toISOString();
}

async function seedProcessingPreflight(
    database: PGlite,
    preflightId: string,
    options: {
        userId?: string | null;
        expiresAt?: string;
        createdAt?: string;
        includeFreshLineage?: boolean;
    } = {},
) {
    const userId = options.userId === undefined ? USER_ID : options.userId;
    const expiresAt = options.expiresAt ?? nowIso(20 * 60_000);
    const createdAt = options.createdAt ?? nowIso(-5_000);
    const deadlineAt = new Date(new Date(createdAt).getTime() + 90_000).toISOString();
    await database.query(
        `INSERT INTO public.analysis_preflights(
            id,user_id,status,expires_at,target_input_hash,lease_token,lease_expires_at,
            created_at,precheckout_blite_cohort
        ) VALUES ($1,$2,'processing',$3,$4,$5,clock_timestamp() + interval '5 minutes',$6,true)`,
        [preflightId, userId, expiresAt, TARGET_HASH, CLAIM_TOKEN, createdAt],
    );
    await database.query(
        `INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,status,run_id
        ) VALUES ($1,$2,$3,'apify','succeeded',$4)`,
        [preflightId, PROVIDER_OPERATION_KEY, TARGET_HASH, PROVIDER_REFERENCE],
    );
    if (options.includeFreshLineage) {
        await database.query(
            `INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id,operation_key,input_hash,logical_provider,status,run_id
            ) VALUES ($1,$2,$3,'apify','succeeded',$4)`,
            [preflightId, FRESH_PROVIDER_OPERATION_KEY, TARGET_HASH, FRESH_PROVIDER_REFERENCE],
        );
    }
    return { expiresAt, deadlineAt, submittedAt: createdAt };
}

async function finalizeSource(
    database: PGlite,
    preflightId: string,
    options: {
        payload?: string;
        payloadHash?: string;
        collectedAt?: string;
        expiresAt?: string;
        userId?: string | null;
        providerOperationKey?: string;
        providerRunReference?: string;
        targetInputHash?: string;
        targetFollowersCount?: number;
        targetFollowingCount?: number;
    } = {},
): Promise<boolean> {
    const collectedAt = options.collectedAt ?? nowIso(-1_000);
    const preflight = await database.query<{ expires_at: string }>(
        'SELECT expires_at FROM public.analysis_preflights WHERE id=$1', [preflightId],
    );
    const expiresAt = options.expiresAt ?? preflight.rows[0]!.expires_at;
    const userId = options.userId === undefined ? USER_ID : options.userId;
    const result = await database.query<{ result: boolean }>(
        `SELECT public.finalize_preflight_blite_source_v1(
            $1,$2,$3,$4,$5,$6,$7,
            'Target',NULL,'https://cdninstagram.com/profile.jpg',
            $12,$13,false,
            'basic','basic','{}'::jsonb,$8::jsonb,$9,$10,$11
        ) AS result`,
        [
            preflightId, userId, CLAIM_TOKEN, options.targetInputHash ?? TARGET_HASH, preflightId,
            options.providerOperationKey ?? PROVIDER_OPERATION_KEY,
            options.providerRunReference ?? PROVIDER_REFERENCE,
            options.payload ?? SOURCE_PAYLOAD, options.payloadHash ?? PAYLOAD_HASH, collectedAt, expiresAt,
            options.targetFollowersCount ?? 1, options.targetFollowingCount ?? 1,
        ],
    );
    return result.rows[0]!.result;
}

async function claim(database: PGlite, preflightId: string): Promise<Record<string, unknown>> {
    const result = await database.query<{ result: Record<string, unknown> }>(
        'SELECT public.claim_precheckout_blite_v2($1) AS result', [preflightId],
    );
    return result.rows[0]!.result;
}

async function seedExpiredFlagOffSource(database: PGlite, preflightId: string): Promise<void> {
    await database.query(
        `INSERT INTO public.analysis_preflights(
            id,status,ready_at,expires_at,target_input_hash,precheckout_blite_cohort
        ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',$2,false)`,
        [preflightId, TARGET_HASH],
    );
    await database.query(
        `INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,status,run_id
        ) VALUES ($1,$2,$3,'apify','succeeded',$4)`,
        [preflightId, PROVIDER_OPERATION_KEY, TARGET_HASH, PROVIDER_REFERENCE],
    );
    await database.query(
        `INSERT INTO public.precheckout_blite_sources(
            preflight_id,schema_version,target_input_hash,provider_run_id,provider_operation_key,provider_run_reference,
            payload,payload_bytes,payload_hash,collected_at,expires_at
        ) VALUES (
            $1,1,$2,$1,$3,$4,$5::jsonb,2,$6,
            clock_timestamp() - interval '2 minutes',clock_timestamp() - interval '1 minute'
        )`,
        [preflightId, TARGET_HASH, PROVIDER_OPERATION_KEY, PROVIDER_REFERENCE, '{}', EMPTY_PAYLOAD_HASH],
    );
    await database.query(
        `INSERT INTO public.precheckout_blite_cache(
            preflight_id,state,lease_token,lease_expires_at,attempt_count,created_at,updated_at
        ) VALUES ($1,'pending',$2,clock_timestamp() + interval '2 minutes',0,clock_timestamp(),clock_timestamp())`,
        [preflightId, CLAIM_TOKEN],
    );
}

afterEach(async () => {
    await db?.close();
    db = undefined;
});

describe('precheckout B-lite source and lease lifecycle', () => {
    it('reproduces HMAC drift and reads the persisted target hash under the live claim fence', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_HASH_DRIFT, { userId: null });
        await database.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET input_hash=$2 WHERE preflight_id=$1 AND operation_key=$3`,
            [PREFLIGHT_HASH_DRIFT, DRIFTED_TARGET_HASH, PROVIDER_OPERATION_KEY],
        );

        await expect(finalizeSource(database, PREFLIGHT_HASH_DRIFT, {
            userId: null,
            targetInputHash: DRIFTED_TARGET_HASH,
            targetFollowersCount: 476,
            targetFollowingCount: 644,
        })).rejects.toThrow('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST');
        await expect(database.query<{ result: string | null }>(
            `SELECT public.read_claimed_analysis_v2_preflight_target_hash_v1($1,$2) AS result`,
            [PREFLIGHT_HASH_DRIFT, CLAIM_TOKEN],
        )).resolves.toMatchObject({ rows: [{ result: TARGET_HASH }] });
    }, 30_000);

    it('fails open a ready cohort with no source or cache instead of reporting a pending result forever', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_A);
        await database.query(
            `UPDATE public.analysis_preflights
             SET status='ready', ready_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL
             WHERE id=$1`,
            [PREFLIGHT_A],
        );

        await expect(database.query<{ result: { state: string } }>(
            'SELECT public.read_precheckout_blite_status_v1($1) AS result',
            [PREFLIGHT_A],
        )).resolves.toMatchObject({ rows: [{ result: { state: 'failed' } }] });
    }, 30_000);

    it('keeps a healthy ready cohort with its source/cache pair pending for inference', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_A);
        await finalizeSource(database, PREFLIGHT_A);

        await expect(database.query<{ result: { state: string } }>(
            'SELECT public.read_precheckout_blite_status_v1($1) AS result',
            [PREFLIGHT_A],
        )).resolves.toMatchObject({ rows: [{ result: { state: 'pending' } }] });
    }, 30_000);

    it('persists the anonymous rollout cohort source/cache for the observed 476/644 profile', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_ORIGIN, { userId: null });

        await expect(finalizeSource(database, PREFLIGHT_ORIGIN, {
            userId: null,
            targetFollowersCount: 476,
            targetFollowingCount: 644,
        }))
            .resolves.toBe(true);
        await expect(database.query(
            `SELECT preflight.status,
                    (SELECT count(*)::int FROM public.precheckout_blite_sources
                     WHERE preflight_id=preflight.id) AS sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache
                     WHERE preflight_id=preflight.id) AS caches
             FROM public.analysis_preflights AS preflight
             WHERE preflight.id=$1`,
            [PREFLIGHT_ORIGIN],
        )).resolves.toMatchObject({ rows: [{ status: 'ready', sources: 1, caches: 1 }] });
    }, 30_000);

    it('atomically records one source, accepts an identical replay, and rejects a changed hash', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_A, { includeFreshLineage: true });
        const collectedAt = nowIso(-1_000);

        await expect(finalizeSource(database, PREFLIGHT_A, { collectedAt })).resolves.toBe(true);
        await expect(finalizeSource(database, PREFLIGHT_A, { collectedAt })).resolves.toBe(false);
        await expect(finalizeSource(database, PREFLIGHT_A, {
            collectedAt,
            payload: JSON.stringify({ schemaVersion: 1, fullName: null, posts: [], media: [{ role: 'profile' }] }),
            payloadHash: OTHER_PAYLOAD_HASH,
        }))
            .rejects.toThrow('PRECHECKOUT_BLITE_SOURCE_CONFLICT');
        await expect(database.query(
            `SELECT payload_hash = pg_catalog.encode(
                extensions.digest(pg_catalog.convert_to(payload::text, 'UTF8'), 'sha256'), 'hex'
             ) AS hash_verified,target_input_hash,provider_operation_key
             FROM public.precheckout_blite_sources WHERE preflight_id=$1`,
            [PREFLIGHT_A],
        )).resolves.toMatchObject({ rows: [{
            hash_verified: true,
            target_input_hash: TARGET_HASH,
            provider_operation_key: PROVIDER_OPERATION_KEY,
        }] });
    }, 30_000);

    it('gives exactly one owner a lease, returns pending while it is live, and rejects stale terminal writes', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_B);
        await finalizeSource(database, PREFLIGHT_B);

        const first = await claim(database, PREFLIGHT_B);
        expect(first.disposition).toBe('claimed');
        expect(first.source).toEqual(JSON.parse(SOURCE_PAYLOAD));
        const firstLease = first.leaseToken as string;
        await expect(claim(database, PREFLIGHT_B)).resolves.toEqual({ disposition: 'pending' });

        await database.query(
            `UPDATE public.precheckout_blite_cache
             SET lease_expires_at = created_at WHERE preflight_id=$1`,
            [PREFLIGHT_B],
        );
        const second = await claim(database, PREFLIGHT_B);
        expect(second.disposition).toBe('claimed');
        const secondLease = second.leaseToken as string;
        expect(secondLease).not.toBe(firstLease);

        await expect(database.query(
            `SELECT public.complete_precheckout_blite_v2($1,$2,'{}'::jsonb) AS result`,
            [PREFLIGHT_B, firstLease],
        )).resolves.toMatchObject({ rows: [{ result: false }] });
        await expect(database.query(
            `SELECT public.fail_precheckout_blite_v2($1,$2,'inference_response_invalid') AS result`,
            [PREFLIGHT_B, firstLease],
        )).resolves.toMatchObject({ rows: [{ result: false }] });
        await expect(database.query(
            `SELECT public.complete_precheckout_blite_v2($1,$2,'{}'::jsonb) AS result`,
            [PREFLIGHT_B, secondLease],
        )).resolves.toMatchObject({ rows: [{ result: false }] });
        await expect(database.query(
            `SELECT public.fail_precheckout_blite_v2($1,$2,NULL) AS result`,
            [PREFLIGHT_B, secondLease],
        )).resolves.toMatchObject({ rows: [{ result: false }] });
        await expect(database.query(
            'SELECT count(*)::int AS sources FROM public.precheckout_blite_sources WHERE preflight_id=$1',
            [PREFLIGHT_B],
        )).resolves.toMatchObject({ rows: [{ sources: 1 }] });
        await expect(database.query(
            `SELECT public.complete_precheckout_blite_v2($1,$2,$3::jsonb) AS result`,
            [PREFLIGHT_B, secondLease, VALID_DTO],
        )).resolves.toMatchObject({ rows: [{ result: true }] });
        await expect(database.query(
            'SELECT 1 FROM public.precheckout_blite_sources WHERE preflight_id=$1', [PREFLIGHT_B],
        )).resolves.toMatchObject({ rows: [] });
        await expect(database.query(
            `UPDATE public.precheckout_blite_cache SET dto='{"changed":true}'::jsonb WHERE preflight_id=$1`,
            [PREFLIGHT_B],
        )).rejects.toThrow('PRECHECKOUT_BLITE_TERMINAL_IMMUTABLE');
    }, 30_000);

    it('accepts a schema-valid terminal DTO with all fifteen allowlisted evidence fields', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_A);
        await finalizeSource(database, PREFLIGHT_A);
        const owner = await claim(database, PREFLIGHT_A);
        expect(owner.disposition).toBe('claimed');

        await expect(database.query(
            `SELECT public.complete_precheckout_blite_v2($1,$2,$3::jsonb) AS result`,
            [PREFLIGHT_A, owner.leaseToken, VALID_DTO_WITH_ALL_EVIDENCE_FIELDS],
        )).resolves.toMatchObject({ rows: [{ result: true }] });
    }, 30_000);

    it('returns one claimed owner and one pending waiter for concurrent PGlite claims', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_PARALLEL);
        await finalizeSource(database, PREFLIGHT_PARALLEL);

        const results = await Promise.all([
            claim(database, PREFLIGHT_PARALLEL),
            claim(database, PREFLIGHT_PARALLEL),
        ]);
        expect(results.filter(result => result.disposition === 'claimed')).toHaveLength(1);
        expect(results.filter(result => result.disposition === 'pending')).toHaveLength(1);
    }, 30_000);

    it('caps leases at two attempts, deletes a terminal failed source, and keeps failed rows immutable', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_C);
        await finalizeSource(database, PREFLIGHT_C);

        expect((await claim(database, PREFLIGHT_C)).disposition).toBe('claimed');
        await database.query(
            'UPDATE public.precheckout_blite_cache SET lease_expires_at=created_at WHERE preflight_id=$1',
            [PREFLIGHT_C],
        );
        expect((await claim(database, PREFLIGHT_C)).disposition).toBe('claimed');
        await database.query(
            'UPDATE public.precheckout_blite_cache SET lease_expires_at=created_at WHERE preflight_id=$1',
            [PREFLIGHT_C],
        );
        await expect(claim(database, PREFLIGHT_C)).resolves.toMatchObject({
            disposition: 'failed', reason: 'attempts_exhausted',
        });
        await expect(database.query(
            'SELECT state,failure_reason,attempt_count FROM public.precheckout_blite_cache WHERE preflight_id=$1',
            [PREFLIGHT_C],
        )).resolves.toMatchObject({ rows: [{ state: 'failed', failure_reason: 'attempts_exhausted', attempt_count: 2 }] });
        await expect(database.query(
            'SELECT 1 FROM public.precheckout_blite_sources WHERE preflight_id=$1', [PREFLIGHT_C],
        )).resolves.toMatchObject({ rows: [] });
        await expect(database.query(
            `UPDATE public.precheckout_blite_cache SET failure_reason='inference_response_invalid' WHERE preflight_id=$1`,
            [PREFLIGHT_C],
        )).rejects.toThrow('PRECHECKOUT_BLITE_TERMINAL_IMMUTABLE');
    }, 30_000);

    it('terminalizes an expired source without trying a model lease and purges expired source/cache rows', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_D);
        await finalizeSource(database, PREFLIGHT_D);
        await database.query(
            `UPDATE public.precheckout_blite_sources
             SET collected_at=clock_timestamp() - interval '2 minutes',
                 expires_at=clock_timestamp() - interval '1 minute'
             WHERE preflight_id=$1`,
            [PREFLIGHT_D],
        );
        await expect(claim(database, PREFLIGHT_D)).resolves.toMatchObject({
            disposition: 'failed', reason: 'source_expired',
        });

        await seedProcessingPreflight(database, PREFLIGHT_E);
        await finalizeSource(database, PREFLIGHT_E);
        await database.query(
            `UPDATE public.precheckout_blite_sources
             SET collected_at=clock_timestamp() - interval '2 minutes',
                 expires_at=clock_timestamp() - interval '1 minute'
             WHERE preflight_id=$1`,
            [PREFLIGHT_E],
        );
        await expect(database.query(
            'SELECT public.purge_expired_precheckout_blite_sources_v1(10) AS result',
        )).resolves.toMatchObject({ rows: [{ result: 1 }] });
        await expect(database.query(
            `SELECT (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$1) AS caches`,
            [PREFLIGHT_E],
        )).resolves.toMatchObject({ rows: [{ sources: 0, caches: 0 }] });
    }, 30_000);

    it('rejects a post-T+86 completion, terminalizes it as inference_timeout, and deletes source', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_DEADLINE, {
            createdAt: nowIso(-91_000),
        });
        await database.query(
            `UPDATE public.analysis_preflights
             SET status='ready', ready_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL
             WHERE id=$1`,
            [PREFLIGHT_DEADLINE],
        );
        await database.query(
            `INSERT INTO public.precheckout_blite_sources(
                preflight_id,schema_version,target_input_hash,provider_run_id,provider_operation_key,
                provider_run_reference,payload,payload_bytes,payload_hash,collected_at,expires_at
            ) VALUES (
                $1,1,$2,$1,$3,$4,$5::jsonb,
                octet_length($5::text),$6,clock_timestamp() - interval '2 seconds',
                clock_timestamp() + interval '10 minutes'
            )`,
            [
                PREFLIGHT_DEADLINE, TARGET_HASH, PROVIDER_OPERATION_KEY, PROVIDER_REFERENCE,
                SOURCE_PAYLOAD, PAYLOAD_HASH,
            ],
        );
        await database.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id,state,lease_token,lease_expires_at,attempt_count,created_at,updated_at
            ) VALUES ($1,'pending',$2,clock_timestamp() + interval '2 minutes',1,clock_timestamp(),clock_timestamp())`,
            [PREFLIGHT_DEADLINE, CLAIM_TOKEN],
        );

        await expect(database.query(
            `SELECT public.complete_precheckout_blite_v2($1,$2,$3::jsonb) AS result`,
            [PREFLIGHT_DEADLINE, CLAIM_TOKEN, VALID_DTO],
        )).resolves.toMatchObject({ rows: [{ result: false }] });
        await expect(database.query(
            `SELECT state,failure_reason FROM public.precheckout_blite_cache WHERE preflight_id=$1`,
            [PREFLIGHT_DEADLINE],
        )).resolves.toMatchObject({ rows: [{ state: 'failed', failure_reason: 'inference_timeout' }] });
        await expect(database.query(
            'SELECT 1 FROM public.precheckout_blite_sources WHERE preflight_id=$1', [PREFLIGHT_DEADLINE],
        )).resolves.toMatchObject({ rows: [] });
    }, 30_000);

    it('keeps source rows inaccessible to browser roles and grants lifecycle RPCs only to service_role', async () => {
        const database = await createDb();
        await expect(database.query(
            `SELECT has_table_privilege('authenticated','public.precheckout_blite_sources','SELECT') AS allowed,
                    has_function_privilege('authenticated','public.claim_precheckout_blite_v2(uuid)','EXECUTE') AS claim_allowed,
                    has_function_privilege('service_role','public.claim_precheckout_blite_v2(uuid)','EXECUTE') AS service_allowed,
                    has_table_privilege('authenticated','public.precheckout_blite_dispatches','SELECT') AS dispatch_allowed,
                    has_function_privilege('authenticated','public.reserve_precheckout_blite_dispatch_v1(uuid)','EXECUTE') AS dispatch_claim_allowed,
                    has_function_privilege('service_role','public.reserve_precheckout_blite_dispatch_v1(uuid)','EXECUTE') AS dispatch_service_allowed`,
        )).resolves.toMatchObject({ rows: [{
            allowed: false,
            claim_allowed: false,
            service_allowed: true,
            dispatch_allowed: false,
            dispatch_claim_allowed: false,
            dispatch_service_allowed: true,
        }] });
    }, 30_000);

    it('durably fences dispatch failure/recovery, makes acknowledgement replay idempotent, and scrubs the fence', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_A);
        await expect(finalizeSource(database, PREFLIGHT_A)).resolves.toBe(true);

        const first = await database.query<{ result: { should_enqueue: boolean; dispatch_token: string } }>(
            'SELECT public.reserve_precheckout_blite_dispatch_v1($1) AS result', [PREFLIGHT_A],
        );
        expect(first.rows[0]!.result.should_enqueue).toBe(true);
        const firstToken = first.rows[0]!.result.dispatch_token;
        await expect(database.query(
            'SELECT public.mark_precheckout_blite_dispatch_failed_v1($1,$2) AS result',
            [PREFLIGHT_A, firstToken],
        )).resolves.toMatchObject({ rows: [{ result: true }] });

        const recovery = await database.query<{ result: { should_enqueue: boolean; dispatch_token: string } }>(
            'SELECT public.reserve_precheckout_blite_dispatch_v1($1) AS result', [PREFLIGHT_A],
        );
        expect(recovery.rows[0]!.result.should_enqueue).toBe(true);
        const recoveryToken = recovery.rows[0]!.result.dispatch_token;
        expect(recoveryToken).not.toBe(firstToken);
        await expect(database.query(
            'SELECT public.mark_precheckout_blite_dispatch_enqueued_v1($1,$2) AS result',
            [PREFLIGHT_A, recoveryToken],
        )).resolves.toMatchObject({ rows: [{ result: true }] });
        await expect(database.query(
            'SELECT public.reserve_precheckout_blite_dispatch_v1($1) AS result', [PREFLIGHT_A],
        )).resolves.toMatchObject({ rows: [{ result: { should_enqueue: false, dispatch_token: null } }] });

        await database.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',false)`,
            [PREFLIGHT_LEGACY],
        );
        await expect(database.query(
            'SELECT public.reserve_precheckout_blite_dispatch_v1($1) AS result', [PREFLIGHT_LEGACY],
        )).resolves.toMatchObject({ rows: [{ result: { should_enqueue: false, dispatch_token: null } }] });

        await database.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',true)`,
            [PREFLIGHT_CASCADE],
        );
        await database.query(
            'DELETE FROM public.analysis_preflights WHERE id=$1', [PREFLIGHT_CASCADE],
        );
        await expect(database.query(
            'SELECT public.reserve_precheckout_blite_dispatch_v1($1) AS result', [PREFLIGHT_CASCADE],
        )).resolves.toMatchObject({ rows: [{ result: { should_enqueue: false, dispatch_token: null } }] });

        await database.query(
            'UPDATE public.analysis_preflights SET pii_scrubbed_at = clock_timestamp() WHERE id=$1',
            [PREFLIGHT_A],
        );
        await expect(database.query(
            'SELECT count(*)::int AS count FROM public.precheckout_blite_dispatches WHERE preflight_id=$1',
            [PREFLIGHT_A],
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }, 30_000);

    it('keeps the flag-off v1 claim, release, and completion path executable after the migration', async () => {
        const database = await createDb();
        await database.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',false)`,
            [PREFLIGHT_LEGACY],
        );

        const first = await database.query<{ result: { disposition: string; leaseToken: string } }>(
            'SELECT public.claim_precheckout_blite_v1($1) AS result', [PREFLIGHT_LEGACY],
        );
        expect(first.rows[0]!.result.disposition).toBe('claimed');
        await expect(database.query(
            'SELECT public.release_precheckout_blite_v1($1,$2) AS result',
            [PREFLIGHT_LEGACY, first.rows[0]!.result.leaseToken],
        )).resolves.toMatchObject({ rows: [{ result: true }] });

        const second = await database.query<{ result: { disposition: string; leaseToken: string } }>(
            'SELECT public.claim_precheckout_blite_v1($1) AS result', [PREFLIGHT_LEGACY],
        );
        await expect(database.query(
            `SELECT public.complete_precheckout_blite_v1($1,$2,'{"legacy":true}'::jsonb) AS result`,
            [PREFLIGHT_LEGACY, second.rows[0]!.result.leaseToken],
        )).resolves.toMatchObject({ rows: [{ result: true }] });
        await expect(database.query(
            'SELECT state,dto,preflight.precheckout_blite_cohort AS cohort FROM public.precheckout_blite_cache AS cache JOIN public.analysis_preflights AS preflight ON preflight.id=cache.preflight_id WHERE cache.preflight_id=$1',
            [PREFLIGHT_LEGACY],
        )).resolves.toMatchObject({ rows: [{ state: 'complete', dto: { legacy: true }, cohort: false }] });
    }, 30_000);

    it('keeps a v1 caller non-mutating when it encounters a terminal B-lite failed cache row', async () => {
        const database = await createDb();
        await database.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',false)`,
            [PREFLIGHT_LEGACY],
        );
        await database.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id,state,lease_token,lease_expires_at,attempt_count,
                failure_reason,failed_at,created_at,updated_at
            ) VALUES (
                $1,'failed',$2,clock_timestamp() - interval '1 second',2,
                'attempts_exhausted',clock_timestamp(),clock_timestamp() - interval '2 seconds',clock_timestamp()
            )`,
            [PREFLIGHT_LEGACY, CLAIM_TOKEN],
        );

        await expect(database.query(
            'SELECT public.claim_precheckout_blite_v1($1) AS result', [PREFLIGHT_LEGACY],
        )).resolves.toMatchObject({ rows: [{ result: { disposition: 'pending' } }] });
        await expect(database.query(
            `SELECT state,lease_token,failure_reason
             FROM public.precheckout_blite_cache WHERE preflight_id=$1`,
            [PREFLIGHT_LEGACY],
        )).resolves.toMatchObject({ rows: [{
            state: 'failed', lease_token: CLAIM_TOKEN, failure_reason: 'attempts_exhausted',
        }] });
    }, 30_000);

    it('rejects a legacy v1 claim for a source-backed cohort without mutating its source or cache', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_A);
        await finalizeSource(database, PREFLIGHT_A);

        await expect(database.query(
            'SELECT public.claim_precheckout_blite_v1($1) AS result', [PREFLIGHT_A],
        )).rejects.toThrow('PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY');
        await expect(database.query(
            `SELECT cache.state,
                    (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources
             FROM public.precheckout_blite_cache AS cache WHERE cache.preflight_id=$1`,
            [PREFLIGHT_A],
        )).resolves.toMatchObject({ rows: [{ state: 'pending', sources: 1 }] });
    }, 30_000);

    it('anchors new cohort clocks to created_at and preserves legacy T+60 rows against resets', async () => {
        const database = await createDb();
        const origin = '2026-08-13T00:00:00.000Z';
        await database.query(
            `UPDATE public.analysis_preflights
             SET status='processing', updated_at=clock_timestamp()
             WHERE id=$1`,
            [PREFLIGHT_LEGACY_CLOCK],
        );
        await expect(database.query(
            `SELECT submitted_at = created_at AS submitted_from_origin,
                    deadline_at = created_at + interval '60 seconds' AS deadline_from_origin
             FROM public.analysis_preflights WHERE id=$1`,
            [PREFLIGHT_LEGACY_CLOCK],
        )).resolves.toMatchObject({ rows: [{ submitted_from_origin: true, deadline_from_origin: true }] });

        await expect(database.query(
            `UPDATE public.analysis_preflights
             SET submitted_at=clock_timestamp(), deadline_at=clock_timestamp() + interval '60 seconds'
             WHERE id=$1`,
            [PREFLIGHT_LEGACY_CLOCK],
        )).rejects.toThrow('PRECHECKOUT_BLITE_CLOCK_IMMUTABLE');
        await database.query(
            `INSERT INTO public.analysis_preflights(
                id,status,expires_at,created_at,precheckout_blite_cohort
            ) VALUES ($1,'processing',clock_timestamp() + interval '10 minutes',clock_timestamp(),false)`,
            [PREFLIGHT_NEW_CLOCK],
        );
        await database.query(
            'UPDATE public.analysis_preflights SET precheckout_blite_cohort=true WHERE id=$1',
            [PREFLIGHT_NEW_CLOCK],
        );
        await expect(database.query(
            `SELECT deadline_at = created_at + interval '90 seconds' AS deadline_from_origin
             FROM public.analysis_preflights WHERE id=$1`,
            [PREFLIGHT_NEW_CLOCK],
        )).resolves.toMatchObject({ rows: [{ deadline_from_origin: true }] });
        await expect(database.query(
            `INSERT INTO public.analysis_preflights(
                id,status,expires_at,created_at,precheckout_blite_cohort,submitted_at,deadline_at
            ) VALUES (
                $1,'processing',clock_timestamp() + interval '10 minutes',$2,true,
                clock_timestamp(),clock_timestamp() + interval '60 seconds'
            )`,
            [PREFLIGHT_ORIGIN_INSERT, origin],
        )).rejects.toThrow('PRECHECKOUT_BLITE_CLOCK_ORIGIN_FORBIDDEN');
    }, 30_000);

    it('deletes source and output together on PII scrub and preflight cascade', async () => {
        const database = await createDb();
        await seedProcessingPreflight(database, PREFLIGHT_PII_SCRUB);
        await finalizeSource(database, PREFLIGHT_PII_SCRUB);
        await database.query(
            'UPDATE public.analysis_preflights SET pii_scrubbed_at=clock_timestamp() WHERE id=$1',
            [PREFLIGHT_PII_SCRUB],
        );
        await expect(database.query(
            `SELECT (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$1) AS caches`,
            [PREFLIGHT_PII_SCRUB],
        )).resolves.toMatchObject({ rows: [{ sources: 0, caches: 0 }] });

        await seedProcessingPreflight(database, PREFLIGHT_CASCADE);
        await finalizeSource(database, PREFLIGHT_CASCADE);
        await database.query(
            'DELETE FROM public.analysis_preflights WHERE id=$1', [PREFLIGHT_CASCADE],
        );
        await expect(database.query(
            `SELECT (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$1) AS caches`,
            [PREFLIGHT_CASCADE],
        )).resolves.toMatchObject({ rows: [{ sources: 0, caches: 0 }] });
    }, 30_000);

    it('purges expired source and output even when the B-lite cohort flag is off', async () => {
        const database = await createDb();
        await seedExpiredFlagOffSource(database, PREFLIGHT_FLAG_OFF_PURGE);

        await expect(database.query(
            'SELECT public.purge_expired_precheckout_blite_sources_v1(1) AS result',
        )).resolves.toMatchObject({ rows: [{ result: 1 }] });
        await expect(database.query(
            `SELECT (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$1) AS caches`,
            [PREFLIGHT_FLAG_OFF_PURGE],
        )).resolves.toMatchObject({ rows: [{ sources: 0, caches: 0 }] });
    }, 30_000);
});
