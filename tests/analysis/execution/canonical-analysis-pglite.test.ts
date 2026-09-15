import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function canonicalMigrationPath(): URL {
    const directory = new URL('../../../supabase/migrations/', import.meta.url);
    const files = readdirSync(directory).filter(file => (
        file.endsWith('_add_analysis_canonical_tables.sql')
    ));
    expect(files).toHaveLength(1);
    return new URL(files[0]!, directory);
}

const requestId = '70000000-0000-4000-8000-000000000001';
const secondRequestId = '70000000-0000-4000-8000-000000000002';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.analysis_requests(id) VALUES ('${requestId}');
INSERT INTO public.analysis_requests(id) VALUES ('${secondRequestId}');
`;

describe('analysis canonical tables PGlite contract', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(readFileSync(canonicalMigrationPath(), 'utf8'));
    });

    afterAll(async () => {
        await db?.close();
    });

    it('accepts complete, partial, and unknown-cost canonical rows', async () => {
        await db.query(
            `INSERT INTO public.analysis_jobs(request_id, job_key, kind, state)
             VALUES ($1, 'coordinator:finalize', 'finalize', 'succeeded')`,
            [requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_events(request_id, kind, state, content_hash)
             VALUES ($1, 'progress', 'partial', $2)`,
            [requestId, hashA],
        );
        await db.query(
            `INSERT INTO public.analysis_costs(
                 request_id, provider, operation_key, stage, amount_known,
                 amount_conservative, usage_unknown, source_hash
             ) VALUES ($1, 'vertex', 'score:001', 'score', NULL, 0.014, TRUE, $2)`,
            [requestId, hashA],
        );
        await db.query(
            `INSERT INTO public.analysis_audit_bundles(
                 request_id, version, kind, state, content_hash
             ) VALUES ($1, 1, 'bundle', 'partial', $2)`,
            [requestId, hashA],
        );
        const counts = await db.query<{ jobs: number; events: number; costs: number }>(
            `SELECT
                 (SELECT count(*)::int FROM public.analysis_jobs) AS jobs,
                 (SELECT count(*)::int FROM public.analysis_events) AS events,
                 (SELECT count(*)::int FROM public.analysis_costs) AS costs`,
        );
        expect(counts.rows[0]).toEqual({ jobs: 1, events: 1, costs: 1 });
    });

    it('returns the cache family from the bounded service loader', async () => {
        await db.query(
            `INSERT INTO public.analysis_cache(request_id, scope, cache_key_hash, state, expires_at, payload)
             VALUES ($1, 'ai', $2, 'ready', clock_timestamp() + INTERVAL '1 hour', '{"schemaVersion":1}'::jsonb)`,
            [requestId, hashB],
        );
        const result = await db.query<{ payload: Record<string, unknown> }>(
            `SELECT public.load_analysis_canonical_family($1, 'cache') AS payload`,
            [requestId],
        );
        expect(result.rows[0]?.payload).toMatchObject({
            jobs: [],
            events: [],
            artifacts: [],
            costs: [],
            caches: [expect.objectContaining({ scope: 'ai', state: 'ready' })],
            audits: [],
        });
    });

    it('rejects duplicate job keys and duplicate audit hashes', async () => {
        await expect(db.query(
            `INSERT INTO public.analysis_jobs(request_id, job_key, kind, state)
             VALUES ($1, 'coordinator:finalize', 'finalize', 'queued')`,
            [requestId],
        )).rejects.toThrow();
        await expect(db.query(
            `INSERT INTO public.analysis_audit_bundles(
                 request_id, version, kind, state, content_hash
             ) VALUES ($1, 1, 'bundle', 'partial', $2)`,
            [requestId, hashA],
        )).rejects.toThrow();
    });

    it('rejects extra and synthetic JSONB payload keys at the database boundary', async () => {
        await expect(db.query(
            `INSERT INTO public.analysis_jobs(request_id, job_key, kind, state, payload)
             VALUES ($1, 'schema:extra', 'coordinator', 'queued', '{"schemaVersion":1,"extra":true}'::jsonb)`,
            [requestId],
        )).rejects.toThrow();
        await expect(db.query(
            `INSERT INTO public.analysis_events(request_id, kind, state, content_hash, payload)
             VALUES ($1, 'progress', 'partial', $2, '{"schemaVersion":1,"synthetic":true}'::jsonb)`,
            [requestId, 'c'.repeat(64)],
        )).rejects.toThrow();
        await expect(db.query(
            `INSERT INTO public.analysis_events(request_id, kind, state, content_hash, payload)
             VALUES ($1, 'progress', 'partial', $2,
                 '{"schemaVersion":1,"evidence":{"targetManifests":[],"targetInteractions":[],"extra":true}}'::jsonb)`,
            [requestId, 'd'.repeat(64)],
        )).rejects.toThrow();
        await expect(db.query(
            `INSERT INTO public.analysis_artifacts(
                 request_id, kind, artifact_key, state, content_hash, retention_class, payload
             ) VALUES ($1, 'evidence', 'target-manifest-extra', 'retained', $2, 'standard',
                 '{"schemaVersion":1,"targetManifest":{"key":"manifest:1","inputHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","likerSourceHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","commentSourceHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","resultHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","interactorCount":1,"likerCount":1,"commentCount":0,"retention":"standard","extra":true}}'::jsonb)`,
            [requestId, 'e'.repeat(64)],
        )).rejects.toThrow();
    });

    it('rejects known amounts when usage is unknown and preserves late costs as rows', async () => {
        await expect(db.query(
            `INSERT INTO public.analysis_costs(
                 request_id, provider, operation_key, stage, amount_known,
                 amount_conservative, usage_unknown, source_hash
             ) VALUES ($1, 'vertex', 'score:late', 'score', 0.01, 0.014, TRUE, $2)`,
            [requestId, hashB],
        )).rejects.toThrow();
        await db.query(
            `INSERT INTO public.analysis_costs(
                 request_id, provider, operation_key, stage, amount_known,
                 amount_conservative, usage_unknown, source_hash
             ) VALUES ($1, 'vertex', 'score:late', 'score', 0.01, 0.014, FALSE, $2)`,
            [requestId, hashB],
        );
        const costs = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM public.analysis_costs
             WHERE request_id = $1 AND operation_key = 'score:late'`,
            [requestId],
        );
        expect(costs.rows[0]?.count).toBe(1);
    });

    it('rejects a concurrent conflicting first cost for one idempotency key', async () => {
        const call = (sourceHash: string) => db.query(
            `SELECT public.append_analysis_canonical_cost(
                $1, 'vertex', 'provider-run:race', 'provider_cost', 'USD',
                0.01, 0.01, FALSE, $2, '{"schemaVersion":1}'::jsonb,
                'permanent', 'cost-race-key'
            )`,
            [requestId, sourceHash],
        );
        const results = await Promise.allSettled([
            call('c'.repeat(64)),
            call('d'.repeat(64)),
        ]);

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const rejection = results.find(result => result.status === 'rejected');
        expect(rejection).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ message: expect.stringContaining('ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT') }),
        });
        const rows = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM public.analysis_costs
             WHERE request_id = $1 AND idempotency_key = 'cost-race-key'`,
            [requestId],
        );
        expect(rows.rows[0]?.count).toBe(1);
    });

    it('allocates concurrent late-cost audit versions atomically under the request lock', async () => {
        const call = (sourceHash: string) => db.query<{ version: number }>(
            `SELECT (public.append_analysis_canonical_late_cost_audit(
                $1, 'vertex', 'provider-run:late', 'provider_cost', 'USD',
                0.01, 0.01, FALSE, $2, 'concurrent-' || $2, '{"schemaVersion":1}'::jsonb, 'permanent', $3,
                '{"schemaVersion":1,"lateCost":true}'::jsonb, 'permanent'
            )->>'version')::int AS version`,
            [requestId, sourceHash, hashB],
        );
        const results = await Promise.all([
            call('c'.repeat(64)),
            call('d'.repeat(64)),
        ]);
        const versions = results.map(result => result.rows[0]?.version).sort();
        expect(versions).toEqual([2, 3]);
        const auditRows = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM public.analysis_audit_bundles
             WHERE request_id = $1`,
            [requestId],
        );
        expect(auditRows.rows[0]?.count).toBe(3);
    });

    it('keeps cache rows request-scoped and returns only the selected request', async () => {
        await db.query(
            `INSERT INTO public.analysis_cache(request_id, scope, cache_key_hash, state, expires_at, payload)
             VALUES ($1, 'ai', $2, 'ready', clock_timestamp() + INTERVAL '1 hour', '{"schemaVersion":1,"requestId":"${requestId}"}'::jsonb)`,
            [requestId, 'e'.repeat(64)],
        );
        await db.query(
            `INSERT INTO public.analysis_cache(request_id, scope, cache_key_hash, state, expires_at, payload)
             VALUES ($1, 'ai', $2, 'ready', clock_timestamp() + INTERVAL '1 hour', '{"schemaVersion":1,"requestId":"${secondRequestId}"}'::jsonb)`,
            [secondRequestId, 'f'.repeat(64)],
        );
        const result = await db.query<{ payload: Record<string, unknown> }>(
            `SELECT public.load_analysis_canonical_family($1, 'cache') AS payload`,
            [requestId],
        );
        expect(result.rows[0]?.payload.caches).toHaveLength(2);
        expect(JSON.stringify(result.rows[0]?.payload.caches)).toContain(requestId);
        expect(JSON.stringify(result.rows[0]?.payload.caches)).not.toContain(secondRequestId);
    });

    it('reconciles a repeated late-cost call to one cost and one audit version', async () => {
        const call = () => db.query<{ version: number }>(
            `SELECT (public.append_analysis_canonical_late_cost_audit(
                $1, 'vertex', 'provider-run:idempotent', 'provider_cost', 'USD',
                0.02, 0.02, FALSE, $2, 'idempotency-key-1', '{"schemaVersion":1}'::jsonb, 'permanent', $3,
                '{"schemaVersion":1,"lateCost":true}'::jsonb, 'permanent'
            )->>'version')::int AS version`,
            [requestId, '1'.repeat(64), '2'.repeat(64)],
        );
        const first = await call();
        const second = await call();
        expect(first.rows[0]?.version).toBe(second.rows[0]?.version);
        const rows = await db.query<{ costs: number; audits: number }>(
            `SELECT
                 (SELECT count(*)::int FROM public.analysis_costs WHERE request_id = $1 AND operation_key = 'provider-run:idempotent') AS costs,
                 (SELECT count(*)::int FROM public.analysis_audit_bundles WHERE request_id = $1 AND content_hash = $2) AS audits`,
            [requestId, '2'.repeat(64)],
        );
        expect(rows.rows[0]).toEqual({ costs: 1, audits: 1 });
    });
});
