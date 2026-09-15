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
const completedAfterRefundMigration = readFileSync(
    new URL('../../../supabase/migrations/20260821080948_allow_completed_results_after_refund.sql', import.meta.url),
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
const REQUEST_REFUND_PENDING = '133e4567-e89b-42d3-a456-426614174001';
const REQUEST_REFUNDED = '133e4567-e89b-42d3-a456-426614174002';
const REQUEST_REFUNDED_INCOMPLETE = '133e4567-e89b-42d3-a456-426614174003';
const REQUEST_CANCELLED = '133e4567-e89b-42d3-a456-426614174004';
const ORDER_REFUND_PENDING = '233e4567-e89b-42d3-a456-426614174001';
const ORDER_REFUNDED = '233e4567-e89b-42d3-a456-426614174002';
const ORDER_REFUNDED_INCOMPLETE = '233e4567-e89b-42d3-a456-426614174003';
const ORDER_CANCELLED = '233e4567-e89b-42d3-a456-426614174004';

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
    await db.exec(authorityFunction(completedAfterRefundMigration));

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

    await db.query(
        `INSERT INTO public.analysis_requests
            (id, user_id, target_instagram_id, status, pipeline_version, step_data, idempotency_key)
         VALUES
            ($1, $5, 'refund.pending', 'completed', 'v1', '{}'::jsonb, 'refund-pending'),
            ($2, $5, 'refunded.complete', 'completed', 'v1', '{}'::jsonb, 'refunded-complete'),
            ($3, $5, 'refunded.incomplete', 'completed', 'v1', '{}'::jsonb, 'refunded-incomplete'),
            ($4, $5, 'cancelled.complete', 'completed', 'v1', '{}'::jsonb, 'cancelled-complete')`,
        [
            REQUEST_REFUND_PENDING,
            REQUEST_REFUNDED,
            REQUEST_REFUNDED_INCOMPLETE,
            REQUEST_CANCELLED,
            USER_ID,
        ],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders
            (id, user_id, target_instagram_id, result_request_id, payment_id, status)
         VALUES
            ($1, $9, 'refund.pending', $5, '333e4567-e89b-42d3-a456-426614174001', 'refund_pending'),
            ($2, $9, 'refunded.complete', $6, '333e4567-e89b-42d3-a456-426614174002', 'refunded'),
            ($3, $9, 'refunded.incomplete', $7, '333e4567-e89b-42d3-a456-426614174003', 'refunded'),
            ($4, $9, 'cancelled.complete', $8, '333e4567-e89b-42d3-a456-426614174004', 'cancelled')`,
        [
            ORDER_REFUND_PENDING,
            ORDER_REFUNDED,
            ORDER_REFUNDED_INCOMPLETE,
            ORDER_CANCELLED,
            REQUEST_REFUND_PENDING,
            REQUEST_REFUNDED,
            REQUEST_REFUNDED_INCOMPLETE,
            REQUEST_CANCELLED,
            USER_ID,
        ],
    );
    await db.query(
        `INSERT INTO public.earlybird_fulfillments (order_id, request_id, status, completed_at)
         VALUES
            ($1, $5, 'completed', '2026-08-21T01:00:00Z'),
            ($2, $6, 'completed', '2026-08-21T02:00:00Z'),
            ($3, $7, 'analysis_in_progress', NULL),
            ($4, $8, 'completed', '2026-08-21T04:00:00Z')`,
        [
            ORDER_REFUND_PENDING,
            ORDER_REFUNDED,
            ORDER_REFUNDED_INCOMPLETE,
            ORDER_CANCELLED,
            REQUEST_REFUND_PENDING,
            REQUEST_REFUNDED,
            REQUEST_REFUNDED_INCOMPLETE,
            REQUEST_CANCELLED,
        ],
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

    it('preserves completed delivery through refund states without authorizing incomplete or cancelled work', async () => {
        await expect(authority(REQUEST_REFUND_PENDING)).resolves.toBe(true);
        await expect(authority(REQUEST_REFUNDED)).resolves.toBe(true);
        await expect(authority(REQUEST_REFUNDED_INCOMPLETE)).resolves.toBe(false);
        await expect(authority(REQUEST_CANCELLED)).resolves.toBe(false);
    });
});
