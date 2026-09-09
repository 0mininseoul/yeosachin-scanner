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
            `INSERT INTO public.analysis_cache(scope, cache_key_hash, state, expires_at, payload)
             VALUES ('ai', $1, 'ready', clock_timestamp() + INTERVAL '1 hour', '{"ok":true}'::jsonb)`,
            [hashB],
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
});
