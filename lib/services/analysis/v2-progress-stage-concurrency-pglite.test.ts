import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const stateMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260713183230_add_analysis_v2_progress_state.sql',
    import.meta.url,
), 'utf8');
const heartbeatMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260714024500_add_analysis_v2_active_profile_heartbeats.sql',
    import.meta.url,
), 'utf8');
const candidateMediaMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260801010000_add_progress_candidate_media.sql',
    import.meta.url,
), 'utf8');
const signalsMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260829120000_add_analysis_v2_progress_signals_history.sql',
    import.meta.url,
), 'utf8');

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);
const BASELINE_FINGERPRINT = '0'.repeat(64);
const PROFILE_JOB = 'track:profiles:batch:0';
const PROFILE_AI_JOB = 'track:profile-ai:batch:0';
const FINALIZATION_JOB = 'track:final-score';

type TrackId = 'relationshipAi' | 'interactions' | 'finalization';
type JsonTrack = {
    state: 'pending' | 'running' | 'completed' | 'failed';
    stageCode: string;
    done: number;
    total: number;
    progressBp: number;
};
type Tracks = Record<TrackId, JsonTrack>;
type CheckpointResult = {
    snapshot: {
        revision: number;
        tracks: Tracks;
    };
    event: { eventCode: string } | null;
};

let db: PGlite;

function weightedProgress(relationshipDone: number, relationshipTotal: number, finalizationDone: number, finalizationTotal: number): number {
    return Math.floor(
        7200 * relationshipDone / relationshipTotal
        + 1100 * finalizationDone / finalizationTotal,
    );
}

function tracks(overrides: {
    relationshipStage?: string;
    relationshipDone?: number;
    finalizationStage?: string;
    finalizationDone?: number;
} = {}): Tracks {
    const relationshipDone = overrides.relationshipDone ?? 1;
    const finalizationDone = overrides.finalizationDone ?? 0;
    return {
        relationshipAi: {
            state: 'running',
            stageCode: overrides.relationshipStage ?? 'PUBLIC_PROFILES_COLLECTING',
            done: relationshipDone,
            total: 4,
            progressBp: Math.floor(relationshipDone * 10000 / 4),
        },
        interactions: {
            state: 'pending',
            stageCode: 'INTERACTIONS_QUEUED',
            done: 0,
            total: 2,
            progressBp: 0,
        },
        finalization: {
            state: finalizationDone > 0 ? 'running' : 'pending',
            stageCode: overrides.finalizationStage ?? 'FINALIZATION_QUEUED',
            done: finalizationDone,
            total: 3,
            progressBp: Math.floor(finalizationDone * 10000 / 3),
        },
    };
}

async function checkpoint(input: {
    jobKey: string;
    stageTracks: Tracks;
    progressBp: number;
    fingerprint: string;
    event?: {
        state: 'provisional' | 'confirmed' | 'corrected';
        eventCode: string;
        copyCode: string;
        aggregateCount: number | null;
    };
    eventKey?: string;
}): Promise<CheckpointResult> {
    const result = await db.query<{ checkpoint_analysis_v2_progress: CheckpointResult }>(
        `SELECT public.checkpoint_analysis_v2_progress(
            $1::UUID, $2::TEXT, $3::UUID, $4::TEXT, $5::TEXT, $6::INTEGER,
            $7::BOOLEAN, $8::JSONB, $9::JSONB, $10::JSONB, $11::TEXT,
            $12::JSONB, $13::TEXT
        ) AS checkpoint_analysis_v2_progress`,
        [
            REQUEST_ID,
            input.jobKey,
            CLAIM_TOKEN,
            HASH,
            'processing',
            input.progressBp,
            true,
            JSON.stringify(input.stageTracks),
            null,
            null,
            input.fingerprint,
            input.event ? JSON.stringify(input.event) : null,
            input.eventKey ?? null,
        ],
    );
    return result.rows[0]!.checkpoint_analysis_v2_progress;
}

async function seed(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (id, user_id, pipeline_version, status)
         VALUES ($1, $2, 'v2', 'processing')`,
        [REQUEST_ID, OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (consumed_request_id)
         VALUES ($1)`,
        [REQUEST_ID],
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, input_hash, lease_token, lease_expires_at
         ) VALUES
            ($1, $2, 'processing', $4, $3, clock_timestamp() + INTERVAL '5 minutes'),
            ($1, $5, 'processing', $4, $3, clock_timestamp() + INTERVAL '5 minutes'),
            ($1, $6, 'processing', $4, $3, clock_timestamp() + INTERVAL '5 minutes')`,
        [REQUEST_ID, PROFILE_JOB, CLAIM_TOKEN, HASH, PROFILE_AI_JOB, FINALIZATION_JOB],
    );
    const initialTracks = tracks();
    await db.query(
        `INSERT INTO public.analysis_progress_state (
            request_id, revision, status, progress_bp, background_processing,
            tracks, active_profile, eta_range, last_event_seq,
            snapshot_fingerprint
         ) VALUES ($1, 1, 'processing', $2, TRUE, $3::JSONB, NULL, NULL, 0, $4)`,
        [
            REQUEST_ID,
            weightedProgress(1, 4, 0, 3),
            JSON.stringify(initialTracks),
            BASELINE_FINGERPRINT,
        ],
    );
}

describe('V2 progress stage canonicalization under distributed races', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA auth;
            CREATE FUNCTION auth.uid() RETURNS UUID
                LANGUAGE sql STABLE AS $$ SELECT NULL::UUID $$;
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL,
                pipeline_version TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_preflights (
                consumed_request_id UUID PRIMARY KEY
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL,
                input_hash VARCHAR(64) NOT NULL,
                lease_token UUID,
                lease_expires_at TIMESTAMP WITH TIME ZONE,
                PRIMARY KEY (request_id, job_key)
            );
            CREATE TABLE public.analysis_v2_dag_batch_topology (
                request_id UUID NOT NULL,
                topology_kind TEXT NOT NULL,
                batch INTEGER NOT NULL,
                item_count INTEGER NOT NULL,
                PRIMARY KEY (request_id, topology_kind, batch)
            );
        `);
        await db.exec(stateMigration);
        await db.exec(heartbeatMigration);
        await db.exec(candidateMediaMigration);
        await db.exec(`
            CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                attempt TEXT NOT NULL,
                ordinal SMALLINT NOT NULL,
                username TEXT NOT NULL,
                status TEXT NOT NULL,
                captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
                profile_snapshot JSONB
            );
        `);
        await db.exec(signalsMigration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`TRUNCATE public.analysis_progress_events,
            public.analysis_v2_active_profile_heartbeats,
            public.analysis_v2_profile_fetch_outcomes,
            public.analysis_progress_state,
            public.analysis_pipeline_jobs,
            public.analysis_preflights,
            public.analysis_requests`);
        await seed();
    });

    afterAll(async () => { await db.close(); });

    it('keeps profile_ai ahead of a stale profile_fetch reporter', async () => {
        const newer = await checkpoint({
            jobKey: PROFILE_AI_JOB,
            stageTracks: tracks({ relationshipStage: 'PROFILE_SCREENING' }),
            progressBp: 1800,
            fingerprint: '1'.repeat(64),
        });
        const stale = await checkpoint({
            jobKey: PROFILE_JOB,
            stageTracks: tracks({ relationshipStage: 'PUBLIC_PROFILES_COLLECTING' }),
            progressBp: 1800,
            fingerprint: '2'.repeat(64),
            event: {
                state: 'confirmed',
                eventCode: 'PROFILE_SCREENED',
                copyCode: 'PROFILE_SCREENED_CONFIRMED',
                aggregateCount: 1,
            },
            eventKey: '3'.repeat(64),
        });

        expect(newer.snapshot.tracks.relationshipAi.stageCode).toBe('PROFILE_SCREENING');
        expect(stale.snapshot.tracks.relationshipAi.stageCode).toBe('PROFILE_SCREENING');
        expect(stale.snapshot.revision).toBe(newer.snapshot.revision);
        expect(stale.event).toBeNull();
    });

    it('reuses a canonical fingerprint for a later no-op while retaining its event', async () => {
        const advanced = await checkpoint({
            jobKey: PROFILE_AI_JOB,
            stageTracks: tracks({ relationshipStage: 'PROFILE_SCREENING' }),
            progressBp: weightedProgress(1, 4, 0, 3),
            fingerprint: '8'.repeat(64),
        });
        const stale = await checkpoint({
            jobKey: PROFILE_JOB,
            stageTracks: tracks({
                relationshipStage: 'PUBLIC_PROFILES_COLLECTING',
                relationshipDone: 2,
            }),
            progressBp: weightedProgress(2, 4, 0, 3),
            fingerprint: '9'.repeat(64),
        });
        const current = await checkpoint({
            jobKey: PROFILE_AI_JOB,
            stageTracks: tracks({
                relationshipStage: 'PROFILE_SCREENING',
                relationshipDone: 2,
            }),
            progressBp: weightedProgress(2, 4, 0, 3),
            fingerprint: 'a'.repeat(64),
            event: {
                state: 'confirmed',
                eventCode: 'PROFILE_SCREENED',
                copyCode: 'PROFILE_SCREENED_CONFIRMED',
                aggregateCount: 2,
            },
            eventKey: 'b'.repeat(64),
        });

        expect(stale.snapshot.tracks.relationshipAi.stageCode).toBe('PROFILE_SCREENING');
        expect(current.snapshot.tracks.relationshipAi.stageCode).toBe('PROFILE_SCREENING');
        expect(stale.snapshot.revision).toBe(advanced.snapshot.revision + 1);
        expect(current.snapshot.revision).toBe(stale.snapshot.revision + 1);
        expect(current.event?.eventCode).toBe('PROFILE_SCREENED');

        await expect(checkpoint({
            jobKey: PROFILE_AI_JOB,
            stageTracks: tracks({
                relationshipStage: 'PROFILE_SCREENING',
                relationshipDone: 2,
            }),
            progressBp: weightedProgress(2, 4, 0, 3),
            fingerprint: 'a'.repeat(64),
            event: {
                state: 'confirmed',
                eventCode: 'PROFILE_SCREENED',
                copyCode: 'PROFILE_SCREENED_CONFIRMED',
                aggregateCount: 2,
            },
            eventKey: 'b'.repeat(64),
        })).resolves.toMatchObject({
            snapshot: { revision: current.snapshot.revision },
            event: { eventCode: 'PROFILE_SCREENED' },
        });
    });

    it('preserves an advanced track while canonicalizing a stale stage on another track', async () => {
        const profile = await checkpoint({
            jobKey: PROFILE_AI_JOB,
            stageTracks: tracks({ relationshipStage: 'PROFILE_SCREENING' }),
            progressBp: 1800,
            fingerprint: '7'.repeat(64),
        });
        const mixed = await checkpoint({
            jobKey: FINALIZATION_JOB,
            stageTracks: tracks({
                relationshipStage: 'PUBLIC_PROFILES_COLLECTING',
                finalizationStage: 'HIGH_RISK_NARRATIVES_WRITING',
                finalizationDone: 1,
            }),
            progressBp: weightedProgress(1, 4, 1, 3),
            fingerprint: '8'.repeat(64),
        });

        expect(mixed.snapshot.tracks.relationshipAi.stageCode).toBe('PROFILE_SCREENING');
        expect(mixed.snapshot.tracks.finalization.stageCode)
            .toBe('HIGH_RISK_NARRATIVES_WRITING');
        expect(mixed.snapshot.revision).toBe(profile.snapshot.revision + 1);
    });

    it('keeps counter and state regression guards after stage canonicalization', async () => {
        await checkpoint({
            jobKey: PROFILE_AI_JOB,
            stageTracks: tracks({ relationshipStage: 'PROFILE_SCREENING', relationshipDone: 2 }),
            progressBp: weightedProgress(2, 4, 0, 3),
            fingerprint: '9'.repeat(64),
        });

        await expect(checkpoint({
            jobKey: PROFILE_JOB,
            stageTracks: tracks({ relationshipStage: 'PROFILE_SCREENING', relationshipDone: 1 }),
            progressBp: weightedProgress(1, 4, 0, 3),
            fingerprint: 'a'.repeat(64),
        })).rejects.toThrow('ANALYSIS_V2_PROGRESS_REGRESSION');
    });

    it('fails closed when either side of a stage merge has an unknown rank', async () => {
        const knownTrack = tracks({ relationshipStage: 'PROFILE_SCREENING' }).relationshipAi;
        const unknownTrack = { ...knownTrack, stageCode: 'UNKNOWN_STAGE' };
        const result = await db.query<{ unknown_next: string; unknown_previous: string }>(
            `SELECT
                public.analysis_v2_progress_merge_track_stage(
                    'relationshipAi', $1::JSONB, $2::JSONB
                )->>'stageCode' AS unknown_next,
                public.analysis_v2_progress_merge_track_stage(
                    'relationshipAi', $2::JSONB, $1::JSONB
                )->>'stageCode' AS unknown_previous`,
            [JSON.stringify(knownTrack), JSON.stringify(unknownTrack)],
        );

        expect(result.rows[0]).toEqual({
            unknown_next: 'PROFILE_SCREENING',
            unknown_previous: 'UNKNOWN_STAGE',
        });
    });

    it('keeps the newest stage when profile_fetch and profile_ai checkpoints race', async () => {
        await db.query(
            `UPDATE public.analysis_progress_state
             SET tracks = pg_catalog.jsonb_set(
                 tracks,
                 '{relationshipAi,stageCode}',
                 '"RELATIONSHIP_AI_RUNNING"'::JSONB,
                 FALSE
             )
             WHERE request_id = $1`,
            [REQUEST_ID],
        );
        await Promise.all([
            checkpoint({
                jobKey: PROFILE_JOB,
                stageTracks: tracks({ relationshipStage: 'PUBLIC_PROFILES_COLLECTING' }),
                progressBp: 1800,
                fingerprint: '3'.repeat(64),
            }),
            checkpoint({
                jobKey: PROFILE_AI_JOB,
                stageTracks: tracks({ relationshipStage: 'PROFILE_SCREENING' }),
                progressBp: 1800,
                fingerprint: '4'.repeat(64),
            }),
        ]);

        const persisted = await db.query<{ stage_code: string; revision: number }>(
            `SELECT tracks->'relationshipAi'->>'stageCode' AS stage_code, revision
             FROM public.analysis_progress_state WHERE request_id = $1`,
            [REQUEST_ID],
        );
        expect(persisted.rows[0]?.stage_code).toBe('PROFILE_SCREENING');
        expect(persisted.rows[0]?.revision).toBeGreaterThan(1);
    });

    it('keeps a later narrative stage when finalization workers overlap', async () => {
        const newer = await checkpoint({
            jobKey: FINALIZATION_JOB,
            stageTracks: tracks({
                finalizationStage: 'HIGH_RISK_NARRATIVES_WRITING',
                finalizationDone: 1,
            }),
            progressBp: weightedProgress(1, 4, 1, 3),
            fingerprint: '5'.repeat(64),
        });
        const stale = await checkpoint({
            jobKey: FINALIZATION_JOB,
            stageTracks: tracks({
                finalizationStage: 'FINAL_SCORE_CALCULATING',
                finalizationDone: 1,
            }),
            progressBp: weightedProgress(1, 4, 1, 3),
            fingerprint: '6'.repeat(64),
        });

        expect(newer.snapshot.tracks.finalization.stageCode)
            .toBe('HIGH_RISK_NARRATIVES_WRITING');
        expect(stale.snapshot.tracks.finalization.stageCode)
            .toBe('HIGH_RISK_NARRATIVES_WRITING');
        expect(stale.snapshot.revision).toBe(newer.snapshot.revision);
    });
});
