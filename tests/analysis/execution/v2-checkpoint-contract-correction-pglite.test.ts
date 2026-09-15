import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
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
const preFeatureContractUrl = new URL(
    '../../../supabase/migrations/20260730120000_allow_v29_prefeature_checkpoint_contract.sql',
    import.meta.url
);
const preFeatureContractMigration = existsSync(preFeatureContractUrl)
    ? readFileSync(preFeatureContractUrl, 'utf8')
    : '';
const microbatchLineageMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731140000_accept_gender_microbatch_candidate_lineage.sql',
        import.meta.url
    ),
    'utf8'
);

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
const GENDER_MICROBATCH_OPERATION = `gender-triage:${'a'.repeat(64)}`;
const FEMALE_BUNDLE_ID = `bundle:${'8'.repeat(64)}`;
const NON_FEMALE_BUNDLE_ID = `bundle:${'9'.repeat(64)}`;

function aiContentHash(value: unknown): string {
    const canonicalJson = (item: unknown): string => {
        if (item === null || typeof item !== 'object') return JSON.stringify(item);
        if (Array.isArray(item)) return `[${item.map(canonicalJson).join(',')}]`;
        const record = item as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        )).join(',')}}`;
    };
    const canonical = canonicalJson(value);
    return createHash('sha256')
        .update(`analysis-v2-ai-result-content:v1\0${canonical}`, 'utf8')
        .digest('hex');
}

function genderResult(assessment: {
    inferredGender: 'female' | 'male' | 'unknown';
    confidence: 'low' | 'medium' | 'high';
    ownerConsistency: 'same_person' | 'mixed_or_unclear';
    evidenceSelectionIds: string[];
}) {
    const excluded = assessment.inferredGender === 'male'
        && assessment.confidence === 'high'
        && assessment.ownerConsistency === 'same_person';
    return {
        assessment,
        routingDecision: excluded
            ? 'exclude_high_confidence_male'
            : 'route_to_feature_analysis',
        routingReason: excluded
            ? 'high_confidence_same_owner_male'
            : 'conserve_female_recall',
        analyzedSelectionIds: ['selection-1'],
        v29AccountContext: 'personal',
    };
}

const bootstrap = `
CREATE SCHEMA extensions;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    target_instagram_id TEXT NOT NULL,
    excluded_instagram_id TEXT,
    policy_versions_snapshot JSONB
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
CREATE TABLE public.analysis_v2_scheduler_operations (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json JSONB
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

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD COLUMN baseline_classification TEXT,
    ADD COLUMN classification_source TEXT,
    ADD COLUMN gender_resolution_status TEXT,
    ADD COLUMN gender_resolution_operation_key TEXT,
    ADD COLUMN gender_resolution_result_hash TEXT;

${femaleResultTable}
`;

interface CandidateOptions {
    includeFemaleBundle?: boolean;
    includeNonFemaleBundle?: boolean;
    includeNonFemaleFeatureCheckpoint?: boolean;
    policyVersion?: 'ai-stage-policy-v2.8' | 'ai-stage-policy-v2.9' | 'ai-stage-policy-v2.10';
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
    policyVersion?: 'ai-stage-policy-v2.8' | 'ai-stage-policy-v2.9' | 'ai-stage-policy-v2.10';
}): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, target_instagram_id, excluded_instagram_id, policy_versions_snapshot
         ) VALUES ($1, 'target.account', NULL, $2::JSONB)`,
        [REQUEST_ID, JSON.stringify(input.policyVersion
            ? {
                pipeline: 'v2',
                risk: 'risk-policy-v2.4',
                aiStage: input.policyVersion,
                scheduler: 'ai-scheduler-v1',
            }
            : {})]
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
    await seedJob({
        jobKey,
        track: 'profile_ai',
        kind: 'ai',
        policyVersion: options.policyVersion,
    });
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

async function checkpointCandidates(rows: unknown = candidateRows()) {
    return db.query(
        `SELECT public.checkpoint_analysis_v2_candidate_features(
            $1, 'track:profile-ai:batch:0', $2, $3, 0, 2, $4::JSONB
         )`,
        [REQUEST_ID, CLAIM_TOKEN, JOB_INPUT_HASH, JSON.stringify(rows)]
    );
}

function preFeatureSkipRows(
    preFeaturePolicyVersion: 'ai-stage-policy-v2.9' | 'ai-stage-policy-v2.10',
) {
    return candidateRows().map((row, index) => ({
        ...row,
        classification: 'unresolved',
        mediaContext: {
            ...row.mediaContext,
            featureAnalyzedSelectionIds: [],
        },
        featureOperationKey: null,
        featureResultHash: null,
        feature: null,
        baselineClassification: 'unresolved',
        classificationSource: 'unknown',
        genderResolutionStatus: 'not_eligible',
        genderResolutionOperationKey: null,
        genderResolutionResultHash: null,
        preFeaturePolicyVersion,
        preFeatureAdmission: index === 0
            ? 'nonpersonal_or_official'
            : 'unsupported_unknown',
    }));
}

async function expectNoCandidateCheckpointArtifacts(): Promise<void> {
    const [rows, manifests] = await Promise.all([
        db.query(
            `SELECT candidate_id
             FROM public.analysis_v2_candidate_feature_rows
             WHERE request_id = $1`,
            [REQUEST_ID]
        ),
        db.query(
            `SELECT batch
             FROM public.analysis_v2_candidate_feature_manifests
             WHERE request_id = $1`,
            [REQUEST_ID]
        ),
    ]);

    expect(rows.rows).toEqual([]);
    expect(manifests.rows).toEqual([]);
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
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(candidateCheckpoint);
        await db.exec(candidateCheckpointEntrypoint);
        await db.exec(privateCheckpoint);
        if (correctionMigration) await db.exec(correctionMigration);
        if (bioContractMigration) await db.exec(bioContractMigration);
        await db.exec(`
            ALTER FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
                UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
            ) RENAME TO analysis_v2_checkpoint_candidate_features_complete_v26;

            CREATE FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
                p_request_id UUID,
                p_job_key TEXT,
                p_claim_token UUID,
                p_job_input_hash TEXT,
                p_batch INTEGER,
                p_analyzed_count INTEGER,
                p_rows JSONB
            )
            RETURNS JSONB
            LANGUAGE sql
            SET search_path = ''
            AS $$
                SELECT public.analysis_v2_checkpoint_candidate_features_complete_v26(
                    p_request_id, p_job_key, p_claim_token, p_job_input_hash,
                    p_batch, p_analyzed_count, p_rows
                );
            $$;
        `);
        if (preFeatureContractMigration) await db.exec(preFeatureContractMigration);
        await db.exec(microbatchLineageMigration);
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
                public.analysis_v2_scheduler_operations,
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

    it.each(['checkpoint', 'safe_fallback'] as const)(
        'accepts per-candidate gender hashes from a ready %s microbatch envelope',
        async source => {
            const preFeature = source === 'safe_fallback';
            await seedCandidateBatch(preFeature ? {
                includeFemaleBundle: false,
                includeNonFemaleBundle: false,
                policyVersion: 'ai-stage-policy-v2.9',
            } : {});
            const assessments: Array<Parameters<typeof genderResult>[0]> = [
                {
                    inferredGender: 'female', confidence: 'high',
                    ownerConsistency: 'same_person', evidenceSelectionIds: ['selection-1'],
                },
                {
                    inferredGender: 'male', confidence: 'high',
                    ownerConsistency: 'same_person', evidenceSelectionIds: ['selection-1'],
                },
            ];
            const baseRows = preFeature
                ? preFeatureSkipRows('ai-stage-policy-v2.9')
                : candidateRows();
            const rows = baseRows.map((row, index) => ({
                ...row,
                genderOperationKey: GENDER_MICROBATCH_OPERATION,
                genderResultHash: aiContentHash(assessments[index]),
            }));
            await db.query(
                `DELETE FROM public.analysis_v2_ai_result_checkpoints
                 WHERE request_id = $1 AND stage = 'genderTriage'`,
                [REQUEST_ID]
            );
            await db.query(
                `INSERT INTO public.analysis_v2_scheduler_operations (
                    request_id, job_key, operation_key, stage, status, result_json
                 ) VALUES ($1, 'track:profile-ai:batch:0', $2, 'genderTriage',
                    'ready', $3::JSONB)`,
                [REQUEST_ID, GENDER_MICROBATCH_OPERATION, JSON.stringify({
                    operationKey: GENDER_MICROBATCH_OPERATION,
                    results: assessments.map((assessment, index) => ({
                        accountId: `account:${String(index + 1).repeat(64)}`,
                        result: genderResult(assessment),
                        source,
                    })),
                })]
            );

            await expect(checkpointCandidates(rows)).resolves.toBeDefined();
        }
    );

    it('rejects a candidate hash absent from the matching ready gender microbatch', async () => {
        await seedCandidateBatch();
        const assessment: Parameters<typeof genderResult>[0] = {
            inferredGender: 'female', confidence: 'high',
            ownerConsistency: 'same_person', evidenceSelectionIds: ['selection-1'],
        };
        const rows = candidateRows().map(row => ({
            ...row,
            genderOperationKey: GENDER_MICROBATCH_OPERATION,
            genderResultHash: aiContentHash({
                inferredGender: 'unknown', confidence: 'low',
                ownerConsistency: 'mixed_or_unclear', evidenceSelectionIds: [],
            }),
        }));
        await db.query(
            `DELETE FROM public.analysis_v2_ai_result_checkpoints
             WHERE request_id = $1 AND stage = 'genderTriage'`,
            [REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_scheduler_operations (
                request_id, job_key, operation_key, stage, status, result_json
             ) VALUES ($1, 'track:profile-ai:batch:0', $2, 'genderTriage',
                'ready', $3::JSONB)`,
            [REQUEST_ID, GENDER_MICROBATCH_OPERATION, JSON.stringify({
                operationKey: GENDER_MICROBATCH_OPERATION,
                results: [{
                    accountId: `account:${'1'.repeat(64)}`,
                    result: genderResult(assessment),
                    source: 'checkpoint',
                }],
            })]
        );

        await expect(checkpointCandidates(rows)).rejects.toThrow(
            /ANALYSIS_V2_RESULT_NOT_READY/
        );
        await expectNoCandidateCheckpointArtifacts();
    });

    it.each([
        ['missing', undefined],
        ['mismatched', `gender-triage:${'b'.repeat(64)}`],
    ] as const)('rejects a %s root operationKey in the gender microbatch envelope', async (
        _case,
        rootOperationKey,
    ) => {
        await seedCandidateBatch();
        const assessment: Parameters<typeof genderResult>[0] = {
            inferredGender: 'female', confidence: 'high',
            ownerConsistency: 'same_person', evidenceSelectionIds: ['selection-1'],
        };
        const rows = candidateRows().map(row => ({
            ...row,
            genderOperationKey: GENDER_MICROBATCH_OPERATION,
            genderResultHash: aiContentHash(assessment),
        }));
        await db.query(
            `DELETE FROM public.analysis_v2_ai_result_checkpoints
             WHERE request_id = $1 AND stage = 'genderTriage'`,
            [REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_scheduler_operations (
                request_id, job_key, operation_key, stage, status, result_json
             ) VALUES ($1, 'track:profile-ai:batch:0', $2, 'genderTriage',
                'ready', $3::JSONB)`,
            [REQUEST_ID, GENDER_MICROBATCH_OPERATION, JSON.stringify({
                operationKey: rootOperationKey,
                results: [{
                    accountId: `account:${'1'.repeat(64)}`,
                    result: genderResult(assessment),
                    source: 'checkpoint',
                }],
            })]
        );

        await expect(checkpointCandidates(rows)).rejects.toThrow(
            /ANALYSIS_V2_RESULT_NOT_READY/
        );
        await expectNoCandidateCheckpointArtifacts();
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

    it.each([
        'ai-stage-policy-v2.9',
        'ai-stage-policy-v2.10',
    ] as const)('checkpoints both durable pre-feature admission reasons for %s without a feature result or media bundle', async policyVersion => {
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });

        await expect(checkpointCandidates(preFeatureSkipRows(policyVersion))).resolves.toBeDefined();

        await expect(db.query<{
            terminal_classification: string;
            feature_operation_key: string | null;
            feature_result_hash: string | null;
            pre_feature_policy_version: string;
            pre_feature_admission: string;
        }>(`
            SELECT terminal_classification, feature_operation_key, feature_result_hash,
                   pre_feature_policy_version, pre_feature_admission
            FROM public.analysis_v2_candidate_feature_rows
            WHERE request_id = $1
            ORDER BY candidate_id
        `, [REQUEST_ID])).resolves.toMatchObject({ rows: [
            {
                terminal_classification: 'unresolved',
                feature_operation_key: null,
                feature_result_hash: null,
                pre_feature_policy_version: policyVersion,
                pre_feature_admission: 'nonpersonal_or_official',
            },
            {
                terminal_classification: 'unresolved',
                feature_operation_key: null,
                feature_result_hash: null,
                pre_feature_policy_version: policyVersion,
                pre_feature_admission: 'unsupported_unknown',
            },
        ] });
    });

    it('rejects a pre-feature skip with feature-analyzed media without staging rows', async () => {
        const policyVersion = 'ai-stage-policy-v2.9';
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        const rows = preFeatureSkipRows(policyVersion).map(row => ({
            ...row,
            mediaContext: {
                ...row.mediaContext,
                featureAnalyzedSelectionIds: ['selection-1'],
            },
        }));

        await expect(checkpointCandidates(rows)).rejects.toThrow(/ANALYSIS_V2_RESULT_INVALID/);
        await expectNoCandidateCheckpointArtifacts();
    });

    it('rejects a direct policy-only pre-feature provenance insert', async () => {
        const policyVersion = 'ai-stage-policy-v2.9';
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        await checkpointCandidates(preFeatureSkipRows(policyVersion));

        await expect(db.query(`
            INSERT INTO public.analysis_v2_candidate_feature_rows (
                request_id, batch, candidate_id, instagram_id,
                full_name, profile_image_url, bio,
                terminal_classification, media_context,
                appearance_grade, exposure_score, is_business_account,
                feature_partner_evidence_strong, one_line_overview,
                gender_operation_key, gender_result_hash,
                feature_operation_key, feature_result_hash,
                baseline_classification, classification_source,
                gender_resolution_status, gender_resolution_operation_key,
                gender_resolution_result_hash,
                pre_feature_policy_version, pre_feature_admission
            )
            SELECT request_id, batch, 'candidate:policy-only', 'policy.only',
                   full_name, profile_image_url, bio,
                   terminal_classification, media_context,
                   appearance_grade, exposure_score, is_business_account,
                   feature_partner_evidence_strong, one_line_overview,
                   gender_operation_key, gender_result_hash,
                   feature_operation_key, feature_result_hash,
                   baseline_classification, classification_source,
                   gender_resolution_status, gender_resolution_operation_key,
                   gender_resolution_result_hash,
                   pre_feature_policy_version, NULL
            FROM public.analysis_v2_candidate_feature_rows
            WHERE request_id = $1 AND candidate_id = 'candidate:female'
        `, [REQUEST_ID])).rejects.toThrow(
            /analysis_v2_candidate_feature_pre_feature_admission_check/
        );
    });

    it('rejects a direct admission-only pre-feature provenance update', async () => {
        const policyVersion = 'ai-stage-policy-v2.10';
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        await checkpointCandidates(preFeatureSkipRows(policyVersion));

        await expect(db.query(
            `UPDATE public.analysis_v2_candidate_feature_rows
             SET pre_feature_policy_version = NULL
             WHERE request_id = $1 AND candidate_id = 'candidate:female'`,
            [REQUEST_ID]
        )).rejects.toThrow(/analysis_v2_candidate_feature_pre_feature_admission_check/);
    });

    it('rejects a pre-feature retry that changes durable admission provenance', async () => {
        const policyVersion = 'ai-stage-policy-v2.9';
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        const rows = preFeatureSkipRows(policyVersion);

        await expect(checkpointCandidates(rows)).resolves.toBeDefined();
        await expect(checkpointCandidates(rows)).resolves.toBeDefined();

        const beforeRows = await db.query(`
            SELECT candidate_id, terminal_classification, media_context,
                   gender_operation_key, gender_result_hash,
                   pre_feature_policy_version, pre_feature_admission
            FROM public.analysis_v2_candidate_feature_rows
            WHERE request_id = $1
            ORDER BY candidate_id
        `, [REQUEST_ID]);
        const beforeManifest = await db.query(`
            SELECT producer_job_key, producer_input_hash, producer_claim_token,
                   item_count, row_count, result_hash
            FROM public.analysis_v2_candidate_feature_manifests
            WHERE request_id = $1 AND batch = 0
        `, [REQUEST_ID]);
        const changedAdmissionRows = rows.map((row, index) => index === 0
            ? { ...row, preFeatureAdmission: 'unsupported_unknown' }
            : row
        );

        await expect(checkpointCandidates(changedAdmissionRows)).rejects.toThrow(
            /ANALYSIS_V2_RESULT_CONFLICT/
        );

        await expect(db.query(`
            SELECT candidate_id, terminal_classification, media_context,
                   gender_operation_key, gender_result_hash,
                   pre_feature_policy_version, pre_feature_admission
            FROM public.analysis_v2_candidate_feature_rows
            WHERE request_id = $1
            ORDER BY candidate_id
        `, [REQUEST_ID])).resolves.toMatchObject({ rows: beforeRows.rows });
        await expect(db.query(`
            SELECT producer_job_key, producer_input_hash, producer_claim_token,
                   item_count, row_count, result_hash
            FROM public.analysis_v2_candidate_feature_manifests
            WHERE request_id = $1 AND batch = 0
        `, [REQUEST_ID])).resolves.toMatchObject({ rows: beforeManifest.rows });
    });

    it('rejects a pre-feature checkpoint when its gender triage checkpoint is missing without staging rows', async () => {
        const policyVersion = 'ai-stage-policy-v2.9';
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        await db.query(
            `DELETE FROM public.analysis_v2_ai_result_checkpoints
             WHERE request_id = $1 AND operation_key = $2`,
            [REQUEST_ID, FEMALE_GENDER_OPERATION]
        );

        await expect(checkpointCandidates(preFeatureSkipRows(policyVersion))).rejects.toThrow(
            /ANALYSIS_V2_RESULT_NOT_READY/
        );
        await expectNoCandidateCheckpointArtifacts();
    });

    it('rejects a pre-feature checkpoint when its gender triage hash differs without staging rows', async () => {
        const policyVersion = 'ai-stage-policy-v2.10';
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        await db.query(
            `UPDATE public.analysis_v2_ai_result_checkpoints
             SET result_hash = $3
             WHERE request_id = $1 AND operation_key = $2`,
            [REQUEST_ID, FEMALE_GENDER_OPERATION, WRONG_RESULT_HASH]
        );

        await expect(checkpointCandidates(preFeatureSkipRows(policyVersion))).rejects.toThrow(
            /ANALYSIS_V2_RESULT_NOT_READY/
        );
        await expectNoCandidateCheckpointArtifacts();
    });

    it.each([
        ['legacy', undefined],
        ['v2.8', 'ai-stage-policy-v2.8' as const],
        ['eligible v2.9', 'ai-stage-policy-v2.9' as const],
        ['eligible v2.10', 'ai-stage-policy-v2.10' as const],
    ])('fails closed when %s omits the allowed pre-feature admission', async (_label, policyVersion) => {
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion,
        });
        const rows = preFeatureSkipRows('ai-stage-policy-v2.9').map(row => ({
            ...row,
            preFeaturePolicyVersion: null,
            preFeatureAdmission: null,
        }));

        await expect(checkpointCandidates(rows)).rejects.toThrow(/ANALYSIS_V2_RESULT_INVALID/);
    });

    it('rejects a pre-feature admission whose row policy diverges from the request snapshot', async () => {
        await seedCandidateBatch({
            includeFemaleBundle: false,
            includeNonFemaleBundle: false,
            policyVersion: 'ai-stage-policy-v2.10',
        });

        await expect(checkpointCandidates(
            preFeatureSkipRows('ai-stage-policy-v2.9')
        )).rejects.toThrow(/ANALYSIS_V2_RESULT_INVALID/);
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
