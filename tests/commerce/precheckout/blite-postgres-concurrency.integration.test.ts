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
const deadlineMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260814150000_precheckout_blite_deadline_90.sql',
    import.meta.url,
), 'utf8');
const expiryScanMigrationName = readdirSync(new URL('../../../supabase/migrations/', import.meta.url))
    .find(name => name.endsWith('_optimize_precheckout_blite_expiry_scan.sql'));
if (!expiryScanMigrationName) throw new Error('PRECHECKOUT_BLITE_EXPIRY_SCAN_MIGRATION_MISSING');
const expiryScanMigration = readFileSync(new URL(
    `../../../supabase/migrations/${expiryScanMigrationName}`,
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
const PREFLIGHT_PURGE_LOCKED = '20000000-0000-4000-8000-000000000205';
const PREFLIGHT_PURGE_AVAILABLE = '20000000-0000-4000-8000-000000000206';
const USER = '10000000-0000-4000-8000-000000000201';
const CLAIM = '40000000-0000-4000-8000-000000000201';
const HASH = 'a'.repeat(64);
const PAYLOAD_HASH = 'b5d739c839673d7d4271a3d034eba73f3bbd465c76d58f1e632079d0b52f578c';
const PROVIDER_REFERENCE = 'ApifyRun123456';
const PROVIDER_OPERATION_KEY = 'target-profile-fallback';
const SOURCE = JSON.stringify({ schemaVersion: 1, fullName: null, posts: [], media: [] });
const VALID_DTO = JSON.stringify({
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
    evidenceFields: ['post.caption'],
});

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
    applicationName?: string,
): Promise<T> {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        if (applicationName) {
            await client.query(
                "SELECT pg_catalog.set_config('application_name', $1, TRUE)",
                [applicationName],
            );
        }
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

async function seedReadySource(pool: Pool, preflightId: string): Promise<void> {
    await pool.query(
        `INSERT INTO public.analysis_preflights(
            id,user_id,status,expires_at,target_input_hash,lease_token,lease_expires_at,
            created_at,precheckout_blite_cohort
        ) VALUES (
            $1,$2,'processing',clock_timestamp() + interval '20 minutes',$3,$4,
            clock_timestamp() + interval '5 minutes',clock_timestamp() - interval '5 seconds',true
        )`,
        [preflightId, USER, HASH, CLAIM],
    );
    await pool.query(
        `INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,status,run_id
        ) VALUES ($1,$2,$3,'apify','succeeded',$4)`,
        [preflightId, PROVIDER_OPERATION_KEY, HASH, PROVIDER_REFERENCE],
    );
    const finalized = await pool.query<{ result: boolean }>(
        `SELECT public.finalize_preflight_blite_source_v1(
            $1,$2,$3,$4,$1,$5,$6,
            'Target',NULL,'https://cdninstagram.com/profile.jpg',1,1,false,
            'basic','basic','{}'::jsonb,$7::jsonb,$8,
            clock_timestamp() - interval '1 second',
            (SELECT expires_at FROM public.analysis_preflights WHERE id=$1)
        ) AS result`,
        [preflightId, USER, CLAIM, HASH, PROVIDER_OPERATION_KEY, PROVIDER_REFERENCE, SOURCE, PAYLOAD_HASH],
    );
    if (finalized.rows[0]?.result !== true) {
        throw new Error('PRECHECKOUT_BLITE_POSTGRES_SEED_FAILED');
    }
}

type PurgeFunctionMetadata = {
    oid: string;
    owner: string;
    acl: string | null;
    security_definer: boolean;
    config: string | null;
};

type ExplainNode = {
    'Node Type': string;
    'Relation Name'?: string;
    Plans?: ExplainNode[];
};

function flattenPlan(node: ExplainNode): ExplainNode[] {
    return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

async function readPurgeFunctionMetadata(pool: Pool): Promise<PurgeFunctionMetadata> {
    const result = await pool.query<PurgeFunctionMetadata>(
        `SELECT
            procedure.oid::text AS oid,
            pg_catalog.pg_get_userbyid(procedure.proowner) AS owner,
            procedure.proacl::text AS acl,
            procedure.prosecdef AS security_definer,
            procedure.proconfig[1] AS config
         FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid =
            'public.purge_expired_precheckout_blite_sources_v1(integer)'::regprocedure`,
    );
    if (!result.rows[0]) throw new Error('PRECHECKOUT_BLITE_PURGE_FUNCTION_METADATA_MISSING');
    return result.rows[0];
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
    let functionMetadataBeforeOptimizer: PurgeFunctionMetadata;
    let functionMetadataAfterOptimizer: PurgeFunctionMetadata;

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
        await pool.query(deadlineMigration);
        functionMetadataBeforeOptimizer = await readPurgeFunctionMetadata(pool);
        await pool.query(expiryScanMigration);
        functionMetadataAfterOptimizer = await readPurgeFunctionMetadata(pool);
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
            CREATE FUNCTION public.test_hold_precheckout_blite_source_cleanup()
            RETURNS TRIGGER
            LANGUAGE plpgsql
            AS $$
            BEGIN
                PERFORM pg_catalog.set_config(
                    'application_name', 'precheckout-blite-source-cleanup-holding-lock', FALSE
                );
                PERFORM pg_catalog.pg_sleep(0.35);
                RETURN OLD;
            END;
            $$;
            CREATE TRIGGER test_hold_precheckout_blite_source_cleanup
            BEFORE DELETE ON public.precheckout_blite_sources
            FOR EACH ROW
            EXECUTE FUNCTION public.test_hold_precheckout_blite_source_cleanup();
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
                preflight_id,operation_key,input_hash,logical_provider,status,run_id
            ) VALUES ($1,$2,$3,'apify','succeeded',$4)`,
            [PREFLIGHT, PROVIDER_OPERATION_KEY, HASH, PROVIDER_REFERENCE],
        );
        await pool.query(
            `SELECT public.finalize_preflight_blite_source_v1(
                $1,$2,$3,$4,$1,$5,$6,
                'Target',NULL,'https://cdninstagram.com/profile.jpg',1,1,false,
                'basic','basic','{}'::jsonb,$7::jsonb,$8,
                clock_timestamp() - interval '1 second',
                (SELECT expires_at FROM public.analysis_preflights WHERE id=$1)
            )`,
            [
                PREFLIGHT, USER, CLAIM, HASH, PROVIDER_OPERATION_KEY, PROVIDER_REFERENCE,
                SOURCE, PAYLOAD_HASH,
            ],
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

    it('keeps purge-vs-claim cleanup race-free on real PostgreSQL', async () => {
        const preflightId = '20000000-0000-4000-8000-000000000202';
        await seedReadySource(pool, preflightId);
        await pool.query(
            `UPDATE public.precheckout_blite_sources
             SET collected_at=clock_timestamp() - interval '2 minutes',
                 expires_at=clock_timestamp() - interval '1 minute'
             WHERE preflight_id=$1`,
            [preflightId],
        );
        const sourceHolder = await pool.connect();
        const cleanup = await pool.connect();
        const claimant = await pool.connect();
        try {
            await sourceHolder.query('BEGIN');
            await sourceHolder.query(
                'SELECT 1 FROM public.precheckout_blite_sources WHERE preflight_id=$1 FOR UPDATE',
                [preflightId],
            );
            const purge = asService<number>(
                cleanup,
                'SELECT public.purge_expired_precheckout_blite_sources_v1(1) AS result',
                [],
                'precheckout-blite-purge-waiting-source',
            );
            await waitForApplicationName(pool, 'precheckout-blite-purge-waiting-source');
            const claim = asService<{ disposition: string; reason?: string }>(
                claimant,
                'SELECT public.claim_precheckout_blite_v2($1) AS result',
                [preflightId],
            );
            await sourceHolder.query('COMMIT');
            await expect(purge).resolves.toBe(1);
            await expect(claim).resolves.toMatchObject({
                disposition: 'failed', reason: 'source_missing',
            });
        } finally {
            await sourceHolder.query('ROLLBACK').catch(() => undefined);
            sourceHolder.release();
            cleanup.release();
            claimant.release();
        }
    }, 30_000);

    it('loads the source-driven selector into the real PostgreSQL function', async () => {
        const result = await pool.query<{ prosrc: string }>(
            `SELECT procedure.prosrc
             FROM pg_catalog.pg_proc AS procedure
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = procedure.pronamespace
             WHERE namespace.nspname = 'public'
               AND procedure.proname = 'purge_expired_precheckout_blite_sources_v1'`,
        );

        expect(result.rows[0]!.prosrc).toMatch(
            /FROM public\.precheckout_blite_sources AS expired_source\s+JOIN public\.analysis_preflights AS preflight/,
        );
    });

    it('preserves function identity, owner, grants, security definer, and empty search path', () => {
        expect(functionMetadataAfterOptimizer.oid).toBe(functionMetadataBeforeOptimizer.oid);
        expect(functionMetadataAfterOptimizer.owner).toBe(functionMetadataBeforeOptimizer.owner);
        expect(functionMetadataAfterOptimizer.acl).toBe(functionMetadataBeforeOptimizer.acl);
        expect(functionMetadataAfterOptimizer.security_definer).toBe(true);
        expect(functionMetadataAfterOptimizer.config).toContain('search_path=""');
    });

    it('plans one source-relation scan beneath a parent row-lock node', async () => {
        const result = await pool.query<{ 'QUERY PLAN': Array<{ Plan: ExplainNode }> }>(
            `EXPLAIN (FORMAT JSON)
             SELECT preflight.id
             FROM public.precheckout_blite_sources AS expired_source
             JOIN public.analysis_preflights AS preflight
               ON preflight.id = expired_source.preflight_id
             WHERE expired_source.expires_at <= pg_catalog.clock_timestamp()
             ORDER BY preflight.id
             LIMIT 100
             FOR UPDATE OF preflight SKIP LOCKED`,
        );
        const nodes = flattenPlan(result.rows[0]!['QUERY PLAN'][0]!.Plan);

        expect(nodes.filter(node => (
            node['Relation Name'] === 'precheckout_blite_sources'
        ))).toHaveLength(1);
        expect(nodes.some(node => node['Node Type'] === 'LockRows')).toBe(true);
    });

    it('skips a locked first parent and purges the next expired parent without waiting', async () => {
        await seedReadySource(pool, PREFLIGHT_PURGE_LOCKED);
        await seedReadySource(pool, PREFLIGHT_PURGE_AVAILABLE);
        await pool.query(
            `UPDATE public.precheckout_blite_sources
             SET collected_at=clock_timestamp() - interval '2 minutes',
                 expires_at=clock_timestamp() - interval '1 minute'
             WHERE preflight_id = ANY($1::uuid[])`,
            [[PREFLIGHT_PURGE_LOCKED, PREFLIGHT_PURGE_AVAILABLE]],
        );

        const parentHolder = await pool.connect();
        const cleanup = await pool.connect();
        try {
            await parentHolder.query('BEGIN');
            await parentHolder.query(
                'SELECT 1 FROM public.analysis_preflights WHERE id=$1 FOR UPDATE',
                [PREFLIGHT_PURGE_LOCKED],
            );

            const purge = asService<number>(
                cleanup,
                'SELECT public.purge_expired_precheckout_blite_sources_v1(1) AS result',
            );
            const startedAt = Date.now();
            const result = await purge;
            expect(result).toBe(1);
            expect(Date.now() - startedAt).toBeLessThan(1_500);

            await expect(pool.query(
                `SELECT
                    (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS locked_sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$1) AS locked_caches,
                    (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$2) AS available_sources,
                    (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$2) AS available_caches`,
                [PREFLIGHT_PURGE_LOCKED, PREFLIGHT_PURGE_AVAILABLE],
            )).resolves.toMatchObject({
                rows: [{
                    locked_sources: 1,
                    locked_caches: 1,
                    available_sources: 0,
                    available_caches: 0,
                }],
            });
        } finally {
            await parentHolder.query('ROLLBACK').catch(() => undefined);
            parentHolder.release();
            cleanup.release();
        }
    }, 30_000);

    it.each([
        ['complete', '20000000-0000-4000-8000-000000000203'],
        ['fail', '20000000-0000-4000-8000-000000000204'],
    ] as const)('keeps PII scrub race-free against v2 %s', async (terminalKind, preflightId) => {
        await seedReadySource(pool, preflightId);
        const ownerClient = await pool.connect();
        let owner: { disposition: string; leaseToken: string };
        try {
            owner = await asService<{ disposition: string; leaseToken: string }>(
                ownerClient,
                'SELECT public.claim_precheckout_blite_v2($1) AS result',
                [preflightId],
            );
        } finally {
            ownerClient.release();
        }
        expect(owner).toMatchObject({ disposition: 'claimed' });

        const scrubber = await pool.connect();
        const terminal = await pool.connect();
        try {
            const piiScrub = scrubber.query(
                'UPDATE public.analysis_preflights SET pii_scrubbed_at=clock_timestamp() WHERE id=$1',
                [preflightId],
            );
            await waitForApplicationName(pool, 'precheckout-blite-source-cleanup-holding-lock');
            const result = terminalKind === 'complete'
                ? asService<boolean>(
                    terminal,
                    'SELECT public.complete_precheckout_blite_v2($1,$2,$3::jsonb) AS result',
                    [preflightId, owner.leaseToken, VALID_DTO],
                )
                : asService<boolean>(
                    terminal,
                    'SELECT public.fail_precheckout_blite_v2($1,$2,$3) AS result',
                    [preflightId, owner.leaseToken, 'inference_provider_failed'],
                );
            await expect(piiScrub).resolves.toBeDefined();
            await expect(result).resolves.toBe(false);
            await expect(pool.query(
                `SELECT (SELECT count(*)::int FROM public.precheckout_blite_sources WHERE preflight_id=$1) AS sources,
                        (SELECT count(*)::int FROM public.precheckout_blite_cache WHERE preflight_id=$1) AS caches`,
                [preflightId],
            )).resolves.toMatchObject({ rows: [{ sources: 0, caches: 0 }] });
        } finally {
            scrubber.release();
            terminal.release();
        }
    }, 30_000);
});
