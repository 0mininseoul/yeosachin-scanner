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
const LEGACY_FAILED_PREFLIGHT = '20000000-0000-4000-8000-000000000104';
const ALL_EVIDENCE_PREFLIGHT = '20000000-0000-4000-8000-000000000105';
const ALL_EVIDENCE_LEASE = '40000000-0000-4000-8000-000000000105';
const ALL_EVIDENCE_HASH = 'a'.repeat(64);
const COHORT_V1_PREFLIGHT = '20000000-0000-4000-8000-000000000106';
const COHORT_V1_LEASE = '40000000-0000-4000-8000-000000000106';
const ALL_EVIDENCE_DTO = JSON.stringify({
    schemaVersion: 1,
    persona: { headline: '분석 헤드라인', summary: '분석 요약 문장입니다' },
    signals: [
        { claim: '신호 하나', category: '관계', confidence: 0.8, band: 'high' },
        { claim: '신호 둘', category: '관계', confidence: 0.6, band: 'medium' },
        { claim: '신호 셋', category: '관계', confidence: 0.4, band: 'low' },
        { claim: '신호 넷', category: '관계', confidence: 0.7, band: 'high' },
    ],
    candidateRange: { min: 1, max: 2 },
    genderRead: {
        likelyFemale: true,
        confidence: 0.8,
        reasons: ['이유 하나', '이유 둘', '이유 셋'],
    },
    postCount: 0,
    evidenceFields: [
        'post.caption', 'post.hashtags', 'post.type', 'post.mediaItems',
        'post.declaredMediaCount', 'post.likesCount', 'post.commentsCount',
        'post.likesCountHidden', 'post.commentsCountHidden', 'post.taggedUsers',
        'post.mentionedUsers', 'post.imageUrl', 'post.thumbnailUrl',
        'profile.fullName', 'profile.profilePicUrl',
    ],
});

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

    it('keeps a v1 claim non-mutating when it sees a terminal B-lite failed cache row', async () => {
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',false)`,
            [LEGACY_FAILED_PREFLIGHT],
        );
        await pool.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id,state,lease_token,lease_expires_at,attempt_count,
                failure_reason,failed_at,created_at,updated_at
            ) VALUES (
                $1,'failed','40000000-0000-4000-8000-000000000104',
                clock_timestamp() - interval '1 second',2,'attempts_exhausted',clock_timestamp(),
                clock_timestamp() - interval '2 seconds',clock_timestamp()
            )`,
            [LEGACY_FAILED_PREFLIGHT],
        );

        await expect(asService<{ disposition: string }>(
            pool,
            'SELECT public.claim_precheckout_blite_v1($1) AS result',
            [LEGACY_FAILED_PREFLIGHT],
        )).resolves.toEqual({ disposition: 'pending' });
        await expect(pool.query(
            `SELECT state,lease_token,failure_reason
             FROM public.precheckout_blite_cache WHERE preflight_id=$1`,
            [LEGACY_FAILED_PREFLIGHT],
        )).resolves.toMatchObject({ rows: [{
            state: 'failed',
            lease_token: '40000000-0000-4000-8000-000000000104',
            failure_reason: 'attempts_exhausted',
        }] });
    });

    it('accepts a v2 completion with all fifteen allowlisted evidence fields', async () => {
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,target_input_hash,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',$2,true)`,
            [ALL_EVIDENCE_PREFLIGHT, ALL_EVIDENCE_HASH],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id,operation_key,input_hash,logical_provider,status,run_id
            ) VALUES ($1,'target-profile-fallback',$2,'apify','succeeded','ApifyRun123456')`,
            [ALL_EVIDENCE_PREFLIGHT, ALL_EVIDENCE_HASH],
        );
        await pool.query(
            `INSERT INTO public.precheckout_blite_sources(
                preflight_id,schema_version,target_input_hash,provider_run_id,provider_operation_key,
                provider_run_reference,payload,payload_bytes,payload_hash,collected_at,expires_at
            ) VALUES (
                $1,1,$2,$1,'target-profile-fallback','ApifyRun123456','{}'::jsonb,2,
                repeat('b',64),clock_timestamp(),clock_timestamp() + interval '10 minutes'
            )`,
            [ALL_EVIDENCE_PREFLIGHT, ALL_EVIDENCE_HASH],
        );
        await pool.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id,state,lease_token,lease_expires_at,attempt_count,created_at,updated_at
            ) VALUES ($1,'pending',$2,clock_timestamp() + interval '2 minutes',1,
                clock_timestamp(),clock_timestamp())`,
            [ALL_EVIDENCE_PREFLIGHT, ALL_EVIDENCE_LEASE],
        );

        await expect(asService<boolean>(
            pool,
            'SELECT public.complete_precheckout_blite_v2($1,$2,$3::jsonb) AS result',
            [ALL_EVIDENCE_PREFLIGHT, ALL_EVIDENCE_LEASE, ALL_EVIDENCE_DTO],
        )).resolves.toBe(true);
    });

    it('rejects a legacy v1 claim on a source-backed cohort without mutating its lifecycle rows', async () => {
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                id,status,ready_at,expires_at,target_input_hash,precheckout_blite_cohort
            ) VALUES ($1,'ready',clock_timestamp(),clock_timestamp() + interval '10 minutes',$2,true)`,
            [COHORT_V1_PREFLIGHT, ALL_EVIDENCE_HASH],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id,operation_key,input_hash,logical_provider,status,run_id
            ) VALUES ($1,'target-profile-fallback',$2,'apify','succeeded','ApifyRun123456')`,
            [COHORT_V1_PREFLIGHT, ALL_EVIDENCE_HASH],
        );
        await pool.query(
            `INSERT INTO public.precheckout_blite_sources(
                preflight_id,schema_version,target_input_hash,provider_run_id,provider_operation_key,
                provider_run_reference,payload,payload_bytes,payload_hash,collected_at,expires_at
            ) VALUES (
                $1,1,$2,$1,'target-profile-fallback','ApifyRun123456','{}'::jsonb,2,
                repeat('b',64),clock_timestamp(),clock_timestamp() + interval '10 minutes'
            )`,
            [COHORT_V1_PREFLIGHT, ALL_EVIDENCE_HASH],
        );
        await pool.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id,state,lease_token,lease_expires_at,attempt_count,created_at,updated_at
            ) VALUES ($1,'pending',$2,clock_timestamp() - interval '1 second',0,
                clock_timestamp() - interval '2 seconds',clock_timestamp() - interval '2 seconds')`,
            [COHORT_V1_PREFLIGHT, COHORT_V1_LEASE],
        );

        await expect(asService<{ disposition: string }>(
            pool,
            'SELECT public.claim_precheckout_blite_v1($1) AS result',
            [COHORT_V1_PREFLIGHT],
        )).rejects.toThrow('PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY');
        await expect(pool.query(
            `SELECT cache.state,cache.lease_token,
                    (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources
             FROM public.precheckout_blite_cache AS cache WHERE cache.preflight_id=$1`,
            [COHORT_V1_PREFLIGHT],
        )).resolves.toMatchObject({ rows: [{
            state: 'pending', lease_token: COHORT_V1_LEASE, sources: 1,
        }] });
    });
});
