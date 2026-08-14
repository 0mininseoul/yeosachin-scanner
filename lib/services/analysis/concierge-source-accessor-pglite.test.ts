import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260814220000_add_concierge_source_accessor.sql', import.meta.url),
    'utf8',
);
const reviewedSourceMigration = readFileSync(
    new URL('../../../supabase/migrations/20260814223000_register_concierge_reviewed_source.sql', import.meta.url),
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
            target_instagram_id TEXT NOT NULL,
            preflight_id UUID NOT NULL,
            result_request_id UUID,
            status TEXT,
            plan_id TEXT,
            paid_at TIMESTAMPTZ
        );
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT,
            preflight_id UUID NOT NULL,
            pipeline_version TEXT,
            status TEXT NOT NULL,
            step_data JSONB
        );
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL,
            pii_scrubbed_at TIMESTAMPTZ,
            consumed_request_id UUID
        );
        CREATE TABLE public.earlybird_v211_concierge_replays (
            order_id UUID PRIMARY KEY,
            original_failed_request_id UUID NOT NULL,
            first_relationship_failed_request_id UUID,
            second_relationship_failed_request_id UUID,
            failed_preflight_id UUID,
            rearmed_preflight_id UUID NOT NULL,
            expected_fulfillment_attempt_count SMALLINT,
            expected_manual_review_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT now()
        );
        ALTER TABLE public.earlybird_v211_concierge_replays ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.earlybird_v211_concierge_replays FORCE ROW LEVEL SECURITY;
        REVOKE ALL ON public.earlybird_v211_concierge_replays FROM PUBLIC, anon, authenticated, service_role;
    `);
    await db.exec(migration);
    await db.exec(reviewedSourceMigration);
    await db.query(
        `INSERT INTO public.analysis_preflights(id, user_id, target_instagram_id)
         VALUES ('523e4567-e89b-42d3-a456-426614174000', $1, 'retained.523e4567e89b42d3a456')`,
        [OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(id, user_id, target_instagram_id)
         VALUES ('623e4567-e89b-42d3-a456-426614174000', $1, 'retained.623e4567e89b42d3a456')`,
        [OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.analysis_requests(id, user_id, target_instagram_id, preflight_id, pipeline_version, status)
         VALUES ('723e4567-e89b-42d3-a456-426614174000', $1, 'target', '623e4567-e89b-42d3-a456-426614174000', 'v1', 'completed')`,
        [OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders(id, user_id, target_instagram_id, preflight_id, result_request_id, status, plan_id, paid_at)
         VALUES ($1, $2, 'target', '623e4567-e89b-42d3-a456-426614174000', '723e4567-e89b-42d3-a456-426614174000', 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
        [ORDER_ID, OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.analysis_requests(id, user_id, target_instagram_id, preflight_id, pipeline_version, status, step_data)
         VALUES ($1, $2, NULL, '523e4567-e89b-42d3-a456-426614174000', 'v2', 'failed', '{}'::jsonb)`,
        [SOURCE_REQUEST_ID, OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id, rearmed_preflight_id)
         VALUES ($1, $2, '623e4567-e89b-42d3-a456-426614174000')`,
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

    it('registers the reviewed source snapshot without reading empty step_data or deleted staging', async () => {
        const targetPosts = [{ id: 'post-live-1', taggedUsers: ['candidate.one'], mentionedUsers: [] }];
        const targetEvidence = [{
            actorUsername: 'candidate.one', postId: 'post-live-1', signal: 'target_post_like',
            sourceInteractionId: 'interaction-live-1', occurredAt: null, content: null,
        }];
        await withRole('service_role', () => db.query(
            `SELECT public.register_earlybird_v211_concierge_reviewed_source(
                $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb
             )`,
            [
                ORDER_ID,
                SOURCE_REQUEST_ID,
                '723e4567-e89b-42d3-a456-426614174000',
                OWNER_ID,
                ' @TARGET ',
                'a'.repeat(64),
                JSON.stringify(targetPosts),
                JSON.stringify(targetEvidence),
            ],
        ));

        await expect(db.query(
            `SELECT reviewed_source_owner_id, reviewed_source_target_instagram_id,
                    reviewed_source_result_request_id, reviewed_source_target_posts,
                    reviewed_source_target_evidence, reviewed_source_fingerprint
               FROM public.earlybird_v211_concierge_replays WHERE order_id = $1`,
            [ORDER_ID],
        )).resolves.toMatchObject({ rows: [{
            reviewed_source_owner_id: OWNER_ID,
            reviewed_source_target_instagram_id: 'target',
            reviewed_source_result_request_id: '723e4567-e89b-42d3-a456-426614174000',
            reviewed_source_target_posts: targetPosts,
            reviewed_source_target_evidence: targetEvidence,
            reviewed_source_fingerprint: 'a'.repeat(64),
        }] });
    });
});
