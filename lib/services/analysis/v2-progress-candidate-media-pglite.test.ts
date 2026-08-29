import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const baseMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260801010000_add_progress_candidate_media.sql',
        import.meta.url
    ),
    'utf8'
);
const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260829120000_add_analysis_v2_progress_signals_history.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_A = '44444444-4444-4444-8444-444444444444';
const CLAIM_B = '55555555-5555-4555-8555-555555555555';
const HASH = 'a'.repeat(64);
const CANDIDATE_KEY = 'b'.repeat(64);
const JOB_A = 'track:profile-ai:batch:0';
const JOB_B = 'track:profiles:batch:1';

function at(offsetMilliseconds = 0): string {
    return new Date(Date.now() + offsetMilliseconds).toISOString();
}

let db: PGlite;

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function heartbeat(input: {
    jobKey?: string;
    claimToken?: string;
    inputHash?: string;
    startedAt?: string;
    totalCount?: number;
    currentOrdinal?: number;
    callPhase?: 'fetching' | 'analyzing' | 'persisting';
    maskedUsername?: string;
    imageUrl?: string | null;
    feedImageUrls?: string[];
    candidateKey?: string | null;
    omitFeedImageUrls?: boolean;
} = {}): Promise<boolean> {
    const values = [
        REQUEST_ID,
        input.jobKey ?? JOB_A,
        input.claimToken ?? CLAIM_A,
        input.inputHash ?? HASH,
        input.startedAt ?? at(),
        input.totalCount ?? 2,
        input.maskedUsername ?? 'c******e',
        input.imageUrl ?? '/api/image-proxy?token=profile',
    ];
    const result = await asService<{ checkpoint_analysis_v2_active_profile_heartbeat: boolean }>(
        `SELECT public.checkpoint_analysis_v2_active_profile_heartbeat(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )`, [...values, input.feedImageUrls ?? [], input.candidateKey ?? null,
            input.currentOrdinal ?? 0, input.callPhase ?? 'fetching']
    );
    return result.rows[0]!.checkpoint_analysis_v2_active_profile_heartbeat;
}

async function seed(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (id, user_id, pipeline_version, status)
         VALUES ($1, $2, 'v2', 'processing')`, [REQUEST_ID, OWNER_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_progress_state (request_id, status, snapshot)
         VALUES ($1, 'processing', '{"activeProfile":null}')`, [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, input_hash, lease_token, lease_expires_at
         ) VALUES
            ($1, $2, 'processing', $3, $4, pg_catalog.clock_timestamp() + INTERVAL '5 minutes'),
            ($1, $5, 'processing', $3, $4, pg_catalog.clock_timestamp() + INTERVAL '5 minutes')`,
        [REQUEST_ID, JOB_A, HASH, CLAIM_A, JOB_B]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_dag_batch_topology (
            request_id, topology_kind, batch, item_count
         ) VALUES ($1, 'profile', 0, 2), ($1, 'profile', 1, 2)`, [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_progress_events (request_id, seq, event_json)
         VALUES ($1, 1, '{"schemaVersion":1,"seq":1,"eventCode":"PROFILE_SCREENED"}')`,
        [REQUEST_ID]
    );
}

describe('V2 progress candidate-media migration PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY, user_id UUID NOT NULL,
                pipeline_version TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL,
                input_hash TEXT NOT NULL, lease_token UUID,
                lease_expires_at TIMESTAMP WITH TIME ZONE,
                PRIMARY KEY (request_id, job_key)
            );
            CREATE TABLE public.analysis_v2_dag_batch_topology (
                request_id UUID NOT NULL, topology_kind TEXT NOT NULL,
                batch INTEGER NOT NULL, item_count INTEGER NOT NULL,
                PRIMARY KEY (request_id, topology_kind, batch)
            );
            CREATE TABLE public.analysis_v2_active_profile_heartbeats (
                request_id UUID NOT NULL, job_key TEXT NOT NULL, job_input_hash TEXT NOT NULL,
                claim_token UUID NOT NULL, started_at TIMESTAMP WITH TIME ZONE NOT NULL,
                completed_count SMALLINT NOT NULL DEFAULT 0, total_count SMALLINT NOT NULL,
                masked_username TEXT NOT NULL, image_url TEXT, updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
                PRIMARY KEY (request_id, job_key),
                FOREIGN KEY (request_id, job_key)
                    REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
            );
            CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
                request_id UUID NOT NULL, job_key TEXT NOT NULL, attempt TEXT NOT NULL,
                ordinal SMALLINT NOT NULL, username TEXT NOT NULL, status TEXT NOT NULL,
                captured_at TIMESTAMP WITH TIME ZONE NOT NULL, profile_snapshot JSONB
            );
            ALTER TABLE public.analysis_v2_active_profile_heartbeats ENABLE ROW LEVEL SECURITY;
            ALTER TABLE public.analysis_v2_active_profile_heartbeats FORCE ROW LEVEL SECURITY;
            REVOKE ALL ON TABLE public.analysis_v2_active_profile_heartbeats
                FROM PUBLIC, anon, authenticated, service_role;
            CREATE TABLE public.analysis_progress_state (
                request_id UUID PRIMARY KEY, status TEXT NOT NULL, snapshot JSONB NOT NULL
            );
            CREATE TABLE public.analysis_progress_events (
                request_id UUID NOT NULL, seq BIGINT NOT NULL, event_json JSONB NOT NULL,
                PRIMARY KEY (request_id, seq)
            );
            CREATE FUNCTION public.analysis_v2_progress_snapshot_json(
                p_state public.analysis_progress_state
            ) RETURNS JSONB LANGUAGE sql AS $$ SELECT p_state.snapshot $$;
            CREATE FUNCTION public.analysis_v2_progress_event_json(
                p_event public.analysis_progress_events
            ) RETURNS JSONB LANGUAGE sql AS $$ SELECT p_event.event_json $$;
            CREATE FUNCTION public.analysis_v2_valid_progress_tracks(
                p_tracks JSONB
            ) RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
                UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT
            ) RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.checkpoint_analysis_v2_progress(
                UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT,
                JSONB, TEXT
            ) RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::JSONB $$;
            CREATE OR REPLACE FUNCTION public.analysis_v2_purge_terminal_active_profile_heartbeat()
            RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
            BEGIN
                IF NEW.status IN ('completed', 'failed', 'cancelled')
                   AND OLD.status IS DISTINCT FROM NEW.status THEN
                    DELETE FROM public.analysis_v2_active_profile_heartbeats AS heartbeat
                    WHERE heartbeat.request_id = NEW.request_id AND heartbeat.job_key = NEW.job_key;
                END IF;
                RETURN NULL;
            END;
            $$;
            CREATE TRIGGER analysis_v2_active_profile_terminal_purge
            AFTER UPDATE OF status ON public.analysis_pipeline_jobs
            FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_purge_terminal_active_profile_heartbeat();
        `);
        await db.exec(baseMigration);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`TRUNCATE public.analysis_progress_events,
            public.analysis_v2_active_profile_heartbeats,
            public.analysis_v2_dag_batch_topology,
            public.analysis_pipeline_jobs,
            public.analysis_progress_state,
            public.analysis_requests`);
        await seed();
    });

    afterAll(async () => { await db.close(); });

    it('stores only a bounded, unique proxy-path array in the existing heartbeat table', async () => {
        await expect(heartbeat({ feedImageUrls: [
            '/api/image-proxy?token=one', '/api/image-proxy?token=two', '/api/image-proxy?token=three',
        ] })).resolves.toBe(true);
        await expect(db.query(`UPDATE public.analysis_v2_active_profile_heartbeats
            SET feed_image_urls = ARRAY['/api/image-proxy?token=one', NULL]
            WHERE request_id = $1 AND job_key = $2`,
        [REQUEST_ID, JOB_A])).rejects.toThrow();
        await expect(db.query(`UPDATE public.analysis_v2_active_profile_heartbeats
            SET feed_image_urls = NULL
            WHERE request_id = $1 AND job_key = $2`,
        [REQUEST_ID, JOB_A])).rejects.toThrow();
        for (const invalid of [
            `ARRAY['https://raw.example/image.jpg']`,
            `ARRAY['/api/image-proxy?token=1','/api/image-proxy?token=2','/api/image-proxy?token=3','/api/image-proxy?token=4']`,
            `ARRAY['/api/image-proxy?token=duplicate','/api/image-proxy?token=duplicate']`,
        ]) {
            await expect(db.query(`UPDATE public.analysis_v2_active_profile_heartbeats
                SET feed_image_urls = ${invalid} WHERE request_id = $1 AND job_key = $2`,
            [REQUEST_ID, JOB_A])).rejects.toThrow();
        }
        const tables = await db.query<{ tablename: string }>(
            "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename"
        );
        expect(tables.rows.map(row => row.tablename)).toEqual([
            'analysis_pipeline_jobs',
            'analysis_progress_events',
            'analysis_progress_state',
            'analysis_requests',
            'analysis_v2_active_profile_heartbeats',
            'analysis_v2_dag_batch_topology',
            'analysis_v2_profile_fetch_outcomes',
        ]);
    });

    it('rejects non-canonical array dimensions through the controlled validator', async () => {
        await expect(db.query<{ valid: boolean }>(`
            SELECT public.analysis_v2_valid_active_profile_feed_image_urls(
                '[0:1]={"/api/image-proxy?token=one","/api/image-proxy?token=two"}'::TEXT[]
            ) AS valid
        `)).resolves.toMatchObject({ rows: [{ valid: false }] });
        await expect(db.query<{ valid: boolean }>(`
            SELECT public.analysis_v2_valid_active_profile_feed_image_urls(
                ARRAY[['/api/image-proxy?token=one', '/api/image-proxy?token=two']]
            ) AS valid
        `)).resolves.toMatchObject({ rows: [{ valid: false }] });
        const heartbeatArgs = [
            REQUEST_ID, JOB_A, CLAIM_A, HASH, at(), 2, 'c******e', '/api/image-proxy?token=profile',
        ];
        await expect(asService(`
            SELECT public.checkpoint_analysis_v2_active_profile_heartbeat(
                $1, $2, $3, $4, $5, $6, $7, $8,
                '[0:1]={"/api/image-proxy?token=one","/api/image-proxy?token=two"}'::TEXT[]
            )
        `, heartbeatArgs)).rejects.toThrow(/ANALYSIS_V2_PROGRESS_INVALID/);
        await expect(asService(`
            SELECT public.checkpoint_analysis_v2_active_profile_heartbeat(
                $1, $2, $3, $4, $5, $6, $7, $8,
                ARRAY[['/api/image-proxy?token=one', '/api/image-proxy?token=two']]
            )
        `, heartbeatArgs)).rejects.toThrow(/ANALYSIS_V2_PROGRESS_INVALID/);
    });

    it('keeps old, feed, and named candidate callers on one exact signature', async () => {
        const signatures = await db.query<{ args: string }>(`
            SELECT pg_catalog.pg_get_function_identity_arguments(proc.oid) AS args
            FROM pg_catalog.pg_proc AS proc
            WHERE proc.pronamespace = 'public'::pg_catalog.regnamespace
              AND proc.proname = 'checkpoint_analysis_v2_active_profile_heartbeat'
        `);
        expect(signatures.rows).toHaveLength(1);
        expect(signatures.rows[0]!.args).toContain('p_feed_image_urls text[]');
        expect(signatures.rows[0]!.args).toContain('p_candidate_key text');
        await expect(heartbeat({ omitFeedImageUrls: true })).resolves.toBe(true);
        await expect(heartbeat({
            startedAt: at(1_000),
            feedImageUrls: ['/api/image-proxy?token=feed'],
        })).resolves.toBe(true);
        await expect(asService(`
            SELECT public.checkpoint_analysis_v2_active_profile_heartbeat(
                p_request_id => $1, p_job_key => $2, p_claim_token => $3,
                p_job_input_hash => $4, p_started_at => $5, p_total_count => $6,
                p_masked_username => $7, p_image_url => $8,
                p_feed_image_urls => $9, p_candidate_key => $10
            )
        `, [
            REQUEST_ID, JOB_A, CLAIM_A, HASH, at(2_000), 2, 'c******e',
            '/api/image-proxy?token=profile', ['/api/image-proxy?token=feed'], CANDIDATE_KEY,
        ])).resolves.toMatchObject({
            rows: [{ checkpoint_analysis_v2_active_profile_heartbeat: true }],
        });
        await expect(db.query<{ feed_image_urls: string[]; candidate_key: string | null }>(
            `SELECT feed_image_urls, candidate_key
             FROM public.analysis_v2_active_profile_heartbeats
             WHERE request_id = $1 AND job_key = $2`,
            [REQUEST_ID, JOB_A]
        )).resolves.toMatchObject({ rows: [{
            feed_image_urls: ['/api/image-proxy?token=feed'],
            candidate_key: CANDIDATE_KEY,
        }] });
    });

    it('accepts null legacy candidate keys and rejects non-digest identity input', async () => {
        await expect(heartbeat({ omitFeedImageUrls: true })).resolves.toBe(true);
        await expect(db.query<{ candidate_key: string | null }>(
            `SELECT candidate_key FROM public.analysis_v2_active_profile_heartbeats
             WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, JOB_A]
        )).resolves.toMatchObject({ rows: [{ candidate_key: null }] });

        for (const invalid of [
            'B'.repeat(64),
            'b'.repeat(63),
            'candidate.raw_username',
            'g'.repeat(64),
        ]) {
            await expect(heartbeat({
                startedAt: at(1_000),
                candidateKey: invalid,
            })).rejects.toThrow(/ANALYSIS_V2_PROGRESS_INVALID/);
            await expect(db.query(
                `UPDATE public.analysis_v2_active_profile_heartbeats
                 SET candidate_key = $1 WHERE request_id = $2 AND job_key = $3`,
                [invalid, REQUEST_ID, JOB_A]
            )).rejects.toThrow();
        }
        await expect(heartbeat({
            startedAt: at(2_000),
            candidateKey: CANDIDATE_KEY,
        })).resolves.toBe(true);
    });

    it('preserves the exact job, hash, claim, lease, topology, and idempotency fences', async () => {
        const startedAt = at();
        await expect(heartbeat({ startedAt })).resolves.toBe(true);
        await expect(heartbeat({ startedAt })).resolves.toBe(false);
        await expect(heartbeat({ startedAt: at(1_000) })).resolves.toBe(true);
        await db.query('UPDATE public.analysis_pipeline_jobs SET lease_token = $1 WHERE request_id = $2 AND job_key = $3', [CLAIM_B, REQUEST_ID, JOB_A]);
        await expect(heartbeat({ claimToken: CLAIM_B, startedAt: at(-1_000) })).resolves.toBe(true);
        await expect(heartbeat({ claimToken: CLAIM_A })).rejects.toThrow(/ANALYSIS_V2_PROGRESS_FENCE_MISMATCH/);
        await expect(heartbeat({ claimToken: CLAIM_B, inputHash: 'b'.repeat(64) })).rejects.toThrow(/ANALYSIS_V2_PROGRESS_FENCE_MISMATCH/);
        await expect(heartbeat({ claimToken: CLAIM_B, totalCount: 3 })).rejects.toThrow(/ANALYSIS_V2_PROGRESS_TOPOLOGY_MISMATCH/);
        await db.query(`UPDATE public.analysis_pipeline_jobs SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
            WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, JOB_A]);
        await expect(heartbeat({ claimToken: CLAIM_B })).rejects.toThrow(/ANALYSIS_V2_PROGRESS_FENCE_MISMATCH/);
    });

    it('rejects a stale lower ordinal without breaking its higher ordinal identity', async () => {
        await expect(heartbeat({
            startedAt: at(1_000),
            currentOrdinal: 2,
            maskedUsername: 'h******r',
            imageUrl: '/api/image-proxy?token=high',
            feedImageUrls: ['/api/image-proxy?token=high-feed'],
            candidateKey: 'a'.repeat(64),
            callPhase: 'analyzing',
        })).resolves.toBe(true);
        await expect(heartbeat({
            startedAt: at(2_000),
            currentOrdinal: 1,
            maskedUsername: 'l******r',
            imageUrl: '/api/image-proxy?token=low',
            feedImageUrls: ['/api/image-proxy?token=low-feed'],
            candidateKey: 'b'.repeat(64),
            callPhase: 'fetching',
        })).resolves.toBe(false);

        await expect(db.query<{
            completed_count: number;
            masked_username: string;
            image_url: string;
            call_phase: string;
            candidate_key: string;
        }>(`SELECT completed_count, masked_username, image_url, call_phase, candidate_key
            FROM public.analysis_v2_active_profile_heartbeats
            WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, JOB_A])).resolves.toMatchObject({
            rows: [{
                completed_count: 2,
                masked_username: 'h******r',
                image_url: '/api/image-proxy?token=high',
                call_phase: 'analyzing',
                candidate_key: 'a'.repeat(64),
            }],
        });
    });

    it('allows same-ordinal phase enrichment and resets identity for a new claim', async () => {
        await expect(heartbeat({
            startedAt: at(1_000),
            currentOrdinal: 2,
            maskedUsername: 'h******r',
            callPhase: 'fetching',
        })).resolves.toBe(true);
        await expect(heartbeat({
            startedAt: at(1_000),
            currentOrdinal: 2,
            maskedUsername: 'h******r',
            callPhase: 'persisting',
        })).resolves.toBe(true);
        await expect(db.query<{ call_phase: string }>(
            `SELECT call_phase FROM public.analysis_v2_active_profile_heartbeats
             WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, JOB_A]
        )).resolves.toMatchObject({ rows: [{ call_phase: 'persisting' }] });

        await db.query(
            'UPDATE public.analysis_pipeline_jobs SET lease_token = $1 WHERE request_id = $2 AND job_key = $3',
            [CLAIM_B, REQUEST_ID, JOB_A]
        );
        await expect(heartbeat({
            claimToken: CLAIM_B,
            startedAt: at(-1_000),
            currentOrdinal: 1,
            maskedUsername: 'n******w',
            imageUrl: '/api/image-proxy?token=new-claim',
            callPhase: 'fetching',
        })).resolves.toBe(true);
        await expect(db.query<{ completed_count: number; masked_username: string; image_url: string }>(
            `SELECT completed_count, masked_username, image_url
             FROM public.analysis_v2_active_profile_heartbeats
             WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, JOB_A]
        )).resolves.toMatchObject({ rows: [{
            completed_count: 1,
            masked_username: 'n******w',
            image_url: '/api/image-proxy?token=new-claim',
        }] });
    });

    it('keeps four-argument loads media-free and only includes newest twenty in the opt-in RPC', async () => {
        const profile = (username: string, index: number) => ({
            username,
            isPrivate: false,
            profilePicUrl: `https://cdn.example/${username}.jpg`,
            secret: `do-not-expose-${index}`,
            latestPosts: [{
                type: 'image',
                imageUrl: `https://cdn.example/${username}-post.jpg`,
            }],
        });
        for (let index = 0; index < 21; index += 1) {
            await db.query(`INSERT INTO public.analysis_v2_profile_fetch_outcomes (
                request_id, job_key, attempt, ordinal, username, status, captured_at, profile_snapshot
            ) VALUES ($1, $2, 'primary', $3, $4, 'success', $5, $6)`, [
                REQUEST_ID,
                JOB_B,
                index + 1,
                `candidate-${String(index).padStart(2, '0')}`,
                new Date(Date.now() + index * 1_000).toISOString(),
                profile(`candidate-${String(index).padStart(2, '0')}`, index),
            ]);
        }

        const legacy = await asService<{ load_analysis_v2_progress: { snapshot: Record<string, unknown> } }>(
            'SELECT public.load_analysis_v2_progress($1, $2)', [REQUEST_ID, OWNER_ID]
        );
        expect(legacy.rows[0]!.load_analysis_v2_progress.snapshot)
            .not.toHaveProperty('candidateMediaRaw');

        const media = await asService<{
            load_analysis_v2_progress_with_candidate_media: {
                snapshot: { candidateMediaRaw: Array<{ username: string; profile: Record<string, unknown> }> };
            };
        }>('SELECT public.load_analysis_v2_progress_with_candidate_media($1, $2)', [REQUEST_ID, OWNER_ID]);
        const candidates = media.rows[0]!.load_analysis_v2_progress_with_candidate_media.snapshot.candidateMediaRaw;
        expect(candidates).toHaveLength(20);
        expect(candidates.map(candidate => candidate.username)).toEqual(
            Array.from({ length: 20 }, (_, index) => `candidate-${String(index + 1).padStart(2, '0')}`)
        );
        expect(candidates[0]!.profile).toEqual({
            profilePicUrl: 'https://cdn.example/candidate-01.jpg',
            latestPosts: [{
                type: 'image',
                imageUrl: 'https://cdn.example/candidate-01-post.jpg',
            }],
        });
        expect(JSON.stringify(candidates)).not.toContain('do-not-expose');
    });

    it('owner-scopes the loader and overlays media from only the latest live heartbeat', async () => {
        await heartbeat({ omitFeedImageUrls: true });
        const legacy = await asService<{ load_analysis_v2_progress: {
            snapshot: { activeProfile: Record<string, unknown> };
        } }>('SELECT public.load_analysis_v2_progress($1, $2)', [REQUEST_ID, OWNER_ID]);
        expect(legacy.rows[0]!.load_analysis_v2_progress.snapshot.activeProfile)
            .not.toHaveProperty('candidateKey');
        await heartbeat({
            startedAt: at(1_000),
            feedImageUrls: ['/api/image-proxy?token=older'],
            candidateKey: 'c'.repeat(64),
        });
        await heartbeat({
            jobKey: JOB_B,
            startedAt: at(2_000),
            feedImageUrls: ['/api/image-proxy?token=latest'],
            candidateKey: CANDIDATE_KEY,
        });
        const owner = await asService<{ load_analysis_v2_progress: {
            snapshot: { activeProfile: unknown };
            events: Array<{ schemaVersion: number; seq: number; eventCode: string }>;
        } }>(
            'SELECT public.load_analysis_v2_progress($1, $2)', [REQUEST_ID, OWNER_ID]
        );
        expect(owner.rows[0]!.load_analysis_v2_progress.snapshot.activeProfile).toEqual({
            maskedUsername: 'c******e', imageUrl: '/api/image-proxy?token=profile',
            feedImageUrls: ['/api/image-proxy?token=latest'],
            currentOrdinal: 0, totalCount: 2, callPhase: 'fetching',
            candidateKey: CANDIDATE_KEY,
        });
        expect(owner.rows[0]!.load_analysis_v2_progress.events).toEqual([
            { schemaVersion: 1, seq: 1, eventCode: 'PROFILE_SCREENED' },
        ]);
        const afterEvent = await asService<{ load_analysis_v2_progress: { events: unknown[] } }>(
            'SELECT public.load_analysis_v2_progress($1, $2, 1)', [REQUEST_ID, OWNER_ID]
        );
        expect(afterEvent.rows[0]!.load_analysis_v2_progress.events).toEqual([]);
        const other = await asService<{ load_analysis_v2_progress: unknown }>(
            'SELECT public.load_analysis_v2_progress($1, $2)', [REQUEST_ID, OTHER_USER_ID]
        );
        expect(other.rows[0]!.load_analysis_v2_progress).toBeNull();
        const otherMedia = await asService<{
            load_analysis_v2_progress_with_candidate_media: unknown;
        }>(
            'SELECT public.load_analysis_v2_progress_with_candidate_media($1, $2)',
            [REQUEST_ID, OTHER_USER_ID]
        );
        expect(otherMedia.rows[0]!.load_analysis_v2_progress_with_candidate_media).toBeNull();
        await db.query(`UPDATE public.analysis_pipeline_jobs
            SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
            WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, JOB_B]);
        const expired = await asService<{ load_analysis_v2_progress: { snapshot: { activeProfile: unknown } } }>(
            'SELECT public.load_analysis_v2_progress($1, $2)', [REQUEST_ID, OWNER_ID]
        );
        expect(expired.rows[0]!.load_analysis_v2_progress.snapshot.activeProfile).toEqual({
            maskedUsername: 'c******e', imageUrl: '/api/image-proxy?token=profile',
            feedImageUrls: ['/api/image-proxy?token=older'],
            currentOrdinal: 0, totalCount: 2, callPhase: 'fetching',
            candidateKey: 'c'.repeat(64),
        });
    });

    it('keeps terminal purge, RLS, and exact service-role-only RPC ACLs intact', async () => {
        await heartbeat({
            feedImageUrls: ['/api/image-proxy?token=purge'],
            candidateKey: CANDIDATE_KEY,
        });
        await db.query("UPDATE public.analysis_pipeline_jobs SET status = 'completed' WHERE request_id = $1 AND job_key = $2", [REQUEST_ID, JOB_A]);
        await expect(db.query('SELECT * FROM public.analysis_v2_active_profile_heartbeats')).resolves.toMatchObject({ rows: [] });
        const privileges = await db.query<{
            rpc_service: boolean; rpc_auth: boolean; table_auth: boolean;
            helper_service: boolean; helper_auth: boolean; helper_anon: boolean;
            load_service: boolean; load_auth: boolean; load_anon: boolean;
            media_load_service: boolean; media_load_auth: boolean; media_load_anon: boolean;
        }>(`
            SELECT pg_catalog.has_function_privilege('service_role',
                       'public.checkpoint_analysis_v2_active_profile_heartbeat(uuid,text,uuid,text,timestamptz,integer,text,text,text[],text,integer,text)', 'EXECUTE') AS rpc_service,
                   pg_catalog.has_function_privilege('authenticated',
                       'public.checkpoint_analysis_v2_active_profile_heartbeat(uuid,text,uuid,text,timestamptz,integer,text,text,text[],text,integer,text)', 'EXECUTE') AS rpc_auth,
                   pg_catalog.has_table_privilege('authenticated',
                       'public.analysis_v2_active_profile_heartbeats', 'SELECT') AS table_auth,
                   pg_catalog.has_function_privilege('service_role',
                       'public.analysis_v2_valid_active_profile_feed_image_urls(text[])', 'EXECUTE') AS helper_service,
                   pg_catalog.has_function_privilege('authenticated',
                       'public.analysis_v2_valid_active_profile_feed_image_urls(text[])', 'EXECUTE') AS helper_auth,
                   pg_catalog.has_function_privilege('anon',
                       'public.analysis_v2_valid_active_profile_feed_image_urls(text[])', 'EXECUTE') AS helper_anon,
                   pg_catalog.has_function_privilege('service_role',
                       'public.load_analysis_v2_progress(uuid,uuid,bigint,integer)', 'EXECUTE') AS load_service,
                   pg_catalog.has_function_privilege('authenticated',
                       'public.load_analysis_v2_progress(uuid,uuid,bigint,integer)', 'EXECUTE') AS load_auth,
                   pg_catalog.has_function_privilege('anon',
                       'public.load_analysis_v2_progress(uuid,uuid,bigint,integer)', 'EXECUTE') AS load_anon,
                   pg_catalog.has_function_privilege('service_role',
                       'public.load_analysis_v2_progress_with_candidate_media(uuid,uuid,bigint,integer)', 'EXECUTE') AS media_load_service,
                   pg_catalog.has_function_privilege('authenticated',
                       'public.load_analysis_v2_progress_with_candidate_media(uuid,uuid,bigint,integer)', 'EXECUTE') AS media_load_auth,
                   pg_catalog.has_function_privilege('anon',
                       'public.load_analysis_v2_progress_with_candidate_media(uuid,uuid,bigint,integer)', 'EXECUTE') AS media_load_anon
        `);
        expect(privileges.rows[0]).toEqual({
            rpc_service: true, rpc_auth: false, table_auth: false,
            helper_service: false, helper_auth: false, helper_anon: false,
            load_service: true, load_auth: false, load_anon: false,
            media_load_service: true, media_load_auth: false, media_load_anon: false,
        });
        const rls = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
            SELECT relrowsecurity, relforcerowsecurity
            FROM pg_catalog.pg_class
            WHERE oid = 'public.analysis_v2_active_profile_heartbeats'::pg_catalog.regclass
        `);
        expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    });
});
