import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const candidateSource = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714063833_fix_analysis_v2_candidate_media_key.sql',
        import.meta.url
    ),
    'utf8'
);
const resultSource = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713185711_add_analysis_v2_result_finalization.sql',
        import.meta.url
    ),
    'utf8'
);
const correctionUrl = new URL(
    '../../../supabase/migrations/20260717120000_fix_analysis_v2_checkpoint_contracts.sql',
    import.meta.url
);
const correctionMigration = existsSync(correctionUrl)
    ? readFileSync(correctionUrl, 'utf8')
    : '';
const bioContractUrl = new URL(
    '../../../supabase/migrations/20260717150000_allow_analysis_v2_multiline_bio.sql',
    import.meta.url
);
const bioContractMigration = existsSync(bioContractUrl)
    ? readFileSync(bioContractUrl, 'utf8')
    : '';

function functionDefinition(source: string, name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return source.slice(start, end + 4);
}

function latestFunctionDefinition(source: string, name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = source.lastIndexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return source.slice(start, end + 4);
}

function tableDefinition(source: string, name: string): string {
    const marker = `CREATE TABLE public.${name} (`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing table ${name}`);
    const end = source.indexOf('\n);', start);
    if (end < 0) throw new Error(`Unbounded table ${name}`);
    return source.slice(start, end + 3);
}

const candidateCheckpoint = functionDefinition(
    candidateSource,
    'analysis_v2_checkpoint_candidate_features_complete'
);
const candidateCheckpointEntrypoint = latestFunctionDefinition(
    resultSource,
    'checkpoint_analysis_v2_candidate_features'
);
const privateCheckpoint = functionDefinition(
    resultSource,
    'checkpoint_analysis_v2_private_names'
);
const candidateFeatureTable = tableDefinition(
    resultSource,
    'analysis_v2_candidate_feature_rows'
);
const femaleResultTable = tableDefinition(
    resultSource,
    'analysis_v2_female_results'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_TOKEN = '22222222-2222-4222-8222-222222222222';
const JOB_INPUT_HASH = 'a'.repeat(64);
const TOPOLOGY_INPUT_HASH = 'b'.repeat(64);
const FEMALE_GENDER_HASH = 'c'.repeat(64);
const FEMALE_FEATURE_HASH = 'd'.repeat(64);
const NON_FEMALE_GENDER_HASH = 'e'.repeat(64);
const NON_FEMALE_FEATURE_HASH = 'f'.repeat(64);
const PRIVATE_RESULT_HASH = '1'.repeat(64);
const WRONG_RESULT_HASH = '2'.repeat(64);

const FEMALE_GENDER_OPERATION = `gender-triage:${'3'.repeat(64)}`;
const FEMALE_FEATURE_OPERATION = `feature-analysis:${'4'.repeat(64)}`;
const NON_FEMALE_GENDER_OPERATION = `gender-triage:${'5'.repeat(64)}`;
const NON_FEMALE_FEATURE_OPERATION = `feature-analysis:${'6'.repeat(64)}`;
const PRIVATE_OPERATION = `private-account-name:${'7'.repeat(64)}`;
const FEMALE_BUNDLE_ID = `bundle:${'8'.repeat(64)}`;
const NON_FEMALE_BUNDLE_ID = `bundle:${'9'.repeat(64)}`;

const bootstrap = `
CREATE SCHEMA extensions;

CREATE OR REPLACE FUNCTION extensions.digest(p_value BYTEA, p_algorithm TEXT)
RETURNS BYTEA LANGUAGE sql IMMUTABLE STRICT SET search_path = ''
AS $$ SELECT p_value; $$;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    target_instagram_id TEXT NOT NULL,
    excluded_instagram_id TEXT
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    track TEXT NOT NULL,
    kind TEXT NOT NULL,
    batch INTEGER,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_dag_batch_topology (
    request_id UUID NOT NULL,
    topology_kind TEXT NOT NULL,
    batch INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    PRIMARY KEY (request_id, topology_kind, batch)
);
CREATE TABLE public.analysis_v2_dag_batch_results (
    request_id UUID NOT NULL,
    result_kind TEXT NOT NULL,
    batch INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    PRIMARY KEY (request_id, result_kind, batch)
);
CREATE TABLE public.analysis_v2_mutual_rows (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    username TEXT NOT NULL,
    is_private BOOLEAN NOT NULL,
    detailed_ordinal INTEGER,
    mutual_ordinal INTEGER NOT NULL
);
CREATE TABLE public.analysis_v2_ai_result_checkpoints (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    result_hash TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_ai_attempts (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_media_artifacts (
    request_id UUID NOT NULL,
    artifact_kind TEXT NOT NULL,
    artifact_key TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_candidate_feature_manifests (
    request_id UUID NOT NULL,
    batch INTEGER NOT NULL,
    producer_job_key TEXT NOT NULL,
    producer_input_hash TEXT NOT NULL,
    producer_claim_token UUID NOT NULL,
    item_count INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    result_hash TEXT NOT NULL,
    PRIMARY KEY (request_id, batch)
);
CREATE TABLE public.analysis_v2_private_name_manifests (
    request_id UUID NOT NULL,
    batch INTEGER NOT NULL,
    producer_job_key TEXT NOT NULL,
    producer_input_hash TEXT NOT NULL,
    producer_claim_token UUID NOT NULL,
    item_count INTEGER NOT NULL,
    source TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    ai_result_hash TEXT,
    result_hash TEXT NOT NULL,
    PRIMARY KEY (request_id, batch)
);
CREATE TABLE public.analysis_v2_private_name_rows (
    request_id UUID NOT NULL,
    batch INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    instagram_id TEXT NOT NULL,
    full_name TEXT,
    profile_image_url TEXT,
    name_female_score NUMERIC NOT NULL,
    name_is_name BOOLEAN NOT NULL,
    name_confidence NUMERIC NOT NULL
);
CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY
);

CREATE OR REPLACE FUNCTION public.analysis_v2_assert_result_job_fence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_input_hash TEXT
)
RETURNS public.analysis_pipeline_jobs
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key;
    IF v_job.request_id IS NULL
       OR v_job.status <> 'processing'
       OR v_job.input_hash <> p_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_image_path(TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE; $$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_public_copy(TEXT, INTEGER)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE; $$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_media_context(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE; $$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_candidate_id(p_username TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT 'candidate:' || p_username; $$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_staging_hash(TEXT, INTEGER, JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT repeat('0', 64); $$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_checkpoint_json(
    p_request_id UUID,
    p_job_key TEXT,
    p_batch INTEGER,
    p_item_count INTEGER,
    p_row_count INTEGER,
    p_result_hash TEXT
)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'batch', p_batch,
        'itemCount', p_item_count,
        'rowCount', p_row_count,
        'resultHash', p_result_hash
    );
$$;

${candidateFeatureTable}

${femaleResultTable}
`;

interface CandidateOptions {
    includeFemaleBundle?: boolean;
    includeNonFemaleBundle?: boolean;
    includeNonFemaleFeatureCheckpoint?: boolean;
}

function mediaContext(bundleId: string) {
    return {
        bundleId,
        selectionIds: ['selection-1'],
        triageAnalyzedSelectionIds: ['selection-1'],
        featureAnalyzedSelectionIds: ['selection-1'],
        captions: [],
        posts: [],
    };
}

function candidateRows(input: {
    femaleBio?: string | null;
    femaleFullName?: string | null;
} = {}) {
    return [{
        candidateId: 'candidate:female',
        instagramId: 'female.account',
        fullName: input.femaleFullName ?? null,
        profileImageUrl: null,
        bio: input.femaleBio ?? null,
        classification: 'verified_female',
        mediaContext: mediaContext(FEMALE_BUNDLE_ID),
        genderOperationKey: FEMALE_GENDER_OPERATION,
        genderResultHash: FEMALE_GENDER_HASH,
        featureOperationKey: FEMALE_FEATURE_OPERATION,
        featureResultHash: FEMALE_FEATURE_HASH,
        feature: {
            appearanceGrade: 4,
            exposureScore: 2,
            isBusinessAccount: false,
            featurePartnerEvidenceStrong: false,
            oneLineOverview: '\uC694\uC57D',
        },
    }, {
        candidateId: 'candidate:nonfemale',
        instagramId: 'nonfemale.account',
        fullName: null,
        profileImageUrl: null,
        bio: null,
        classification: 'verified_non_female',
        mediaContext: mediaContext(NON_FEMALE_BUNDLE_ID),
        genderOperationKey: NON_FEMALE_GENDER_OPERATION,
        genderResultHash: NON_FEMALE_GENDER_HASH,
        featureOperationKey: NON_FEMALE_FEATURE_OPERATION,
        featureResultHash: NON_FEMALE_FEATURE_HASH,
        feature: null,
    }];
}

let db: PGlite;

async function seedJob(input: {
    jobKey: string;
    track: string;
    kind: string;
}): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, target_instagram_id, excluded_instagram_id
         ) VALUES ($1, 'target.account', NULL)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, track, kind, batch, input_hash,
            status, lease_token, lease_expires_at
         ) VALUES (
            $1, $2, $3, $4, 0, $5, 'processing', $6,
            pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
         )`,
        [REQUEST_ID, input.jobKey, input.track, input.kind, JOB_INPUT_HASH, CLAIM_TOKEN]
    );
}

async function insertMediaBundle(bundleId: string): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_v2_media_artifacts (
            request_id, artifact_kind, artifact_key
         ) VALUES (
            $1, 'media_bundle', pg_catalog.encode(
                extensions.digest(
                    pg_catalog.convert_to(
                        'analysis-v2-media-bundle-key:v1' || pg_catalog.chr(10) || $2,
                        'UTF8'
                    ),
                    'sha256'
                ),
                'hex'
            )
         )`,
        [REQUEST_ID, bundleId]
    );
}

async function seedCandidateBatch(options: CandidateOptions = {}): Promise<void> {
    const {
        includeFemaleBundle = true,
        includeNonFemaleBundle = false,
        includeNonFemaleFeatureCheckpoint = true,
    } = options;
    const jobKey = 'track:profile-ai:batch:0';
    await seedJob({ jobKey, track: 'profile_ai', kind: 'ai' });
    await db.query(
        `INSERT INTO public.analysis_v2_dag_batch_topology (
            request_id, topology_kind, batch, item_count, input_hash
         ) VALUES ($1, 'profile', 0, 2, $2)`,
        [REQUEST_ID, TOPOLOGY_INPUT_HASH]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_dag_batch_results (
            request_id, result_kind, batch, item_count
         ) VALUES ($1, 'profile_fetch', 0, 2)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_mutual_rows (
            request_id, job_key, username, is_private, detailed_ordinal, mutual_ordinal
         ) VALUES
            ($1, 'track:relationships:collect', 'female.account', FALSE, 1, 1),
            ($1, 'track:relationships:collect', 'nonfemale.account', FALSE, 2, 2)`,
        [REQUEST_ID]
    );
    const checkpoints = [
        [FEMALE_GENDER_OPERATION, 'genderTriage', FEMALE_GENDER_HASH],
        [FEMALE_FEATURE_OPERATION, 'featureAnalysis', FEMALE_FEATURE_HASH],
        [NON_FEMALE_GENDER_OPERATION, 'genderTriage', NON_FEMALE_GENDER_HASH],
        ...(includeNonFemaleFeatureCheckpoint
            ? [[NON_FEMALE_FEATURE_OPERATION, 'featureAnalysis', NON_FEMALE_FEATURE_HASH]]
            : []),
    ];
    for (const [operationKey, stage, resultHash] of checkpoints) {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_result_checkpoints (
                request_id, job_key, operation_key, stage, result_hash
             ) VALUES ($1, $2, $3, $4, $5)`,
            [REQUEST_ID, jobKey, operationKey, stage, resultHash]
        );
    }
    if (includeFemaleBundle) await insertMediaBundle(FEMALE_BUNDLE_ID);
    if (includeNonFemaleBundle) await insertMediaBundle(NON_FEMALE_BUNDLE_ID);
}

async function checkpointCandidates(rows = candidateRows()) {
    return db.query(
        `SELECT public.checkpoint_analysis_v2_candidate_features(
            $1, 'track:profile-ai:batch:0', $2, $3, 0, 2, $4::JSONB
         )`,
        [REQUEST_ID, CLAIM_TOKEN, JOB_INPUT_HASH, JSON.stringify(rows)]
    );
}

async function persistFemaleResultFromCandidate(): Promise<void> {
    await db.query(
        'INSERT INTO public.analysis_v2_result_summaries (request_id) VALUES ($1)',
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_female_results (
            request_id, candidate_id, sort_ordinal, instagram_id, full_name,
            profile_image_url, bio, display_score, risk_band, featured_rank,
            recent_mutual_rank, analysis_depth, one_line_overview,
            narrative_line_one, narrative_line_two
         )
         SELECT request_id, candidate_id, 1, instagram_id, full_name,
            profile_image_url, bio, 5.0, 'caution', NULL,
            NULL, 'features', one_line_overview, NULL, NULL
         FROM public.analysis_v2_candidate_feature_rows
         WHERE request_id = $1 AND terminal_classification = 'verified_female'`,
        [REQUEST_ID]
    );
}

async function seedPrivateBatch(): Promise<void> {
    const jobKey = 'track:private-names:batch:0';
    await seedJob({ jobKey, track: 'private_names', kind: 'ai' });
    await db.query(
        `INSERT INTO public.analysis_v2_dag_batch_topology (
            request_id, topology_kind, batch, item_count, input_hash
         ) VALUES ($1, 'private_name', 0, 1, $2)`,
        [REQUEST_ID, TOPOLOGY_INPUT_HASH]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_mutual_rows (
            request_id, job_key, username, is_private, detailed_ordinal, mutual_ordinal
         ) VALUES ($1, 'track:relationships:collect', 'private.account', TRUE, NULL, 1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_ai_result_checkpoints (
            request_id, job_key, operation_key, stage, result_hash
         ) VALUES ($1, $2, $3, 'privateAccountName', $4)`,
        [REQUEST_ID, jobKey, PRIVATE_OPERATION, PRIVATE_RESULT_HASH]
    );
}

function privateRows(username = 'private.account') {
    return [{
        candidateId: `candidate:${username}`,
        instagramId: username,
        fullName: null,
        profileImageUrl: null,
        nameFemaleScore: 0.75,
        nameIsName: true,
        nameConfidence: 0.9,
    }];
}

async function checkpointPrivate(input: {
    rows?: ReturnType<typeof privateRows>;
    resultHash?: string;
} = {}) {
    return db.query(
        `SELECT public.checkpoint_analysis_v2_private_names(
            $1, 'track:private-names:batch:0', $2, $3, 0,
            'checkpoint', $4, $5, $6::JSONB
         )`,
        [
            REQUEST_ID,
            CLAIM_TOKEN,
            JOB_INPUT_HASH,
            PRIVATE_OPERATION,
            input.resultHash ?? PRIVATE_RESULT_HASH,
            JSON.stringify(input.rows ?? privateRows()),
        ]
    );
}

describe('analysis V2 checkpoint contract correction PGlite migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(candidateCheckpoint);
        await db.exec(candidateCheckpointEntrypoint);
        await db.exec(privateCheckpoint);
        if (correctionMigration) await db.exec(correctionMigration);
        if (bioContractMigration) await db.exec(bioContractMigration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_v2_female_results,
                public.analysis_v2_result_summaries,
                public.analysis_v2_candidate_feature_rows,
                public.analysis_v2_candidate_feature_manifests,
                public.analysis_v2_private_name_rows,
                public.analysis_v2_private_name_manifests,
                public.analysis_v2_media_artifacts,
                public.analysis_v2_ai_result_checkpoints,
                public.analysis_v2_ai_attempts,
                public.analysis_v2_mutual_rows,
                public.analysis_v2_dag_batch_results,
                public.analysis_v2_dag_batch_topology,
                public.analysis_pipeline_jobs,
                public.analysis_requests
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('accepts a mixed analyzed batch with only the verified-female media bundle', async () => {
        await seedCandidateBatch();

        await expect(checkpointCandidates()).resolves.toBeDefined();

        await db.query(
            'DELETE FROM public.analysis_v2_media_artifacts WHERE request_id = $1',
            [REQUEST_ID]
        );
        await expect(checkpointCandidates()).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
    });

    it.each([
        ['LF', '\uCCAB \uC904\n\uB458\uC9F8 \uC904'],
        ['CRLF', '\uCCAB \uC904\r\n\uB458\uC9F8 \uC904'],
        ['CR', '\uCCAB \uC904\r\uB458\uC9F8 \uC904'],
    ])('preserves a %s bio through the candidate checkpoint and final female row', async (
        _lineBreak,
        multilineBio
    ) => {
        await seedCandidateBatch();

        await expect(checkpointCandidates(candidateRows({
            femaleBio: multilineBio,
        }))).resolves.toBeDefined();
        await persistFemaleResultFromCandidate();

        await expect(db.query<{ bio: string }>(
            `SELECT bio FROM public.analysis_v2_female_results
             WHERE request_id = $1 AND candidate_id = 'candidate:female'`,
            [REQUEST_ID]
        )).resolves.toMatchObject({ rows: [{ bio: multilineBio }] });
    });

    it('normalizes an empty full name to null at the candidate checkpoint', async () => {
        await seedCandidateBatch();

        await expect(checkpointCandidates(candidateRows({
            femaleFullName: '',
        }))).resolves.toBeDefined();

        await expect(db.query<{ full_name: string | null }>(
            `SELECT full_name FROM public.analysis_v2_candidate_feature_rows
             WHERE request_id = $1 AND candidate_id = 'candidate:female'`,
            [REQUEST_ID]
        )).resolves.toMatchObject({ rows: [{ full_name: null }] });
    });

    it('rejects unsafe bio control characters at the RPC boundary', async () => {
        await seedCandidateBatch();

        await expect(checkpointCandidates(candidateRows({
            femaleBio: 'ok\u0001bad',
        }))).rejects.toThrow(/ANALYSIS_V2_RESULT_INVALID/);
    });

    it('rejects multiline full names at the RPC boundary', async () => {
        await seedCandidateBatch();

        await expect(checkpointCandidates(candidateRows({
            femaleFullName: '\uD64D\n\uAE38\uB3D9',
        }))).rejects.toThrow(/ANALYSIS_V2_RESULT_INVALID/);
    });

    it('still requires the non-female feature AI checkpoint when its lineage is present', async () => {
        await seedCandidateBatch({ includeNonFemaleFeatureCheckpoint: false });

        await expect(checkpointCandidates()).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
    });

    it('accepts a private-name checkpoint when topology and consumer job hashes differ', async () => {
        expect(TOPOLOGY_INPUT_HASH).not.toBe(JOB_INPUT_HASH);
        await seedPrivateBatch();

        await expect(checkpointPrivate()).resolves.toBeDefined();
    });

    it.each([
        ['topology count', async () => {
            await db.query(
                `UPDATE public.analysis_v2_dag_batch_topology
                 SET item_count = 2
                 WHERE request_id = $1 AND topology_kind = 'private_name'`,
                [REQUEST_ID]
            );
            return checkpointPrivate();
        }],
        ['batch member', async () => checkpointPrivate({ rows: privateRows('other.account') })],
        ['AI result hash', async () => checkpointPrivate({ resultHash: WRONG_RESULT_HASH })],
    ])('rejects a private-name checkpoint with the wrong %s', async (_label, attempt) => {
        await seedPrivateBatch();

        await expect(attempt()).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
    });
});
