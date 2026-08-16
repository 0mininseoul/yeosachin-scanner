import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const previousGuardMigration = readFileSync(
    new URL('../../../supabase/migrations/20260816161000_result_publication_pending_guard.sql', import.meta.url),
    'utf8',
);
const sourcePublicationGuardMigration = readFileSync(
    new URL('../../../supabase/migrations/20260816230000_result_source_publication_guard.sql', import.meta.url),
    'utf8',
);

const authorityFunction = (migration: string): string => {
    const start = migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.analysis_result_publication_authorized(',
    );
    const end = migration.indexOf(
        'REVOKE ALL ON FUNCTION public.analysis_result_publication_authorized',
        start,
    );
    if (start < 0 || end < 0) throw new Error('publication authority function not found');
    return migration.slice(start, end);
};

const REQUEST_SOURCE = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_FREE = '223e4567-e89b-42d3-a456-426614174000';
const REQUEST_PUBLISHED = '323e4567-e89b-42d3-a456-426614174000';
const USER_ID = '423e4567-e89b-42d3-a456-426614174000';
const SOURCE_ORDER = '523e4567-e89b-42d3-a456-426614174000';
const PUBLISHED_ORDER = '623e4567-e89b-42d3-a456-426614174000';

let db: PGlite;

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT,
            status TEXT NOT NULL,
            pipeline_version TEXT,
            step_data JSONB,
            idempotency_key TEXT
        );
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT,
            result_request_id UUID,
            payment_id UUID,
            status TEXT NOT NULL
        );
        CREATE TABLE public.earlybird_fulfillments (
            order_id UUID NOT NULL,
            request_id UUID,
            status TEXT NOT NULL,
            completed_at TIMESTAMPTZ
        );
    `);
    await db.exec(authorityFunction(previousGuardMigration));
    await db.exec(authorityFunction(sourcePublicationGuardMigration));

    await db.query(
        `INSERT INTO public.analysis_requests
            (id, user_id, target_instagram_id, status, pipeline_version, step_data, idempotency_key)
         VALUES ($1, $2, 'source.target', 'completed', 'v1', $3::jsonb, 'concierge-batch-source:source')`,
        [REQUEST_SOURCE, USER_ID, JSON.stringify({ conciergeBatchSource: true })],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders
            (id, user_id, target_instagram_id, result_request_id, payment_id, status)
         VALUES ($1, $2, 'source.target', NULL, $3, 'analysis_in_progress')`,
        [SOURCE_ORDER, USER_ID, '723e4567-e89b-42d3-a456-426614174000'],
    );

    await db.query(
        `INSERT INTO public.analysis_requests
            (id, user_id, target_instagram_id, status, pipeline_version, step_data, idempotency_key)
         VALUES ($1, $2, 'free.target', 'completed', 'v1', '{}'::jsonb, 'legacy-free')`,
        [REQUEST_FREE, USER_ID],
    );

    await db.query(
        `INSERT INTO public.analysis_requests
            (id, user_id, target_instagram_id, status, pipeline_version, step_data, idempotency_key)
         VALUES ($1, $2, 'published.target', 'completed', 'v1', '{}'::jsonb, 'published')`,
        [REQUEST_PUBLISHED, USER_ID],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders
            (id, user_id, target_instagram_id, result_request_id, payment_id, status)
         VALUES ($1, $2, 'published.target', $3, $4, 'completed')`,
        [PUBLISHED_ORDER, USER_ID, REQUEST_PUBLISHED, '823e4567-e89b-42d3-a456-426614174000'],
    );
    await db.query(
        `INSERT INTO public.earlybird_fulfillments (order_id, request_id, status, completed_at)
         VALUES ($1, $2, 'completed', '2026-08-16T12:00:00Z')`,
        [PUBLISHED_ORDER, REQUEST_PUBLISHED],
    );
});

afterEach(async () => {
    await db.close();
});

async function authority(requestId: string): Promise<boolean> {
    const result = await db.query<{ authorized: boolean }>(
        'SELECT public.analysis_result_publication_authorized($1) AS authorized',
        [requestId],
    );
    return result.rows[0]?.authorized === true;
}

describe('paid result publication authority', () => {
    it('rejects concierge source snapshots while preserving free legacy and published results', async () => {
        await expect(authority(REQUEST_SOURCE)).resolves.toBe(false);
        await expect(authority(REQUEST_FREE)).resolves.toBe(true);
        await expect(authority(REQUEST_PUBLISHED)).resolves.toBe(true);
    });
});
