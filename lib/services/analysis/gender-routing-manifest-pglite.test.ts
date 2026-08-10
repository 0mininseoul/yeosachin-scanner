import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

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

        await expect(begin()).resolves.toMatchObject({ rows: [{ result: { status: 'building', attemptCount: 1 } }] });
        const concurrent = await Promise.all([publish(), publish()]);
        for (const result of concurrent) {
            expect(result.rows[0]?.result).toMatchObject({ status: 'complete', selectedCount: 100 });
        }
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_v2_gender_routing_candidates',
        )).rows).toEqual([{ count: 101 }]);

        const selected = await asService<{ result: { selectedCount: number; rows: Array<{ ordinal: number }> } }>(
            `SELECT public.load_analysis_v2_gender_routing_selected(
                $1, $2, 'gender-routing-v1', 'basic', $3
             ) AS result`,
            [REQUEST_ID, CHECKPOINT_ID, CANONICAL_INPUT_HMAC],
        );
        expect(selected.rows[0]?.result.selectedCount).toBe(100);
        expect(selected.rows[0]?.result.rows.map(row => row.ordinal)).toEqual(
            Array.from({ length: 100 }, (_, index) => index + 1),
        );

        const drift = rows();
        drift[0] = { ...drift[0]!, femaleScore: 0.7, maleScore: 0.2 };
        await expect(publish(drift)).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CONFLICT');
    }, 30_000);

    it('does not consume stale, building, or invalidated manifests and keeps tables/RPCs service-only', async () => {
        db = await PGlite.create();
        await seed();
        await begin();
        await expect(asService(
            `SELECT public.load_analysis_v2_gender_routing_selected(
                $1, $2, 'gender-routing-v1', 'basic', $3
             )`, [REQUEST_ID, CHECKPOINT_ID, CANONICAL_INPUT_HMAC],
        )).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_COMPLETE');
        await publish();
        await expect(asService(
            `SELECT public.load_analysis_v2_gender_routing_selected(
                $1, $2, 'gender-routing-v1', 'basic', $3
             )`, [REQUEST_ID, CHECKPOINT_ID, 'f'.repeat(64)],
        )).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DRIFT');
        await db!.query(
            `UPDATE public.analysis_v2_gender_routing_manifests
             SET status = 'invalidated', invalidated_at = pg_catalog.clock_timestamp()
             WHERE request_id = $1`, [REQUEST_ID],
        );
        await expect(asService(
            `SELECT public.load_analysis_v2_gender_routing_selected(
                $1, $2, 'gender-routing-v1', 'basic', $3
             )`, [REQUEST_ID, CHECKPOINT_ID, CANONICAL_INPUT_HMAC],
        )).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_COMPLETE');

        for (const role of ['anon', 'authenticated']) {
            await db!.exec(`SET ROLE ${role}`);
            try {
                await expect(db!.query(
                    'SELECT * FROM public.analysis_v2_gender_routing_candidates',
                )).rejects.toThrow(/permission denied/i);
                await expect(db!.query(
                    `SELECT public.load_analysis_v2_gender_routing_selected(
                        $1, $2, 'gender-routing-v1', 'basic', $3
                     )`, [REQUEST_ID, CHECKPOINT_ID, CANONICAL_INPUT_HMAC],
                )).rejects.toThrow(/permission denied/i);
            } finally {
                await db!.exec('RESET ROLE');
            }
        }
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
