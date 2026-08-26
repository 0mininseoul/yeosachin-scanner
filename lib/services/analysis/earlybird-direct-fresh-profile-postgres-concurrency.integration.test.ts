import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.EARLYBIRD_DIRECT_FRESH_APIFY_POSTGRES_TEST_URL;
const marker = process.env.EARLYBIRD_DIRECT_FRESH_APIFY_POSTGRES_TEST_MARKER;
const expectedMarker = 'local-ephemeral-earlybird-direct-fresh-lock-order-only';
const expectedPort = '55435';
const describePostgres = isSafeTarget(databaseUrl, marker) ? describe : describe.skip;

const pgliteFixture = readFileSync(new URL('./earlybird-direct-fresh-profile-pglite.test.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260826165211_earlybird_direct_fresh_apify_checkpoint.sql',
    import.meta.url,
), 'utf8');
const reconciliationMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql',
    import.meta.url,
), 'utf8');

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PREFLIGHT_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM_TOKEN = '55555555-5555-4555-8555-555555555555';
const TARGET_RUN_ID = 'target-run';
const TARGET_JOB = 'track:target-evidence:collect';
const JOB_HASH = 'a'.repeat(64);
const TARGET_PROVIDER_HASH = 'b'.repeat(64);
const TARGET_OPERATION = `target-profile:${'c'.repeat(64)}`;
const TARGET = 'target.account';
const PLAN_CARDS = {
    basic: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 400, following: 400 },
        detailedMutualLimit: 300,
        selectionState: 'required',
        unavailableReason: null,
    },
    standard: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
    plus: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 1200, following: 1200 },
        detailedMutualLimit: 900,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
};
const SCOPE = {
    relationshipCapacity: { followers: 400, following: 400 },
    detailedMutualLimit: 300,
};

export function isSafeTarget(
    connectionString: string | undefined,
    suppliedMarker: string | undefined,
): boolean {
    if (!connectionString || suppliedMarker !== expectedMarker) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.port === expectedPort
            // node-postgres gives URI query parameters precedence over the authority's
            // host/port (and libpq accepts hostaddr), so no query string is safe here.
            && url.search === ''
            && url.pathname === '/earlybird_direct_fresh_lock_order_test';
    } catch {
        return false;
    }
}

function fixtureBootstrap(): string {
    const match = pgliteFixture.match(/const bootstrap = `([\s\S]*?)`;/);
    if (!match?.[1]) throw new Error('EARLYBIRD_DIRECT_FRESH_PG_BOOTSTRAP_MISSING');
    return match[1]
        .replace('CREATE ROLE anon NOLOGIN;', () => 'DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;')
        .replace('CREATE ROLE authenticated NOLOGIN;', () => 'DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;')
        .replace('CREATE ROLE service_role NOLOGIN;', () => 'DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;');
}

function functionSql(source: string, markerText: string): string {
    const start = source.indexOf(markerText);
    if (start < 0) throw new Error(`EARLYBIRD_DIRECT_FRESH_PG_FUNCTION_MISSING:${markerText}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`EARLYBIRD_DIRECT_FRESH_PG_FUNCTION_UNTERMINATED:${markerText}`);
    return source.slice(start, end + 4);
}

function reconciliationSql(): string {
    return functionSql(
        reconciliationMigration,
        'CREATE FUNCTION public.reconcile_earlybird_fulfillments(',
    );
}

async function waitForLockWait(
    observer: PoolClient,
    blockedPid: number,
    blockerPid: number,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await observer.query<{
            wait_event_type: string | null;
            blocking_pids: number[];
        }>(
            `SELECT wait_event_type,
                    pg_catalog.pg_blocking_pids(pid) AS blocking_pids
             FROM pg_catalog.pg_stat_activity
             WHERE pid = $1`,
            [blockedPid],
        );
        const row = result.rows[0];
        if (row?.wait_event_type === 'Lock' && row.blocking_pids.includes(blockerPid)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('EARLYBIRD_DIRECT_FRESH_PG_LOCK_BARRIER_TIMEOUT');
}

async function rollback(client: PoolClient): Promise<void> {
    await client.query('ROLLBACK').catch(() => undefined);
}

async function settled<T>(promise: Promise<T>): Promise<{ value: T | null; error: unknown }> {
    return promise.then(
        value => ({ value, error: null }),
        error => ({ value: null, error }),
    );
}

describe('Earlybird direct fresh-Apify PostgreSQL lock order target guard', () => {
    it('accepts only the named loopback disposable target and marker', () => {
        expect(isSafeTarget(
            'postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test',
            expectedMarker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/earlybird_direct_fresh_lock_order_test', expectedMarker],
        ['postgresql://tester@127.0.0.1:55434/earlybird_direct_fresh_lock_order_test', expectedMarker],
        ['postgresql://tester@127.0.0.1/earlybird_direct_fresh_lock_order_test', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/postgres', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test', undefined],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test?host=db.example.com', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test?hostaddr=203.0.113.9', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test?port=55434', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test?%68%6f%73%74=db.example.com', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test?%68%6f%73%74%61%64%64%72=203.0.113.9', expectedMarker],
        ['postgresql://tester@127.0.0.1:55435/earlybird_direct_fresh_lock_order_test?%70%6f%72%74=55434', expectedMarker],
        ['postgresql://tester@127.0.0.1:55434/earlybird_direct_fresh_lock_order_test?port=55435', expectedMarker],
    ])('rejects an unsafe target or absent marker', (url, supplied) => {
        expect(isSafeTarget(url, supplied)).toBe(false);
    });
});

describePostgres('Earlybird direct fresh-Apify PostgreSQL lock order', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 5 });
        const identity = await pool.query<{ database_name: string }>(
            'SELECT pg_catalog.current_database() AS database_name',
        );
        if (identity.rows[0]?.database_name !== 'earlybird_direct_fresh_lock_order_test') {
            throw new Error('Refusing destructive PostgreSQL test against an unexpected database.');
        }
        await pool.query(`
            DROP SCHEMA IF EXISTS public CASCADE;
            DROP SCHEMA IF EXISTS extensions CASCADE;
            CREATE SCHEMA public;
        `);
        await pool.query(fixtureBootstrap());
        await pool.query(`
            ALTER TABLE public.earlybird_fulfillments
                ADD COLUMN attempt_count SMALLINT NOT NULL DEFAULT 0,
                ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
                ADD COLUMN operator_admitted_at TIMESTAMPTZ,
                ADD COLUMN last_error_code VARCHAR(64),
                ADD COLUMN last_error_at TIMESTAMPTZ,
                ADD COLUMN completed_at TIMESTAMPTZ,
                ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp();
            ALTER TABLE public.earlybird_orders
                ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp();
        `);
        await pool.query(migration);
        await pool.query(reconciliationSql());
        await pool.query(`
            INSERT INTO public.analysis_requests(
                id,user_id,status,pipeline_version,target_instagram_id,preflight_id,
                capacity_required_plan_id_snapshot,required_plan_id_snapshot,
                excluded_instagram_id,exclusion_decision_snapshot,selected_plan_id_snapshot,
                plan_access_mode_snapshot,analysis_entry_channel,test_entitlement_jti_hash,
                plan_cards_snapshot,analysis_scope_snapshot
            ) VALUES ($1,$2,'processing','v2',$3,$4,'basic','basic',NULL,'none','basic',
                'production','standard',NULL,$5::jsonb,$6::jsonb)
        `, [REQUEST_ID, USER_ID, TARGET, PREFLIGHT_ID, JSON.stringify(PLAN_CARDS), JSON.stringify(SCOPE)]);
        await pool.query(`
            INSERT INTO public.analysis_preflights(
                id,user_id,status,consumed_request_id,target_instagram_id,target_followers_count,
                target_following_count,admission_target_followers_count,admission_target_following_count,
                excluded_instagram_id,exclusion_decision,required_plan_id,capacity_required_plan_id,
                admission_selected_plan_id,admission_required_plan_id,admission_capacity_required_plan_id,
                access_mode,analysis_entry_channel,order_scoped_apify_credential_slot,plan_cards_snapshot
            ) VALUES ($1,$2,'consumed',$3,$4,10,10,10,10,NULL,'none','basic','basic',
                'basic','basic','basic','production','standard','secondary',$5::jsonb)
        `, [PREFLIGHT_ID, USER_ID, REQUEST_ID, TARGET, JSON.stringify(PLAN_CARDS)]);
        await pool.query(`
            INSERT INTO public.earlybird_orders(
                id,user_id,preflight_id,target_instagram_id,target_followers_count,target_following_count,
                exclusion_decision,excluded_instagram_id,plan_id,expected_groble_product_id,
                expected_amount_krw,status,payment_id,actual_groble_product_id,actual_amount_krw,
                paid_at,seller_reference_confirmed_at,result_request_id,concierge_apify_credential_slot
            ) VALUES ($1,$2,$3,$4,10,10,'none',NULL,'basic','groble-basic',1000,
                'analysis_in_progress','payment','groble-basic',1000,clock_timestamp(),
                clock_timestamp(),$5,'secondary')
        `, [ORDER_ID, USER_ID, PREFLIGHT_ID, TARGET, REQUEST_ID]);
        await pool.query(`
            INSERT INTO public.earlybird_fulfillments(
                order_id,request_id,status,operator_admitted_at,manual_review_at
            ) VALUES ($1,$2,'analysis_in_progress',clock_timestamp(),NULL)
        `, [ORDER_ID, REQUEST_ID]);
        await pool.query(`
            INSERT INTO public.analysis_pipeline_jobs(
                request_id,job_key,track,kind,batch,input_hash,status,lease_token,lease_expires_at
            ) VALUES ($1,$2,'target_evidence','collection',NULL,$3,'processing',$4,
                clock_timestamp() + interval '10 minutes')
        `, [REQUEST_ID, TARGET_JOB, JOB_HASH, CLAIM_TOKEN]);
        await pool.query(`
            INSERT INTO public.analysis_v2_provider_runs(
                request_id,job_key,operation_key,input_hash,job_claim_token,logical_provider,
                actor_id,credential_slot,status,run_id,run_started_at,terminalized_at
            ) VALUES ($1,$2,$3,$4,$5,'apify','apify/instagram-profile-scraper','secondary',
                'succeeded',$6,clock_timestamp(),clock_timestamp())
        `, [REQUEST_ID, TARGET_JOB, TARGET_OPERATION, TARGET_PROVIDER_HASH, CLAIM_TOKEN, TARGET_RUN_ID]);
        await pool.query(`
            GRANT USAGE ON SCHEMA public TO service_role;
            GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
            GRANT EXECUTE ON FUNCTION public.reconcile_earlybird_fulfillments(INTEGER)
                TO service_role;
        `);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('does not deadlock when reconciliation holds fulfillment before the checkpoint locks its lineage', async () => {
        const reconciler = await pool.connect();
        const checkpoint = await pool.connect();
        const observer = await pool.connect();
        try {
            await reconciler.query("SET application_name = 'earlybird-direct-fresh-reconciler'");
            await checkpoint.query("SET application_name = 'earlybird-direct-fresh-checkpoint'");
            await reconciler.query('BEGIN');
            await reconciler.query("SET LOCAL deadlock_timeout = '100ms'");
            await reconciler.query("SET LOCAL statement_timeout = '5s'");
            await reconciler.query("SET LOCAL ROLE service_role");
            await reconciler.query(
                'SELECT order_id FROM public.earlybird_fulfillments WHERE order_id = $1 FOR UPDATE',
                [ORDER_ID],
            );

            await checkpoint.query('BEGIN');
            await checkpoint.query("SET LOCAL deadlock_timeout = '100ms'");
            await checkpoint.query("SET LOCAL statement_timeout = '5s'");
            await checkpoint.query("SET LOCAL ROLE service_role");
            const checkpointPid = (await checkpoint.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const reconcilerPid = (await reconciler.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const pendingCheckpoint = settled(checkpoint.query(
                `SELECT public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(
                    $1::uuid,$2::text,$3::uuid,$4::text,$5::text[],$6::jsonb,$7::text,$8::text
                ) AS result`,
                [
                    REQUEST_ID,
                    TARGET_JOB,
                    CLAIM_TOKEN,
                    JOB_HASH,
                    [TARGET],
                    JSON.stringify([{
                        username: TARGET,
                        source: 'apify',
                        status: 'success',
                        failure_category: null,
                        http_status: null,
                        request_count: 1,
                        latency_ms: 1,
                        captured_at: '2026-08-27T00:00:00.000Z',
                        profile: { username: TARGET },
                    }]),
                    TARGET_OPERATION,
                    TARGET_PROVIDER_HASH,
                ],
            ));
            await waitForLockWait(observer, checkpointPid, reconcilerPid);

            const reconciliationResult = await settled(reconciler.query(
                'SELECT * FROM public.reconcile_earlybird_fulfillments(1)',
            ));
            await reconciler.query('COMMIT').catch(() => rollback(reconciler));
            const checkpointResult = await pendingCheckpoint;
            await checkpoint.query('COMMIT').catch(() => rollback(checkpoint));

            expect(reconciliationResult.error).toBeNull();
            expect(checkpointResult.error).toBeNull();
        } finally {
            await rollback(reconciler);
            await rollback(checkpoint);
            reconciler.release();
            checkpoint.release();
            observer.release();
        }
    }, 20_000);
});
