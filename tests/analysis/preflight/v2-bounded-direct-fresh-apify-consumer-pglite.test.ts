import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
    originalProfileConsumerSql,
    profileConsumerFixtureSql,
    profileConsumerReadSql,
} from './fixtures/profile-consumer';

const HASH = (seed: string): string => seed.repeat(64).slice(0, 64);
const CONSUMER_INPUT_HASH = HASH('a');
const PRODUCER_INPUT_HASH = HASH('b');
const PRIMARY_PAYLOAD_HASH = HASH('c');
const FALLBACK_PAYLOAD_HASH = HASH('d');
const REPAIR_PAYLOAD_HASH = HASH('e');

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '20000000-0000-4000-8000-000000000001';
const PRODUCER_JOB_KEY = 'track:profiles:batch:0';
const CONSUMER_JOB_KEY = 'track:profile-ai:batch:0';

const databases: PGlite[] = [];

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(profileConsumerFixtureSql);
    await db.exec(originalProfileConsumerSql);
    await db.exec(profileConsumerReadSql);
    return db;
}

afterEach(async () => {
    while (databases.length > 0) {
        const db = databases.pop();
        await db?.close();
    }
});

async function asService<T>(db: PGlite, sql: string, params: unknown[] = []) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

function usernames(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `user${String(i + 1).padStart(3, '0')}`);
}

type OutcomeRow = {
    ordinal: number;
    username: string;
    attempt?: string;
    source?: string;
    status: 'success' | 'unavailable' | 'failed';
    failureCategory?: string | null;
};

async function seedRequestAndJobs(
    db: PGlite,
    options: { producerStatus?: string } = {}
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests(id, pipeline_version, status)
         VALUES ($1, 'v2', 'processing')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(id, consumed_request_id)
         VALUES (pg_catalog.gen_random_uuid(), $1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(
             request_id, job_key, status, input_hash, lease_token, lease_expires_at,
             track, kind, batch
         ) VALUES
             ($1, $2, $3, $4, NULL, NULL, 'profiles', 'profile_fetch', 0),
             ($1, $5, 'processing', $6, $7, clock_timestamp() + interval '10 minutes',
              'profile_ai', 'ai', 0)`,
        [
            REQUEST_ID, PRODUCER_JOB_KEY, options.producerStatus ?? 'completed',
            PRODUCER_INPUT_HASH, CONSUMER_JOB_KEY, CONSUMER_INPUT_HASH, CLAIM_TOKEN,
        ]
    );
}

async function seedBatch(
    db: PGlite,
    options: {
        requestedUsernames: string[];
        frozenUnresolvedUsernames: string[];
        outcomes: OutcomeRow[];
        fallback?: boolean;
        repair?: boolean;
    }
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_v2_profile_fetch_batches(
             request_id, job_key, requested_usernames, frozen_unresolved_usernames,
             primary_payload_hash, fallback_payload_hash, fallback_completed_at,
             repair_usernames, repair_payload_hash, repair_completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            REQUEST_ID, PRODUCER_JOB_KEY, options.requestedUsernames,
            options.frozenUnresolvedUsernames, PRIMARY_PAYLOAD_HASH,
            options.fallback ? FALLBACK_PAYLOAD_HASH : null,
            options.fallback ? '2026-08-28T00:00:00.000Z' : null,
            options.repair ? options.frozenUnresolvedUsernames : null,
            options.repair ? REPAIR_PAYLOAD_HASH : null,
            options.repair ? '2026-08-28T01:00:00.000Z' : null,
        ]
    );
    for (const row of options.outcomes) {
        const success = row.status === 'success';
        await db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_outcomes(
                 request_id, job_key, attempt, ordinal, username, source, status,
                 failure_category, profile_snapshot
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                REQUEST_ID, PRODUCER_JOB_KEY, row.attempt ?? 'fresh_apify', row.ordinal,
                row.username, row.source ?? (row.attempt && row.attempt !== 'fresh_apify' ? 'cache' : 'apify'),
                row.status,
                row.failureCategory ?? (success ? null : row.status === 'unavailable' ? 'not_found' : 'incomplete'),
                success ? JSON.stringify({ username: row.username }) : null,
            ]
        );
    }
}

async function loadForConsumer(db: PGlite, expectedItemCount: number) {
    return asService<{ snapshot: unknown }>(
        db,
        `SELECT public.load_analysis_v2_profile_fetch_for_consumer(
             $1, $2, $3, $4, $5, $6, $7
         ) AS snapshot`,
        [
            REQUEST_ID, CONSUMER_JOB_KEY, CLAIM_TOKEN, CONSUMER_INPUT_HASH,
            PRODUCER_JOB_KEY, PRODUCER_INPUT_HASH, expectedItemCount,
        ]
    );
}

/**
 * Builds N outcome rows with `failedCount` failed(incomplete) rows and
 * `unavailableCount` unavailable(not_found) rows, the rest success, all
 * attempt='fresh_apify'/source='apify' and aligned to `names`.
 */
function buildOutcomes(
    names: string[],
    failedCount: number,
    unavailableCount = 0
): { outcomes: OutcomeRow[]; frozenUnresolvedUsernames: string[] } {
    const outcomes: OutcomeRow[] = names.map((username, index) => {
        if (index < failedCount) {
            return { ordinal: index + 1, username, status: 'failed', failureCategory: 'incomplete' };
        }
        if (index < failedCount + unavailableCount) {
            return { ordinal: index + 1, username, status: 'unavailable', failureCategory: 'not_found' };
        }
        return { ordinal: index + 1, username, status: 'success' };
    });
    const frozenUnresolvedUsernames = outcomes
        .filter(row => row.status !== 'success')
        .map(row => row.username);
    return { outcomes, frozenUnresolvedUsernames };
}

describe('bounded direct fresh_apify consumer (PGlite)', () => {
    // Regression guard: production's analysis_v2_profile_fetch_outcomes.username
    // is VARCHAR(30) (20260713164030_add_analysis_v2_profile_fetch_checkpoints.sql),
    // not TEXT. array_agg() over a VARCHAR(30) column yields character
    // varying[], which has no `=` operator against the TEXT[]
    // frozen_unresolved_usernames column -- a mismatch this fixture must keep
    // reproducing. If this column type ever drifts back to TEXT, the
    // fixture stops exercising that real production type boundary and could
    // silently hide a regression of the ::TEXT cast in the migration itself.
    it('keeps the fixture schema-faithful to production: outcomes.username is VARCHAR(30), not TEXT', async () => {
        const db = await createDb();
        const result = await db.query<{
            data_type: string;
            character_maximum_length: number | null;
        }>(
            `SELECT data_type, character_maximum_length
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'analysis_v2_profile_fetch_outcomes'
               AND column_name = 'username'`
        );
        expect(result.rows[0]?.data_type).toBe('character varying');
        expect(result.rows[0]?.character_maximum_length).toBe(30);
    });

    it('accepts an all-success direct fresh_apify batch (baseline, unaffected by this change)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 0);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 5);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual([]);
        expect((snapshot.primaryResults as unknown[]).length).toBe(5);
    });

    it('accepts the production-shaped 29 success + 1 incomplete failure of 30', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(30);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 30);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual([names[0]]);
        expect((snapshot.primaryResults as unknown[]).length).toBe(30);
    });

    it('accepts the production-shaped 26 success + 1 schema failure of 27', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(27);
        const outcomes: OutcomeRow[] = names.map((username, index) => (
            index === 0
                ? { ordinal: 1, username, status: 'failed', failureCategory: 'schema' }
                : { ordinal: index + 1, username, status: 'success' }
        ));
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames: [names[0]],
            outcomes,
        });

        const result = await loadForConsumer(db, 27);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual([names[0]]);
        expect((snapshot.primaryResults as unknown[]).length).toBe(27);
    });

    it('accepts unbounded unavailable rows with zero failed rows (unavailable is never bounded or rejected)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        // 7 unavailable, 3 success, 0 failed -- far past the failed bound
        // (which would be 1 for N=10) but unavailable does not count against
        // it at all, matching evaluateProfileBatchCompleteness.
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 0, 7);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 10);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual(names.slice(0, 7));
    });

    it('accepts unavailable rows mixed with an in-bound number of failed rows', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        // bound for N=10 is 10 - ceil(9) = 1; exactly 1 failed + 3 unavailable.
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1, 3);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 10);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual(names.slice(0, 4));
    });

    it('rejects a transient failure category (timeout) even within the count bound', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        const outcomes: OutcomeRow[] = names.map((username, index) => (
            index === 0
                ? { ordinal: 1, username, status: 'failed', failureCategory: 'timeout' }
                : { ordinal: index + 1, username, status: 'success' }
        ));
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames: [names[0]],
            outcomes,
        });

        await expect(loadForConsumer(db, 10)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects excessive failed rows beyond the requested_count - CEIL(0.9x) bound', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        // bound is 1; 2 failed rows exceeds it.
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 2);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        await expect(loadForConsumer(db, 10)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects malformed/misaligned evidence (username does not match its requested ordinal)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        // Swap the (both-success) ordinal-2/ordinal-3 usernames so stored
        // outcome rows no longer match batch.requested_usernames at their
        // ordinal, while every other property (count, frozen set, bound)
        // still looks admissible.
        const swapped = outcomes.map(row => {
            if (row.ordinal === 2) return { ...row, username: names[2] };
            if (row.ordinal === 3) return { ...row, username: names[1] };
            return row;
        });
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes: swapped,
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects an incomplete row set (fewer outcome rows than requested)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        // Drop the last (success) row entirely: 4 physical rows for 5 requested.
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes: outcomes.slice(0, 4),
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects a wrong-attempt/wrong-source row mixed into an otherwise valid batch', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        // Replace the one failed row's attempt/source with a legacy primary
        // row instead of fresh_apify/apify.
        const corrupted = outcomes.map(row => (
            row.ordinal === 1
                ? { ...row, attempt: 'primary', source: 'cache' }
                : row
        ));
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes: corrupted,
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects when repair state exists on the batch, even with otherwise-bounded fresh_apify rows', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes,
            repair: true,
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects when the producer job has not completed', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db, { producerStatus: 'processing' });
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });
});
