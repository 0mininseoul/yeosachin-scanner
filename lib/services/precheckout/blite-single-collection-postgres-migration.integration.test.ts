import { readdirSync, readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationName = readdirSync(new URL('../../../supabase/migrations/', import.meta.url))
    .find(name => name.endsWith('_precheckout_blite_single_collection.sql'));
if (!migrationName) throw new Error('PRECHECKOUT_BLITE_MIGRATION_MISSING');
const migration = readFileSync(new URL(
    `../../../supabase/migrations/${migrationName}`,
    import.meta.url,
), 'utf8');

const databaseUrl = process.env.PRECHECKOUT_BLITE_POSTGRES_TEST_URL;
const destructiveTestMarker = process.env.PRECHECKOUT_BLITE_POSTGRES_TEST_MARKER;
const marker = 'local-ephemeral-precheckout-blite-only';
const describePostgres = isSafePrecheckoutBlitePostgresTestTarget(databaseUrl, destructiveTestMarker)
    ? describe
    : describe.skip;

const LEGACY_PREFLIGHT = '20000000-0000-4000-8000-000000000101';
const ORIGIN_PREFLIGHT = '20000000-0000-4000-8000-000000000102';

export function isSafePrecheckoutBlitePostgresTestTarget(
    connectionString: string | undefined,
    suppliedMarker: string | undefined,
): boolean {
    if (suppliedMarker !== marker || !connectionString) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/precheckout_blite_migration_test';
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
    pool: Pool,
    text: string,
    values: unknown[] = [],
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query<{ result: T }>(text, values);
        await client.query('COMMIT');
        if (!result.rows[0]) throw new Error('PRECHECKOUT_BLITE_POSTGRES_EMPTY_RPC_RESULT');
        return result.rows[0].result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

describe('precheckout B-lite PostgreSQL destructive-test target guard', () => {
    it('accepts only the explicit loopback disposable database and marker', () => {
        expect(isSafePrecheckoutBlitePostgresTestTarget(
            'postgresql://tester@127.0.0.1:55432/precheckout_blite_migration_test',
            marker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/precheckout_blite_migration_test', marker],
        ['postgresql://tester@127.0.0.1:55432/postgres', marker],
        ['postgresql://tester@127.0.0.1:55432/precheckout_blite_migration_test', undefined],
    ])('rejects unsafe targets and absent markers', (url, suppliedMarker) => {
        expect(isSafePrecheckoutBlitePostgresTestTarget(url, suppliedMarker)).toBe(false);
    });
});

describePostgres('precheckout B-lite PostgreSQL migration compatibility', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 3 });
        await pool.query(`
            DROP SCHEMA IF EXISTS public CASCADE;
            DROP SCHEMA IF EXISTS extensions CASCADE;
            CREATE SCHEMA public;
        `);
        await pool.query(faithfulPreMigrationBootstrap());
        await pool.query('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
        await pool.query(migration);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('replaces the inherited two-state check and preserves the flag-off v1 lifecycle', async () => {
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',false)`,
            [LEGACY_PREFLIGHT],
        );
        const first = await asService<{ disposition: string; leaseToken: string }>(
            pool,
            'SELECT public.claim_precheckout_blite_v1($1) AS result',
            [LEGACY_PREFLIGHT],
        );
        expect(first.disposition).toBe('claimed');
        await expect(asService<boolean>(
            pool,
            'SELECT public.release_precheckout_blite_v1($1,$2) AS result',
            [LEGACY_PREFLIGHT, first.leaseToken],
        )).resolves.toBe(true);
        const second = await asService<{ disposition: string; leaseToken: string }>(
            pool,
            'SELECT public.claim_precheckout_blite_v1($1) AS result',
            [LEGACY_PREFLIGHT],
        );
        await expect(asService<boolean>(
            pool,
            `SELECT public.complete_precheckout_blite_v1($1,$2,'{"legacy":true}'::jsonb) AS result`,
            [LEGACY_PREFLIGHT, second.leaseToken],
        )).resolves.toBe(true);

        await expect(pool.query(
            `SELECT state,dto,
                    has_function_privilege('authenticated','public.claim_precheckout_blite_v1(uuid)','EXECUTE') AS browser_allowed,
                    has_function_privilege('service_role','public.claim_precheckout_blite_v1(uuid)','EXECUTE') AS service_allowed
             FROM public.precheckout_blite_cache WHERE preflight_id=$1`,
            [LEGACY_PREFLIGHT],
        )).resolves.toMatchObject({
            rows: [{
                state: 'complete',
                dto: { legacy: true },
                browser_allowed: false,
                service_allowed: true,
            }],
        });

        await expect(pool.query(
            `INSERT INTO public.analysis_preflights(
                id,status,expires_at
            ) VALUES ($1,'ready',clock_timestamp() + interval '10 minutes')`,
            [ORIGIN_PREFLIGHT],
        )).resolves.toBeDefined();
        await expect(pool.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id,state,lease_token,lease_expires_at,attempt_count,
                failure_reason,failed_at,created_at,updated_at
            ) VALUES (
                $1,'failed','40000000-0000-4000-8000-000000000101',
                clock_timestamp(),2,'attempts_exhausted',clock_timestamp(),
                clock_timestamp(),clock_timestamp()
            )`,
            [ORIGIN_PREFLIGHT],
        )).resolves.toBeDefined();
    });

    it('anchors cohort clocks to the immutable created_at origin across delayed assignment', async () => {
        const preflightId = '20000000-0000-4000-8000-000000000103';
        const origin = '2026-08-13T00:00:00.000Z';
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                id,status,expires_at,created_at,precheckout_blite_cohort
            ) VALUES ($1,'processing',clock_timestamp() + interval '10 minutes',$2,false)`,
            [preflightId, origin],
        );
        await pool.query(
            'UPDATE public.analysis_preflights SET precheckout_blite_cohort=true WHERE id=$1',
            [preflightId],
        );
        await pool.query(
            `UPDATE public.analysis_preflights
             SET updated_at=clock_timestamp() WHERE id=$1`,
            [preflightId],
        );
        await expect(pool.query(
            `SELECT submitted_at = created_at AS submitted_from_origin,
                    deadline_at = created_at + interval '60 seconds' AS deadline_from_origin
             FROM public.analysis_preflights WHERE id=$1`,
            [preflightId],
        )).resolves.toMatchObject({ rows: [{ submitted_from_origin: true, deadline_from_origin: true }] });
        await expect(pool.query(
            `UPDATE public.analysis_preflights
             SET submitted_at=clock_timestamp(),deadline_at=clock_timestamp() + interval '60 seconds'
             WHERE id=$1`,
            [preflightId],
        )).rejects.toThrow('PRECHECKOUT_BLITE_CLOCK_IMMUTABLE');
    });
});
