import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const CLAIM_TOKEN = '323e4567-e89b-42d3-a456-426614174000';
const INPUT_HASH = 'a'.repeat(64);
const MANIFEST_HASH = 'b'.repeat(64);
const SOURCE_HASH = 'c'.repeat(64);
const IMAGE_HASH = 'd'.repeat(64);

let db: PGlite;

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;

        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            pipeline_version TEXT NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE public.analysis_pipeline_jobs (
            request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
                ON DELETE CASCADE,
            job_key TEXT NOT NULL,
            track TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            lease_token UUID,
            lease_expires_at TIMESTAMPTZ,
            PRIMARY KEY (request_id, job_key)
        );
        CREATE FUNCTION public.complete_analysis_v2_result_and_purge(
            p_request_id UUID,
            p_job_key TEXT,
            p_claim_token UUID,
            p_job_input_hash TEXT,
            p_target_profile_image_url TEXT
        )
        RETURNS JSONB
        LANGUAGE sql
        AS $$
            SELECT jsonb_build_object(
                'finalized', TRUE,
                'requestStatus', 'completed'
            )
        $$;
    `);
    await db.exec(migration);
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, pipeline_version, status
        ) VALUES ($1, $2, 'v2', 'processing')`,
        [REQUEST_ID, '223e4567-e89b-42d3-a456-426614174000']
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, track, kind, status, input_hash,
            lease_token, lease_expires_at
        ) VALUES (
            $1, 'coordinator:finalize', 'coordinator', 'finalizer',
            'processing', $2, $3, clock_timestamp() + INTERVAL '1 hour'
        )`,
        [REQUEST_ID, INPUT_HASH, CLAIM_TOKEN]
    );
});

afterEach(async () => {
    await db.close();
});

async function beginManifest(expectedRows: number) {
    return db.query(
        `SELECT public.begin_analysis_v2_result_image_manifest(
            $1, 'coordinator:finalize', $2, $3, $4, $5
        )`,
        [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, MANIFEST_HASH, expectedRows]
    );
}

async function registerOutcome(outcome: Record<string, unknown>) {
    return db.query(
        `SELECT public.register_analysis_v2_result_image_outcome(
            $1, 'coordinator:finalize', $2, $3, $4::JSONB
        )`,
        [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, JSON.stringify(outcome)]
    );
}

function readyOutcome(input: {
    kind: 'target' | 'female' | 'private';
    locator: string;
    ordinal: number;
    mandatory?: boolean;
}) {
    const capturedAt = new Date(Date.now() + 60_000);
    const expiresAt = new Date(capturedAt.getTime() + 30 * 86_400_000);
    return {
        kind: input.kind,
        candidateLocator: input.locator,
        sortOrdinal: input.ordinal,
        sourceFingerprint: SOURCE_HASH,
        status: 'ready',
        objectKey:
            `v1/${'1'.repeat(32)}/${input.kind}/`
            + `${input.ordinal.toString(16).padStart(32, '0')}.webp`,
        sha256: IMAGE_HASH,
        byteSize: 1234,
        capturedAt: capturedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        failureCode: null,
        isMandatory: input.mandatory ?? false,
    };
}

describe('analysis_v2_result_image_coverage_ok', () => {
    it.each([
        [0, 0, 0, 0, 0, true],
        [100, 98, 20, 19, 1, true],
        [100, 97, 20, 19, 1, false],
        [250, 245, 200, 190, 10, true],
        [300, 294, 200, 190, 10, false],
        [100, 100, 220, 209, 11, false],
    ])(
        'evaluates %i/%i rows and %i/%i sourced images',
        async (
            expectedRows,
            durableRows,
            sourced,
            ready,
            failed,
            expected
        ) => {
            const result = await db.query<{ ok: boolean }>(
                `SELECT public.analysis_v2_result_image_coverage_ok(
                    $1, $2, $3, $4, $5
                ) AS ok`,
                [expectedRows, durableRows, sourced, ready, failed]
            );
            expect(result.rows[0]?.ok).toBe(expected);
        }
    );
});

describe('retained result image registry', () => {
    it('registers exact idempotent outcomes and rejects conflicting replay', async () => {
        await beginManifest(1);
        const outcome = readyOutcome({
            kind: 'target',
            locator: 'target',
            ordinal: 0,
            mandatory: true,
        });

        await expect(registerOutcome(outcome)).resolves.toBeDefined();
        await expect(registerOutcome(outcome)).resolves.toBeDefined();
        await expect(registerOutcome({
            ...outcome,
            byteSize: 1235,
        })).rejects.toThrow('ANALYSIS_V2_RESULT_IMAGE_CONFLICT');
    });

    it('rejects raw locators and invalid ready expiry metadata', async () => {
        await beginManifest(1);
        await expect(registerOutcome({
            ...readyOutcome({
                kind: 'female',
                locator: 'https://instagram.example/user',
                ordinal: 1,
            }),
        })).rejects.toThrow('ANALYSIS_V2_RESULT_IMAGE_INVALID');

        const invalid = readyOutcome({
            kind: 'target',
            locator: 'target',
            ordinal: 0,
            mandatory: true,
        });
        invalid.expiresAt = new Date().toISOString();
        await expect(registerOutcome(invalid))
            .rejects.toThrow('ANALYSIS_V2_RESULT_IMAGE_INVALID');
    });

    it('enqueues repair and blocks sealing when a mandatory sourced image failed', async () => {
        await beginManifest(3);
        await registerOutcome(readyOutcome({
            kind: 'target',
            locator: 'target',
            ordinal: 0,
            mandatory: true,
        }));
        await registerOutcome({
            kind: 'female',
            candidateLocator: 'candidate:one',
            sortOrdinal: 1,
            sourceFingerprint: SOURCE_HASH,
            status: 'capture_failed',
            objectKey: null,
            sha256: null,
            byteSize: null,
            capturedAt: null,
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            failureCode: 'UPSTREAM_UNAVAILABLE',
            isMandatory: true,
        });
        await registerOutcome(readyOutcome({
            kind: 'female',
            locator: 'candidate:two',
            ordinal: 2,
            mandatory: true,
        }));

        const repairs = await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.analysis_v2_result_image_repair_outbox
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(repairs.rows[0]?.count).toBe(1);
        await expect(db.query(
            `SELECT public.seal_analysis_v2_result_image_manifest(
                $1, 'coordinator:finalize', $2, $3, $4
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, MANIFEST_HASH]
        )).rejects.toThrow(
            'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY'
        );
    });

    it('allows bounded non-mandatory gaps and finalizes only the exact manifest', async () => {
        await beginManifest(3);
        await registerOutcome(readyOutcome({
            kind: 'target',
            locator: 'target',
            ordinal: 0,
            mandatory: true,
        }));
        await registerOutcome(readyOutcome({
            kind: 'female',
            locator: 'candidate:one',
            ordinal: 1,
            mandatory: true,
        }));
        await registerOutcome({
            kind: 'private',
            candidateLocator: 'candidate:two',
            sortOrdinal: 2,
            sourceFingerprint: null,
            status: 'source_missing',
            objectKey: null,
            sha256: null,
            byteSize: null,
            capturedAt: null,
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            failureCode: null,
            isMandatory: false,
        });

        await db.query(
            `SELECT public.seal_analysis_v2_result_image_manifest(
                $1, 'coordinator:finalize', $2, $3, $4
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, MANIFEST_HASH]
        );
        const result = await db.query<{ value: { finalized: boolean } }>(
            `SELECT public.complete_analysis_v2_result_and_purge_with_images(
                $1, 'coordinator:finalize', $2, $3, NULL, $4, 3
            ) AS value`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, MANIFEST_HASH]
        );
        expect(result.rows[0]?.value.finalized).toBe(true);

        await expect(db.query(
            `SELECT public.complete_analysis_v2_result_and_purge_with_images(
                $1, 'coordinator:finalize', $2, $3, NULL, $4, 3
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH, 'e'.repeat(64)]
        )).rejects.toThrow(
            'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY'
        );
    });

    it('queues opaque ready keys transactionally before owner deletion', async () => {
        await beginManifest(1);
        const outcome = readyOutcome({
            kind: 'target',
            locator: 'target',
            ordinal: 0,
            mandatory: true,
        });
        await registerOutcome(outcome);

        await db.query(
            'DELETE FROM public.analysis_requests WHERE id = $1',
            [REQUEST_ID]
        );
        const requests = await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.analysis_requests'
        );
        const purges = await db.query<{ object_key: string }>(
            `SELECT object_key
             FROM public.analysis_v2_result_image_purge_outbox`
        );

        expect(requests.rows[0]?.count).toBe(0);
        expect(purges.rows).toEqual([{ object_key: outcome.objectKey }]);
    });
});
