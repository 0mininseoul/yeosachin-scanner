import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260814220000_add_concierge_source_accessor.sql', import.meta.url),
    'utf8',
);

const ORDER_ID = '223e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '323e4567-e89b-42d3-a456-426614174000';
const SOURCE_REQUEST_ID = '423e4567-e89b-42d3-a456-426614174000';

let db: PGlite;

async function withRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await operation();
    } finally {
        await db.exec('RESET ROLE');
    }
}

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL
        );
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL,
            pipeline_version TEXT,
            status TEXT NOT NULL
        );
        CREATE TABLE public.earlybird_v211_concierge_replays (
            order_id UUID PRIMARY KEY,
            original_failed_request_id UUID NOT NULL
        );
        ALTER TABLE public.earlybird_v211_concierge_replays ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.earlybird_v211_concierge_replays FORCE ROW LEVEL SECURITY;
        REVOKE ALL ON public.earlybird_v211_concierge_replays FROM PUBLIC, anon, authenticated, service_role;
    `);
    await db.exec(migration);
    await db.query(
        `INSERT INTO public.earlybird_orders(id, user_id, target_instagram_id)
         VALUES ($1, $2, 'target')`,
        [ORDER_ID, OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.analysis_requests(id, user_id, target_instagram_id, pipeline_version, status)
         VALUES ($1, $2, 'target', 'v2', 'failed')`,
        [SOURCE_REQUEST_ID, OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
         VALUES ($1, $2)`,
        [ORDER_ID, SOURCE_REQUEST_ID],
    );
});

afterEach(async () => {
    await db.close();
});

describe('concierge source accessor privilege contract', () => {
    it('allows only the service-role RPC to read the exact lineage source', async () => {
        await expect(withRole('service_role', () => db.query(
            'SELECT original_failed_request_id FROM public.earlybird_v211_concierge_replays',
        ))).rejects.toThrow();

        const source = await withRole('service_role', () => db.query<{ read_earlybird_v211_concierge_result_source: { sourceRequestId: string } }>(
            'SELECT public.read_earlybird_v211_concierge_result_source($1) AS read_earlybird_v211_concierge_result_source',
            [ORDER_ID],
        ));
        expect(source.rows[0]?.read_earlybird_v211_concierge_result_source)
            .toEqual({ sourceRequestId: SOURCE_REQUEST_ID });
    });
});
