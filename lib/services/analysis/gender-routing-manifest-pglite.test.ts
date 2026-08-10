import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisV2GenderRoutingManifestStore } from './gender-routing-manifest-store';
import { createGenderRoutingCanonicalInputHmac } from './gender-routing';
import {
    createAnalysisV2CollectionTopology,
    createAnalysisV2ProfileFetchExecutor,
    createAnalysisV2RelationshipsExecutor,
} from './v2-collection-executors';
import {
    buildAnalysisV2DagPlan,
    type AnalysisV2DagRelationshipManifest,
} from './v2-dag-planner';
import { createSupabaseAnalysisV2DagStateStore } from './v2-dag-state-store';
import type {
    AnalysisV2ProfileAttemptResultInput,
    AnalysisV2ProfileFetchResume,
} from './v2-profile-fetch-store';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql',
        import.meta.url,
    ),
    'utf8',
);

const REQUEST_ID = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
const CLAIM_TOKEN = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
const INPUT_HASH = 'a'.repeat(64);
const CHECKPOINT_ID = 'b'.repeat(64);
const CANONICAL_INPUT_HMAC = 'c'.repeat(64);

let db: PGlite | undefined;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_access_mode_snapshot TEXT NOT NULL,
    selected_plan_id_snapshot TEXT NOT NULL
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    track TEXT NOT NULL DEFAULT 'relationships',
    kind TEXT NOT NULL DEFAULT 'collection',
    batch INTEGER,
    status TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id),
    mode TEXT NOT NULL,
    policy_version TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_relationship_manifests (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    public_count SMALLINT NOT NULL,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_mutual_rows (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    mutual_ordinal SMALLINT NOT NULL,
    username TEXT NOT NULL,
    is_private BOOLEAN NOT NULL,
    PRIMARY KEY (request_id, job_key, username),
    UNIQUE (request_id, job_key, mutual_ordinal),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_v2_relationship_manifests(request_id, job_key)
);
CREATE TABLE public.analysis_v2_dag_scopes (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id),
    schema_version SMALLINT NOT NULL,
    request_snapshot_hash TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    plan_snapshot_hash TEXT NOT NULL,
    exclusion_decision_hash TEXT NOT NULL,
    excluded_count SMALLINT NOT NULL
);
CREATE TABLE public.analysis_v2_dag_stage_manifests (
    request_id UUID NOT NULL REFERENCES public.analysis_v2_dag_scopes(request_id),
    stage_kind TEXT NOT NULL,
    producer_job_key TEXT NOT NULL,
    producer_input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    result_hash TEXT NOT NULL,
    detected_mutual_count INTEGER,
    public_count INTEGER,
    private_count INTEGER,
    detailed_selected_public_count INTEGER,
    not_screened_public_count INTEGER,
    interactor_count INTEGER,
    verified_female_count INTEGER,
    shortlist_count INTEGER,
    shortlist_hash TEXT,
    featured_high_risk_count INTEGER,
    narrative_count INTEGER,
    narrative_batch_hash TEXT,
    PRIMARY KEY (request_id, stage_kind)
);
CREATE TABLE public.analysis_v2_dag_batch_topology (
    request_id UUID NOT NULL REFERENCES public.analysis_v2_dag_scopes(request_id),
    topology_kind TEXT NOT NULL,
    batch INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    producer_job_key TEXT NOT NULL,
    producer_input_hash TEXT NOT NULL,
    PRIMARY KEY (request_id, topology_kind, batch)
);
CREATE TABLE public.analysis_v2_dag_batch_results (
    request_id UUID NOT NULL REFERENCES public.analysis_v2_dag_scopes(request_id),
    result_kind TEXT NOT NULL,
    batch INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    producer_job_key TEXT NOT NULL,
    producer_input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    result_hash TEXT NOT NULL,
    PRIMARY KEY (request_id, result_kind, batch)
);
CREATE FUNCTION public.analysis_v2_dag_bounded_integer(
    p_value JSONB, p_minimum INTEGER, p_maximum INTEGER
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT pg_catalog.jsonb_typeof(p_value) = 'number'
       AND p_value::TEXT ~ '^(0|[1-9][0-9]{0,6})$'
       AND (p_value::TEXT)::NUMERIC BETWEEN p_minimum AND p_maximum
$$;
CREATE FUNCTION public.checkpoint_analysis_v2_dag_manifest(
    UUID, TEXT, TEXT, UUID, TEXT, JSONB
) RETURNS JSONB LANGUAGE sql AS $$ SELECT NULL::JSONB $$;
`;

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db!.exec('SET ROLE service_role');
    try {
        return await db!.query<T>(sql, params);
    } finally {
        await db!.exec('RESET ROLE');
    }
}

function rows() {
    return Array.from({ length: 101 }, (_, index) => {
        const ordinal = index + 1;
        const selected = ordinal !== 100;
        const selectedOrdinal = ordinal <= 80
            ? ordinal
            : ordinal === 101
                ? 81
                : ordinal <= 99
                    ? ordinal + 1
                    : null;
        return {
            mutualOrdinal: ordinal,
            candidateKey: `mutual:${ordinal}`,
            hasImage: true,
            hasName: true,
            imageContentHmac: 'd'.repeat(64),
            fullnameHmac: 'e'.repeat(64),
            femaleScore: ordinal === 101 ? 0 : 0.8,
            maleScore: ordinal === 101 ? 0 : 0.1,
            uncertaintyScore: ordinal === 101 ? 1 : 0.1,
            evidence: 'image_and_name',
            bucket: ordinal === 101 ? 'uncertainty' : 'female_priority',
            routingUnavailable: ordinal === 101,
            selected,
            selectionReason: ordinal <= 80
                ? 'female_quota'
                : ordinal === 101
                    ? 'uncertainty_quota'
                    : selected ? 'fill' : 'not_selected',
            selectionSlot: ordinal <= 80
                ? 'female'
                : ordinal === 101
                    ? 'uncertainty'
                    : selected ? 'fill' : null,
            ordinal: selectedOrdinal,
        };
    });
}

async function seed(): Promise<void> {
    await db!.exec(bootstrap);
    await db!.exec(migration);
    await db!.query(
        `INSERT INTO public.analysis_requests (
            id, pipeline_version, status, plan_access_mode_snapshot, selected_plan_id_snapshot
         ) VALUES ($1, 'v2', 'processing', 'test_entitlement', 'basic')`,
        [REQUEST_ID],
    );
    await db!.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, input_hash, lease_token, lease_expires_at
         ) VALUES ($1, 'track:relationships:collect', 'processing', $2, $3,
             pg_catalog.clock_timestamp() + INTERVAL '10 minutes')`,
        [REQUEST_ID, INPUT_HASH, CLAIM_TOKEN],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_provider_execution_policies (request_id, mode, policy_version)
         VALUES ($1, 'test_operation_split', 'authorized-free-e2e-v1')`,
        [REQUEST_ID],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_relationship_manifests (
            request_id, job_key, result_hash, public_count
         ) VALUES ($1, 'track:relationships:collect', $2, 101)`,
        [REQUEST_ID, CHECKPOINT_ID],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_dag_scopes (
            request_id, schema_version, request_snapshot_hash, plan_id, plan_snapshot_hash,
            exclusion_decision_hash, excluded_count
         ) VALUES ($1, 2, $2, 'basic', $3, $4, 1)`,
        [REQUEST_ID, 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_mutual_rows (
            request_id, job_key, mutual_ordinal, username, is_private
         ) SELECT $1, 'track:relationships:collect', value::SMALLINT,
                  'fixture_' || value::TEXT, FALSE
           FROM pg_catalog.generate_series(1, 101) AS value`,
        [REQUEST_ID],
    );
}

async function begin(populationCount = 101) {
    return asService<{ result: { status: string; attemptCount: number } }>(
        `SELECT public.begin_analysis_v2_gender_routing_manifest(
            $1, 'track:relationships:collect', $2, $3, $4, 'gender-routing-v1',
            'basic', $5, $6, 100
         ) AS result`,
        [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, CHECKPOINT_ID, CANONICAL_INPUT_HMAC, populationCount],
    );
}

async function publish(payload = rows()) {
    return asService<{ result: { status: string; selectedCount: number } }>(
        `SELECT public.publish_analysis_v2_gender_routing_manifest(
            $1, 'track:relationships:collect', $2, $3, $4, 'gender-routing-v1',
            'basic', $5, 101, 100, 100, 101, 100, 1, 1, 0, 19, 100, 1, 0,
            99, 1, 0, $6::JSONB
         ) AS result`,
        [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, CHECKPOINT_ID, CANONICAL_INPUT_HMAC, payload],
    );
}

async function loadSelected(
    planId: 'basic' | 'standard' = 'basic',
    relationshipCheckpointId = CHECKPOINT_ID,
) {
    return asService<{ result: { selectedCount: number; rows: Array<{ ordinal: number }> } }>(
        `SELECT public.load_analysis_v2_gender_routing_selected(
            $1, $2, 'gender-routing-v1', $3
         ) AS result`,
        [REQUEST_ID, relationshipCheckpointId, planId],
    );
}

async function loadSelectedUsernames(
    planId: 'basic' | 'standard' = 'basic',
    relationshipCheckpointId = CHECKPOINT_ID,
) {
    return asService<{ result: { selectedCount: number; rows: Array<{ ordinal: number; username: string }> } }>(
        `SELECT public.load_analysis_v2_gender_routing_selected_usernames(
            $1, $2, 'gender-routing-v1', $3
         ) AS result`,
        [REQUEST_ID, relationshipCheckpointId, planId],
    );
}

function relationshipSelectionCheckpoint(overrides: Record<string, unknown> = {}) {
    return {
        revision: 1,
        resultHash: CHECKPOINT_ID,
        detectedMutualCount: 101,
        publicCount: 101,
        privateCount: 0,
        detailedSelectedPublicCount: 100,
        notScreenedPublicCount: 1,
        profileBatches: [30, 30, 30, 10].map((itemCount, batch) => ({
            batch,
            itemCount,
            inputHash: String(batch + 1).repeat(64),
        })),
        privateNameBatches: [],
        relationshipSelectionPolicy: {
            policyVersion: 'gender-routing-v1',
            relationshipCheckpointId: CHECKPOINT_ID,
            relationshipJobInputHash: INPUT_HASH,
            planId: 'basic',
            publicPopulationCount: 101,
            selectedCount: 100,
        },
        ...overrides,
    };
}

async function checkpointRelationshipSelection(manifest = relationshipSelectionCheckpoint()) {
    return asService<{ result: unknown }>(
        `SELECT public.checkpoint_analysis_v2_dag_manifest(
            $1, 'track:relationships:collect', $2, $3, 'relationships', $4::JSONB
         ) AS result`,
        [REQUEST_ID, INPUT_HASH, CLAIM_TOKEN, JSON.stringify(manifest)],
    );
}

function standardRelationshipSelectionCheckpoint(): AnalysisV2DagRelationshipManifest {
    return {
        ...relationshipSelectionCheckpoint({
            detectedMutualCount: 201,
            publicCount: 201,
            detailedSelectedPublicCount: 200,
            notScreenedPublicCount: 1,
            profileBatches: [30, 30, 30, 30, 30, 30, 20].map((itemCount, batch) => ({
                batch,
                itemCount,
                inputHash: String(batch + 1).repeat(64),
            })),
        }),
        relationshipSelectionPolicy: {
            policyVersion: 'gender-routing-v1' as const,
            relationshipCheckpointId: CHECKPOINT_ID,
            relationshipJobInputHash: INPUT_HASH,
            planId: 'standard' as const,
            publicPopulationCount: 201,
            selectedCount: 200,
        },
    };
}

async function seedCompleteStandardRoutingManifest(): Promise<void> {
    await db!.query(
        `UPDATE public.analysis_requests
         SET selected_plan_id_snapshot = 'standard' WHERE id = $1`,
        [REQUEST_ID],
    );
    await db!.query(
        `UPDATE public.analysis_v2_dag_scopes SET plan_id = 'standard' WHERE request_id = $1`,
        [REQUEST_ID],
    );
    await db!.query(
        `UPDATE public.analysis_v2_relationship_manifests
         SET public_count = 201 WHERE request_id = $1`,
        [REQUEST_ID],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_mutual_rows (
            request_id, job_key, mutual_ordinal, username, is_private
         ) SELECT $1, 'track:relationships:collect', value::SMALLINT,
                  'fixture_' || value::TEXT, FALSE
           FROM pg_catalog.generate_series(102, 201) AS value`,
        [REQUEST_ID],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_gender_routing_manifests (
            request_id, relationship_job_key, relationship_job_input_hash,
            relationship_checkpoint_id, policy_version, plan_id, detailed_cap,
            population_count, canonical_input_hmac, status, selected_count,
            model_attempted_count, model_valid_count, model_failed_count, model_retried_count,
            quota_female_shortfall, quota_uncertainty_shortfall, female_priority_count,
            uncertainty_count, male_deprioritized_count, selected_female_priority_count,
            selected_uncertainty_count, selected_male_deprioritized_count, candidate_rows_hash,
            completed_at
         ) VALUES (
            $1, 'track:relationships:collect', $2, $3, 'gender-routing-v1', 'standard',
            200, 201, $4, 'complete', 200, 0, 0, 0, 0, 0, 0, 0, 0, 201, 0, 0, 200,
            $5, pg_catalog.clock_timestamp()
         )`,
        [REQUEST_ID, INPUT_HASH, CHECKPOINT_ID, CANONICAL_INPUT_HMAC, 'd'.repeat(32)],
    );
    await db!.query(
        `INSERT INTO public.analysis_v2_gender_routing_candidates (
            request_id, relationship_checkpoint_id, policy_version, relationship_job_key,
            mutual_ordinal, candidate_key, has_image, has_name, bucket, routing_unavailable,
            selected, selection_reason, selection_slot, ordinal
         ) SELECT $1, $2, 'gender-routing-v1', 'track:relationships:collect',
                  value::SMALLINT, 'mutual:' || value::TEXT, FALSE, FALSE,
                  'male_deprioritized', FALSE, value <= 200,
                  CASE WHEN value <= 200 THEN 'fill' ELSE 'not_selected' END,
                  CASE WHEN value <= 200 THEN 'fill' ELSE NULL END,
                  CASE WHEN value <= 200 THEN value::SMALLINT ELSE NULL END
           FROM pg_catalog.generate_series(1, 201) AS value`,
        [REQUEST_ID, CHECKPOINT_ID],
    );
}

function pgliteManifestStore() {
    return createAnalysisV2GenderRoutingManifestStore({
        rpc: async (name, params) => {
            const ordered = name === 'begin_analysis_v2_gender_routing_manifest'
                ? [
                    params.p_request_id, params.p_job_key, params.p_claim_token, params.p_job_input_hash,
                    params.p_relationship_checkpoint_id, params.p_policy_version, params.p_plan_id,
                    params.p_canonical_input_hmac, params.p_population_count, params.p_detailed_cap,
                ]
                : name === 'publish_analysis_v2_gender_routing_manifest'
                    ? [
                        params.p_request_id, params.p_job_key, params.p_claim_token, params.p_job_input_hash,
                        params.p_relationship_checkpoint_id, params.p_policy_version, params.p_plan_id,
                        params.p_canonical_input_hmac, params.p_population_count, params.p_detailed_cap,
                        params.p_selected_count, params.p_model_attempted_count, params.p_model_valid_count,
                        params.p_model_failed_count, params.p_model_retried_count, params.p_quota_female_shortfall,
                        params.p_quota_uncertainty_shortfall, params.p_female_priority_count,
                        params.p_uncertainty_count, params.p_male_deprioritized_count,
                        params.p_selected_female_priority_count, params.p_selected_uncertainty_count,
                        params.p_selected_male_deprioritized_count, JSON.stringify(params.p_rows),
                    ]
                    : [
                        params.p_request_id, params.p_relationship_checkpoint_id,
                        params.p_policy_version, params.p_plan_id,
                    ];
            const cast = ordered.map((_, index) => (
                name === 'publish_analysis_v2_gender_routing_manifest' && index === ordered.length - 1
                    ? `$${index + 1}::JSONB`
                    : `$${index + 1}`
            )).join(', ');
            try {
                const result = await asService<{ result: unknown }>(
                    `SELECT public.${name}(${cast}) AS result`,
                    ordered,
                );
                return { data: result.rows[0]?.result ?? null, error: null };
            } catch (error) {
                return {
                    data: null,
                    error: { message: error instanceof Error ? error.message : String(error) },
                };
            }
        },
    });
}

function pgliteDagStateStore() {
    return createSupabaseAnalysisV2DagStateStore({
        rpc: async (name, params) => {
            const ordered = name === 'checkpoint_analysis_v2_dag_manifest'
                ? [
                    params.p_request_id,
                    params.p_job_key,
                    params.p_input_hash,
                    params.p_claim_token,
                    params.p_manifest_kind,
                    JSON.stringify(params.p_manifest),
                ]
                : [params.p_request_id];
            const cast = name === 'checkpoint_analysis_v2_dag_manifest'
                ? '$1, $2, $3, $4, $5, $6::JSONB'
                : '$1';
            try {
                const result = await asService<{ result: unknown }>(
                    `SELECT public.${name}(${cast}) AS result`,
                    ordered,
                );
                return { data: result.rows[0]?.result ?? null, error: null };
            } catch (error) {
                return {
                    data: null,
                    error: { message: error instanceof Error ? error.message : String(error) },
                };
            }
        },
    });
}

afterEach(async () => {
    await db?.close();
    db = undefined;
});

describe('analysis V2 gender-routing manifest PGlite authority', () => {
    it('rejects a truncated Basic population instead of accepting it as manifest lineage', async () => {
        db = await PGlite.create();
        await seed();
        await db.query(
            `UPDATE public.analysis_v2_relationship_manifests
             SET public_count = 401
             WHERE request_id = $1 AND job_key = 'track:relationships:collect'`,
            [REQUEST_ID],
        );

        await expect(begin(400)).rejects.toThrow(
            'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH',
        );
    }, 30_000);

    it('publishes once atomically, is idempotent, and only exposes the exact selected ordinal topology', async () => {
        db = await PGlite.create();
        await seed();

        const begins = await Promise.all([begin(), begin()]);
        expect(begins.map(result => result.rows[0]?.result.attemptCount).sort()).toEqual([1, 2]);
        const concurrent = await Promise.all([publish(), publish()]);
        for (const result of concurrent) {
            expect(result.rows[0]?.result).toMatchObject({ status: 'complete', selectedCount: 100 });
        }
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_v2_gender_routing_candidates',
        )).rows).toEqual([{ count: 101 }]);

        const selected = await loadSelected();
        expect(selected.rows[0]?.result.selectedCount).toBe(100);
        expect(selected.rows[0]?.result.rows.map(row => row.ordinal)).toEqual(
            Array.from({ length: 100 }, (_, index) => index + 1),
        );
        await expect(publish()).resolves.toMatchObject({ rows: [{ result: { status: 'complete', selectedCount: 100 } }] });

        const drift = rows();
        drift[0] = { ...drift[0]!, femaleScore: 0.7, maleScore: 0.2 };
        await expect(publish(drift)).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CONFLICT');
    }, 30_000);

    it('does not consume stale, building, or invalidated manifests and keeps tables/RPCs service-only', async () => {
        db = await PGlite.create();
        await seed();
        await begin();
        await expect(loadSelected()).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_COMPLETE');
        await publish();
        await expect(loadSelected('standard')).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DRIFT');
        await db!.query(
            `UPDATE public.analysis_v2_gender_routing_manifests
             SET status = 'invalidated', invalidated_at = pg_catalog.clock_timestamp()
             WHERE request_id = $1`, [REQUEST_ID],
        );
        await expect(loadSelected()).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_COMPLETE');

        for (const role of ['anon', 'authenticated']) {
            await db!.exec(`SET ROLE ${role}`);
            try {
                await expect(db!.query(
                    'SELECT * FROM public.analysis_v2_gender_routing_candidates',
                )).rejects.toThrow(/permission denied/i);
                await expect(db!.query(
                    `SELECT public.load_analysis_v2_gender_routing_selected(
                        $1, $2, 'gender-routing-v1', 'basic'
                     )`, [REQUEST_ID, CHECKPOINT_ID],
                )).rejects.toThrow(/permission denied/i);
            } finally {
                await db!.exec('RESET ROLE');
            }
        }
    }, 30_000);

    it('accepts only a complete, authorized Basic routing marker and retains it through the DAG RPC round-trip', async () => {
        db = await PGlite.create();
        await seed();
        await begin();

        await expect(checkpointRelationshipSelection()).rejects.toThrow(
            'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH',
        );

        await publish();
        const accepted = await checkpointRelationshipSelection();
        expect(accepted.rows[0]?.result).toMatchObject({
            relationships: {
                detailedSelectedPublicCount: 100,
                relationshipSelectionPolicy: {
                    policyVersion: 'gender-routing-v1',
                    relationshipCheckpointId: CHECKPOINT_ID,
                    relationshipJobInputHash: INPUT_HASH,
                    planId: 'basic',
                    publicPopulationCount: 101,
                    selectedCount: 100,
                },
            },
        });
        await expect(checkpointRelationshipSelection()).resolves.toMatchObject({
            rows: [{ result: { relationships: { detailedSelectedPublicCount: 100 } } }],
        });
        const loaded = await asService<{ result: unknown }>(
            'SELECT public.load_analysis_v2_dag_state($1) AS result',
            [REQUEST_ID],
        );
        expect(loaded.rows[0]?.result).toMatchObject({
            relationships: {
                relationshipSelectionPolicy: { selectedCount: 100 },
            },
        });
    }, 30_000);

    it('accepts the complete Standard 201-public marker and schedules exactly 200 durable profiles', async () => {
        db = await PGlite.create();
        await seed();
        await seedCompleteStandardRoutingManifest();

        const dagStateStore = pgliteDagStateStore();
        const state = await dagStateStore.checkpointManifest({
            requestId: REQUEST_ID,
            jobKey: 'track:relationships:collect',
            inputHash: INPUT_HASH,
            claimToken: CLAIM_TOKEN,
        }, {
            kind: 'relationships',
            manifest: standardRelationshipSelectionCheckpoint(),
        });
        expect(state.relationships?.relationshipSelectionPolicy).toMatchObject({
            planId: 'standard',
            publicPopulationCount: 201,
            selectedCount: 200,
        });
        const plan = buildAnalysisV2DagPlan(REQUEST_ID, state);
        const profiles = plan.jobs.filter(job => job.track === 'profiles');
        expect(profiles).toHaveLength(7);
        expect(profiles.reduce(
            (count, job) => count + state.relationships!.profileBatches[job.batch!]!.itemCount,
            0,
        )).toBe(200);
    }, 30_000);

    it('rejects forged, invalidated, production, beta, and Plus routing markers', async () => {
        db = await PGlite.create();
        await seed();
        await begin();
        await publish();

        await expect(checkpointRelationshipSelection(relationshipSelectionCheckpoint({
            relationshipSelectionPolicy: {
                ...relationshipSelectionCheckpoint().relationshipSelectionPolicy,
                relationshipCheckpointId: 'f'.repeat(64),
            },
        }))).rejects.toThrow(/ANALYSIS_V2_DAG_STATE_(INVALID|FENCE_MISMATCH)/);

        const cases = [
            [
                'invalidated',
                `UPDATE public.analysis_v2_gender_routing_manifests
                 SET status = 'invalidated', invalidated_at = pg_catalog.clock_timestamp()
                 WHERE request_id = $1`,
                `UPDATE public.analysis_v2_gender_routing_manifests
                 SET status = 'complete', invalidated_at = NULL
                 WHERE request_id = $1`,
            ],
            [
                'production',
                `UPDATE public.analysis_requests
                 SET plan_access_mode_snapshot = 'production' WHERE id = $1`,
                `UPDATE public.analysis_requests
                 SET plan_access_mode_snapshot = 'test_entitlement' WHERE id = $1`,
            ],
            [
                'beta',
                `UPDATE public.analysis_v2_provider_execution_policies
                 SET mode = 'betatest_free_pool' WHERE request_id = $1`,
                `UPDATE public.analysis_v2_provider_execution_policies
                 SET mode = 'test_operation_split' WHERE request_id = $1`,
            ],
            [
                'Plus',
                `UPDATE public.analysis_requests
                 SET selected_plan_id_snapshot = 'plus' WHERE id = $1`,
                `UPDATE public.analysis_requests
                 SET selected_plan_id_snapshot = 'basic' WHERE id = $1`,
            ],
        ] as const;
        for (const [label, introduce, restore] of cases) {
            await db!.query(introduce, [REQUEST_ID]);
            await expect(checkpointRelationshipSelection(), label).rejects.toThrow(
                'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH',
            );
            await db!.query(restore, [REQUEST_ID]);
        }
    }, 30_000);

    it('re-fences both selected loaders against current scope, policy, job input, relationship count, and corruption', async () => {
        db = await PGlite.create();
        await seed();
        await begin();
        await publish();
        await expect(loadSelected()).resolves.toMatchObject({ rows: [{ result: { selectedCount: 100 } }] });
        await expect(loadSelectedUsernames()).resolves.toMatchObject({ rows: [{ result: { selectedCount: 100 } }] });

        const driftCases = [
            ['pipeline version', `UPDATE public.analysis_requests SET pipeline_version = 'v1' WHERE id = $1`, `UPDATE public.analysis_requests SET pipeline_version = 'v2' WHERE id = $1`],
            ['request status', `UPDATE public.analysis_requests SET status = 'pending' WHERE id = $1`, `UPDATE public.analysis_requests SET status = 'processing' WHERE id = $1`],
            ['access mode', `UPDATE public.analysis_requests SET plan_access_mode_snapshot = 'production' WHERE id = $1`, `UPDATE public.analysis_requests SET plan_access_mode_snapshot = 'test_entitlement' WHERE id = $1`],
            ['plan snapshot', `UPDATE public.analysis_requests SET selected_plan_id_snapshot = 'standard' WHERE id = $1`, `UPDATE public.analysis_requests SET selected_plan_id_snapshot = 'basic' WHERE id = $1`],
            ['provider mode', `UPDATE public.analysis_v2_provider_execution_policies SET mode = 'production' WHERE request_id = $1`, `UPDATE public.analysis_v2_provider_execution_policies SET mode = 'test_operation_split' WHERE request_id = $1`],
            ['provider policy', `UPDATE public.analysis_v2_provider_execution_policies SET policy_version = 'wrong' WHERE request_id = $1`, `UPDATE public.analysis_v2_provider_execution_policies SET policy_version = 'authorized-free-e2e-v1' WHERE request_id = $1`],
            ['relationship job input', `UPDATE public.analysis_pipeline_jobs SET input_hash = $2 WHERE request_id = $1 AND job_key = 'track:relationships:collect'`, `UPDATE public.analysis_pipeline_jobs SET input_hash = $2 WHERE request_id = $1 AND job_key = 'track:relationships:collect'`],
            ['public count', `UPDATE public.analysis_v2_relationship_manifests SET public_count = 100 WHERE request_id = $1`, `UPDATE public.analysis_v2_relationship_manifests SET public_count = 101 WHERE request_id = $1`],
        ] as const;
        for (const [label, introduce, restore] of driftCases) {
            const needsHash = label === 'relationship job input';
            await db!.query(introduce, needsHash ? [REQUEST_ID, 'f'.repeat(64)] : [REQUEST_ID]);
            await expect(loadSelected(), label).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH');
            await expect(loadSelectedUsernames(), label).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH');
            await db!.query(restore, needsHash ? [REQUEST_ID, INPUT_HASH] : [REQUEST_ID]);
        }
        await expect(loadSelected('basic', 'f'.repeat(64)))
            .rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_MISSING');
        await expect(loadSelectedUsernames('basic', 'f'.repeat(64)))
            .rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_MISSING');
        await expect(db!.query(
            `UPDATE public.analysis_v2_relationship_manifests SET result_hash = $2 WHERE request_id = $1`,
            [REQUEST_ID, 'f'.repeat(64)],
        )).rejects.toThrow(/foreign key/i);
        await db!.query(
            `DELETE FROM public.analysis_v2_gender_routing_candidates
             WHERE request_id = $1 AND relationship_checkpoint_id = $2 AND mutual_ordinal = 101`,
            [REQUEST_ID, CHECKPOINT_ID],
        );
        await expect(loadSelected()).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CORRUPT');
        await expect(loadSelectedUsernames()).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CORRUPT');
    }, 30_000);

    it('drives the real relationship and profile executors from the typed PGlite manifest store', async () => {
        db = await PGlite.create();
        await seed();
        const manifestStore = pgliteManifestStore();
        const mutualRows = Array.from({ length: 101 }, (_, index) => ({
            username: `fixture_${index + 1}`,
            isPrivate: false,
            isVerified: false,
            fullName: `Fixture ${index + 1}`,
            profilePicUrl: `https://raw-image.example/${index + 1}?volatile=true`,
            mutualOrdinal: index + 1,
            followingOrdinal: index + 1,
            detailedOrdinal: index + 1,
        }));
        const hmacSecret = 'pglite-routing-secret-at-least-thirty-two-characters';
        const canonicalInputHmac = createGenderRoutingCanonicalInputHmac({
            hmacSecret,
            candidates: mutualRows.map(row => ({
                candidateKey: `mutual:${row.mutualOrdinal}`,
                fullname: row.fullName,
                imageContentHmac: null,
            })),
        });
        const request = {
            requestId: REQUEST_ID,
            targetUsername: 'target_fixture',
            excludedUsername: 'excluded_fixture',
            accessMode: 'test_entitlement' as const,
            providerExecutionPolicy: {
                mode: 'test_operation_split' as const,
                policyVersion: 'authorized-free-e2e-v1',
                operationSlots: {
                    'target-profile': 'tertiary',
                    'relationship-followers': 'primary',
                    'relationship-following': 'secondary',
                    'profile-fallback': 'tertiary',
                    'target-likers': 'quaternary',
                    'target-comments': 'tertiary',
                    'candidate-likers': 'quinary',
                },
            } as const,
            planId: 'basic' as const,
            followersDeclaredCount: 0,
            followingDeclaredCount: 0,
            detailedMutualLimit: 300 as const,
        };
        const evidenceStore = {
            checkpointRelationshipSide: async () => ({}),
            freezeRelationships: async () => ({
                revision: 1,
                resultHash: CHECKPOINT_ID,
                exclusionDecisionHash: 'f'.repeat(64),
                followersResultHash: 'f'.repeat(64),
                followingResultHash: 'f'.repeat(64),
                mutualCount: 101,
                publicCount: 101,
                privateCount: 0,
                detailedPublicCount: 101,
                unscreenedPublicCount: 0,
            }),
            loadRelationshipStaging: async () => ({
                excludedUsername: 'excluded_fixture',
                detailedPublicUsernames: mutualRows.map(row => row.username),
                privateMutualUsernames: [],
                mutualRows,
            }),
        };
        const scope = {
            schemaVersion: 2,
            requestSnapshotHash: 'd'.repeat(64),
            planId: 'basic',
            planSnapshotHash: 'e'.repeat(64),
            girlfriendExclusion: { decisionHash: 'f'.repeat(64), excludedCount: 1 as const },
        };
        const relationshipContext = {
            stage: 'relationships',
            claim: {
                requestId: REQUEST_ID, jobKey: 'track:relationships:collect', track: 'relationships',
                kind: 'collection', batch: null, inputHash: INPUT_HASH, generation: 1,
                reservationToken: CLAIM_TOKEN, claimToken: CLAIM_TOKEN, attemptCount: 1,
            },
            job: {
                requestId: REQUEST_ID, jobKey: 'track:relationships:collect', track: 'relationships',
                kind: 'collection', batch: null, inputHash: INPUT_HASH, requiredJobKeys: [],
            },
            state: scope,
            aiStagePolicyVersion: null,
            riskPolicyVersion: null,
        } as Parameters<ReturnType<typeof createAnalysisV2RelationshipsExecutor>>[0];
        let profileResume: AnalysisV2ProfileFetchResume | null = null;
        const profileCheckpointStore = {
            load: vi.fn(async () => profileResume),
            checkpointPrimary: vi.fn(async (input: {
                requestId: string;
                jobKey: string;
                requestedUsernames: readonly string[];
                results: readonly AnalysisV2ProfileAttemptResultInput[];
            }) => {
                profileResume = {
                    requestId: input.requestId,
                    jobKey: input.jobKey,
                    requestedUsernames: [...input.requestedUsernames],
                    frozenUnresolvedUsernames: input.results
                        .filter(result => result.outcome.status !== 'success')
                        .map(result => result.outcome.requestedUsername),
                    primaryResults: input.results as AnalysisV2ProfileFetchResume['primaryResults'],
                    fallbackResults: [],
                    primaryCapturedAt: '2026-08-11T00:00:00.000Z',
                    fallbackCapturedAt: null,
                    repairResults: [],
                    repairUsernames: null,
                    repairCapturedAt: null,
                };
                return profileResume;
            }),
            checkpointFallback: vi.fn(async () => {
                throw new Error('unexpected paid fallback');
            }),
            checkpointRepair: vi.fn(async () => {
                throw new Error('unexpected paid repair');
            }),
            purgeTerminal: vi.fn(async () => 0),
        };
        const profileFetcher = vi.fn(async (
            usernames: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1],
        ) => {
            const results = usernames.map(username => ({
                outcome: {
                    requestedUsername: username,
                    source: 'selfhosted' as const,
                    status: 'success' as const,
                    failureCategory: null,
                    httpStatus: null,
                    requestCount: 1,
                    latencyMs: 1,
                    capturedAt: '2026-08-11T00:00:00.000Z',
                },
                profile: {
                    username,
                    fullName: `Profile ${username}`,
                    followersCount: 1,
                    followingCount: 1,
                    postsCount: 0,
                    isPrivate: false,
                    isVerified: false,
                    latestPosts: [],
                },
            }));
            await options.persistAttemptOutcomes({
                attempt: 'primary',
                source: 'selfhosted',
                requestedUsernames: usernames,
                results,
            });
            return {
                results,
                profiles: results.map(result => result.profile),
                primaryResults: results,
                fallbackResults: [],
                frozenUnresolvedUsernames: [],
            };
        });
        const profileContext = (relationships: unknown) => ({
            stage: 'profile_fetch',
            claim: {
                requestId: REQUEST_ID, jobKey: 'track:profiles:batch:0', track: 'profiles',
                kind: 'profile_fetch', batch: 0, inputHash: INPUT_HASH, generation: 1,
                reservationToken: CLAIM_TOKEN, claimToken: CLAIM_TOKEN, attemptCount: 1,
            },
            job: {
                requestId: REQUEST_ID, jobKey: 'track:profiles:batch:0', track: 'profiles',
                kind: 'profile_fetch', batch: 0, inputHash: INPUT_HASH,
                requiredJobKeys: ['track:relationships:collect'],
            },
            state: { ...scope, relationships },
            aiStagePolicyVersion: null,
            riskPolicyVersion: null,
        }) as Parameters<ReturnType<typeof createAnalysisV2ProfileFetchExecutor>>[0];
        const profileExecutor = createAnalysisV2ProfileFetchExecutor({
            requestContextStore: { load: async () => request },
            evidenceStore: evidenceStore as never,
            profileCheckpointStore: profileCheckpointStore as never,
            genderRoutingManifestStore: manifestStore,
            getProfilesBatchV2: profileFetcher as never,
            env: { ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET: hmacSecret },
        });

        await manifestStore.begin({
            requestId: REQUEST_ID,
            jobKey: 'track:relationships:collect',
            claimToken: CLAIM_TOKEN,
            jobInputHash: INPUT_HASH,
            relationshipCheckpointId: CHECKPOINT_ID,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
            canonicalInputHmac,
            populationCount: 101,
            detailedCap: 100,
        });
        const blockedTopology = createAnalysisV2CollectionTopology('profiles', mutualRows.slice(0, 100).map(row => row.username));
        const blockedRelationships = {
            revision: 1, resultHash: CHECKPOINT_ID, detectedMutualCount: 101,
            publicCount: 101, privateCount: 0, detailedSelectedPublicCount: 100,
            notScreenedPublicCount: 1, profileBatches: blockedTopology, privateNameBatches: [],
        };
        await expect(profileExecutor(profileContext(blockedRelationships))).rejects.toThrow();
        expect(profileFetcher).not.toHaveBeenCalled();

        const relationshipExecutor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: { load: async () => request },
            evidenceStore: evidenceStore as never,
            genderRoutingManifestStore: manifestStore,
            revenueGenderRoutingAssessor: async candidates => new Map(candidates.map(candidate => [
                candidate.candidateKey,
                candidate.candidateKey === 'mutual:1'
                    ? { femaleScore: 0.05, maleScore: 0.9, uncertaintyScore: 0.05, evidence: 'name_only' as const }
                    : { femaleScore: 0.9, maleScore: 0.05, uncertaintyScore: 0.05, evidence: 'name_only' as const },
            ])),
            env: { ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET: hmacSecret },
        });
        const relationship = await relationshipExecutor(relationshipContext);
        const selected = await manifestStore.loadSelectedUsernames({
            requestId: REQUEST_ID,
            relationshipCheckpointId: CHECKPOINT_ID,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
        });
        const selectedUsernames = selected.map(row => row.username);
        expect(relationship.checkpoint.manifest.profileBatches).toEqual(
            createAnalysisV2CollectionTopology('profiles', selectedUsernames),
        );
        const dagStateStore = pgliteDagStateStore();
        const persistedState = await dagStateStore.checkpointManifest({
            requestId: REQUEST_ID,
            jobKey: 'track:relationships:collect',
            inputHash: INPUT_HASH,
            claimToken: CLAIM_TOKEN,
        }, relationship.checkpoint);
        expect(persistedState.relationships?.relationshipSelectionPolicy).toEqual({
            policyVersion: 'gender-routing-v1',
            relationshipCheckpointId: CHECKPOINT_ID,
            relationshipJobInputHash: INPUT_HASH,
            planId: 'basic',
            publicPopulationCount: 101,
            selectedCount: 100,
        });
        const persistedPlan = buildAnalysisV2DagPlan(REQUEST_ID, persistedState);
        expect(persistedPlan.jobs.filter(job => job.track === 'profiles')).toHaveLength(4);
        expect(persistedPlan.jobs.filter(job => job.track === 'profiles').reduce(
            (count, job) => count + persistedState.relationships!.profileBatches[job.batch!]!.itemCount,
            0,
        )).toBe(100);
        const profile = await profileExecutor(profileContext(persistedState.relationships));
        expect(profileFetcher).toHaveBeenCalledWith(selectedUsernames.slice(0, 30), expect.any(Object));
        expect(profile.checkpoint.manifest).toMatchObject({
            batch: 0,
            itemCount: 30,
            producerInputHash: INPUT_HASH,
            resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });

        await db!.query(
            `UPDATE public.analysis_requests SET status = 'pending' WHERE id = $1`,
            [REQUEST_ID],
        );
        await expect(profileExecutor(profileContext(relationship.checkpoint.manifest))).rejects.toThrow();
        expect(profileFetcher).toHaveBeenCalledTimes(1);
        await db!.query(
            `UPDATE public.analysis_requests SET status = 'processing' WHERE id = $1`,
            [REQUEST_ID],
        );
        await db!.query(
            `UPDATE public.analysis_v2_gender_routing_manifests
             SET status = 'invalidated', invalidated_at = pg_catalog.clock_timestamp()
             WHERE request_id = $1`,
            [REQUEST_ID],
        );
        await expect(profileExecutor(profileContext(relationship.checkpoint.manifest))).rejects.toThrow();
        expect(profileFetcher).toHaveBeenCalledTimes(1);
    }, 30_000);

    it('rejects malformed evidence and non-contiguous selected ordinals inside the publish transaction', async () => {
        db = await PGlite.create();
        await seed();
        await begin();

        const wrongEvidence = rows();
        wrongEvidence[0] = { ...wrongEvidence[0]!, evidence: 'name_only' };
        await expect(publish(wrongEvidence)).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID');
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_v2_gender_routing_candidates',
        )).rows).toEqual([{ count: 0 }]);

        const duplicateOrdinal = rows();
        duplicateOrdinal[1] = { ...duplicateOrdinal[1]!, ordinal: 1 };
        await expect(publish(duplicateOrdinal)).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID');
    }, 30_000);
});
