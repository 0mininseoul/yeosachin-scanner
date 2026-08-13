import { readdirSync, readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationName = readdirSync(new URL('../../../supabase/migrations/', import.meta.url))
    .find(name => name.endsWith('_precheckout_blite_single_collection.sql'));
if (!migrationName) throw new Error('PRECHECKOUT_BLITE_MIGRATION_MISSING');
const migration = readFileSync(new URL(
    `../../../supabase/migrations/${migrationName}`,
    import.meta.url,
), 'utf8');

const databaseUrl = process.env.PRECHECKOUT_BLITE_POSTGRES_CONCURRENCY_TEST_URL;
const destructiveTestMarker = process.env.PRECHECKOUT_BLITE_POSTGRES_CONCURRENCY_TEST_MARKER;
const marker = 'local-ephemeral-precheckout-blite-concurrency-only';
const describePostgres = isSafePrecheckoutBlitePostgresConcurrencyTarget(
    databaseUrl,
    destructiveTestMarker,
) ? describe : describe.skip;

const PREFLIGHT = '20000000-0000-4000-8000-000000000201';
const USER = '10000000-0000-4000-8000-000000000201';
const CLAIM = '40000000-0000-4000-8000-000000000201';
const HASH = 'a'.repeat(64);
const PAYLOAD_HASH = 'b'.repeat(64);
const PROVIDER_REFERENCE = 'ApifyRun123456';
const SOURCE = JSON.stringify({ schemaVersion: 1, fullName: null, posts: [], media: [] });

export function isSafePrecheckoutBlitePostgresConcurrencyTarget(
    connectionString: string | undefined,
    suppliedMarker: string | undefined,
): boolean {
    if (suppliedMarker !== marker || !connectionString) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/precheckout_blite_concurrency_test';
    } catch {
        return false;
    }
}

function faithfulPreMigrationBootstrap(): string {
    const source = readFileSync(new URL(
        './blite-single-collection-pglite.test.ts',
        import.meta.url,
    ), 'utf8');
    const matched = source.match(/const bootstrap = `([\s\S]*?)`;\n\nlet db/);
    if (!matched?.[1]) throw new Error('PRECHECKOUT_BLITE_POSTGRES_BOOTSTRAP_MISSING');
    return matched[1].replace(
        'CREATE ROLE anon NOLOGIN;\nCREATE ROLE authenticated NOLOGIN;\nCREATE ROLE service_role NOLOGIN;',
        () => `DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
               DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
               DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
}

async function asService<T>(
    client: PoolClient,
    sql: string,
    values: unknown[] = [],
): Promise<T> {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query<{ result: T }>(sql, values);
        await client.query('COMMIT');
        if (!result.rows[0]) throw new Error('PRECHECKOUT_BLITE_POSTGRES_EMPTY_RPC_RESULT');
        return result.rows[0].result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

async function waitForApplicationName(pool: Pool, applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await pool.query<{ active: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_stat_activity
                WHERE application_name = $1 AND state = 'active'
            ) AS active`,
            [applicationName],
        );
        if (result.rows[0]?.active) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('PRECHECKOUT_BLITE_POSTGRES_LOCK_BARRIER_TIMEOUT');
}

describe('precheckout B-lite PostgreSQL concurrency target guard', () => {
    it('accepts only the explicit loopback disposable concurrency database and marker', () => {
        expect(isSafePrecheckoutBlitePostgresConcurrencyTarget(
            'postgresql://tester@127.0.0.1:55432/precheckout_blite_concurrency_test',
            marker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/precheckout_blite_concurrency_test', marker],
        ['postgresql://tester@127.0.0.1:55432/postgres', marker],
        ['postgresql://tester@127.0.0.1:55432/precheckout_blite_concurrency_test', undefined],
    ])('rejects unsafe targets and absent markers', (url, suppliedMarker) => {
        expect(isSafePrecheckoutBlitePostgresConcurrencyTarget(url, suppliedMarker)).toBe(false);
    });
});

describePostgres('precheckout B-lite PostgreSQL lease concurrency', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 5 });
        await pool.query(`
            DROP SCHEMA IF EXISTS public CASCADE;
            DROP SCHEMA IF EXISTS extensions CASCADE;
            CREATE SCHEMA public;
        `);
        await pool.query(faithfulPreMigrationBootstrap());
        await pool.query('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
        await pool.query(migration);
        await pool.query(`
            CREATE FUNCTION public.test_hold_precheckout_blite_claim(p_preflight_id UUID)
            RETURNS JSONB
            LANGUAGE plpgsql
            AS $$
            DECLARE v_result JSONB;
            BEGIN
                v_result := public.claim_precheckout_blite_v2(p_preflight_id);
                PERFORM pg_catalog.set_config('application_name', 'precheckout-blite-claim-holding-lock', FALSE);
                PERFORM pg_catalog.pg_sleep(0.35);
                RETURN v_result;
            END;
            $$;
        `);
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                id,user_id,status,expires_at,target_input_hash,lease_token,lease_expires_at,
                created_at,precheckout_blite_cohort
            ) VALUES (
                $1,$2,'processing',clock_timestamp() + interval '20 minutes',$3,$4,
                clock_timestamp() + interval '5 minutes',clock_timestamp() - interval '5 seconds',true
            )`,
            [PREFLIGHT, USER, HASH, CLAIM],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id,input_hash,logical_provider,status,run_id
            ) VALUES ($1,$2,'apify','succeeded',$3)`,
            [PREFLIGHT, HASH, PROVIDER_REFERENCE],
        );
        await pool.query(
            `SELECT public.finalize_preflight_blite_source_v1(
                $1,$2,$3,$4,$1,$5,
                'Target',NULL,'https://cdninstagram.com/profile.jpg',1,1,false,
                'basic','basic','{}'::jsonb,$6::jsonb,$7,
                clock_timestamp() - interval '1 second',
                (SELECT expires_at FROM public.analysis_preflights WHERE id=$1)
            )`,
            [PREFLIGHT, USER, CLAIM, HASH, PROVIDER_REFERENCE, SOURCE, PAYLOAD_HASH],
        );
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('gives exactly one concurrent service worker the lease and returns pending to the waiter', async () => {
        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const owner = asService<{ disposition: string; leaseToken: string }>(
                first,
                'SELECT public.test_hold_precheckout_blite_claim($1) AS result',
                [PREFLIGHT],
            );
            await waitForApplicationName(pool, 'precheckout-blite-claim-holding-lock');
            const waiter = asService<{ disposition: string }>(
                second,
                'SELECT public.claim_precheckout_blite_v2($1) AS result',
                [PREFLIGHT],
            );
            await expect(owner).resolves.toMatchObject({ disposition: 'claimed' });
            await expect(waiter).resolves.toEqual({ disposition: 'pending' });
        } finally {
            first.release();
            second.release();
        }
    }, 30_000);
});
