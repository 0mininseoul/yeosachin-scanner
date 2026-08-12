import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    revenueSettlementEffectiveDefinitionEvidence,
    revenueSettlementProductionFixtureSql,
    revenueSettlementProductionFixtureSqlForMigrationWindow,
    revenueSettlementReadinessMigrationSql,
} from './revenue-settlement-effective-production-fixture';

const databaseUrl = process.env.REVENUE_SETTLEMENT_POSTGRES_TEST_URL;
const suppliedMarker = process.env.REVENUE_SETTLEMENT_POSTGRES_TEST_MARKER;
const marker = 'local-ephemeral-revenue-settlement-lock-order-only';
const describePostgres = isSafeRevenueSettlementPostgresTestTarget(
    databaseUrl,
    suppliedMarker,
) ? describe : describe.skip;

const preflightId = '33333333-3333-4333-8333-333333333333';
const userId = '22222222-2222-4222-8222-222222222222';
const oauthUserId = '11111111-1111-4111-8111-111111111111';
const ownerExclusionPreflightId = '55555555-5555-4555-8555-555555555555';
const admissionToken = '44444444-4444-4444-8444-444444444444';
const entitlementHash = 'a'.repeat(64);
const inputHash = 'b'.repeat(64);
const anonymousClaimHash = 'c'.repeat(64);
const replayClaimHash = 'd'.repeat(64);
const operationSlots = {
    'target-profile': 'primary',
    'relationship-followers': 'secondary',
    'relationship-following': 'tertiary',
    'profile-fallback': 'primary',
    'target-likers': 'secondary',
    'target-comments': 'primary',
    'candidate-likers': 'tertiary',
};

export function isSafeRevenueSettlementPostgresTestTarget(
    connectionString: string | undefined,
    supplied: string | undefined,
): boolean {
    if (!connectionString || supplied !== marker) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/revenue_settlement_lock_order_test';
    } catch {
        return false;
    }
}

async function serviceCall<T extends QueryResultRow>(
    client: PoolClient,
    sql: string,
    values: unknown[],
): Promise<T[]> {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '6s'");
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query<T>(sql, values);
        await client.query('COMMIT');
        return result.rows;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

async function pooledServiceCall<T extends QueryResultRow>(
    pool: Pool,
    sql: string,
    values: unknown[],
): Promise<T[]> {
    const client = await pool.connect();
    try {
        return await serviceCall<T>(client, sql, values);
    } finally {
        client.release();
    }
}

async function invokerCall<T extends QueryResultRow>(
    pool: Pool,
    role: 'anon' | 'authenticated',
    sql: string,
    values: unknown[] = [],
    authUserId: string | null = null,
): Promise<{ rows: T[]; rowCount: number | null }> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '6s'");
        if (authUserId !== null) {
            await client.query(
                "SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, TRUE)",
                [authUserId],
            );
        }
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await client.query<T>(sql, values);
        await client.query('COMMIT');
        return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

async function waitForApplicationName(pool: Pool, applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const result = await pool.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM pg_catalog.pg_stat_activity
             WHERE application_name = $1 AND state = 'active'`,
            [applicationName],
        );
        if (result.rows[0]?.count === 1) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('REVENUE_SETTLEMENT_LOCK_ORDER_BARRIER_TIMEOUT');
}

async function waitForLockWait(pool: Pool, blockedPid: number, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const result = await pool.query<{
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
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('REVENUE_SETTLEMENT_LOCK_ORDER_WAIT_TIMEOUT');
}

describe('revenue settlement PostgreSQL destructive-test target guard', () => {
    it('accepts only an explicitly marked loopback disposable database', () => {
        expect(isSafeRevenueSettlementPostgresTestTarget(
            'postgresql://tester@127.0.0.1:55432/revenue_settlement_lock_order_test',
            marker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/revenue_settlement_lock_order_test', marker],
        ['postgresql://tester@127.0.0.1:55432/postgres', marker],
        ['postgresql://tester@127.0.0.1:55432/revenue_settlement_lock_order_test', undefined],
    ])('rejects an unsafe target or missing marker', (connectionString, supplied) => {
        expect(isSafeRevenueSettlementPostgresTestTarget(connectionString, supplied)).toBe(false);
    });
});

describePostgres('revenue settlement migration 1 isolated intermediate state', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 3 });
        await pool.query(
            'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS extensions CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;'
        );
        await pool.query(revenueSettlementProductionFixtureSqlForMigrationWindow({
            includeReadinessMigration: false,
            includeTargetLineageHardeningMigration: false,
        }));
        await pool.query(`
            INSERT INTO public.users(
                id,email,account_class,traffic_class,lifecycle,classification_version
            ) VALUES (
                '${userId}','runner@example.test','e2e_test','e2e_test','active','revenue-settlement-test-v1'
            );
            INSERT INTO public.analysis_preflights(
                id,user_id,status,access_mode,target_instagram_id,target_input_hash,pricing_version
            ) VALUES (
                '${preflightId}','${userId}','ready','test_entitlement',
                'target.account','${inputHash}','revenue-settlement-test-v1'
            );
        `);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('migration 1 alone removes the owner target/economic UPDATE policy while retaining anonymous creation', async () => {
        const policyBeforeMigration = await pool.query<{ present: boolean }>(`
            SELECT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_policies
                WHERE schemaname = 'public'
                  AND tablename = 'analysis_preflights'
                  AND policyname = 'analysis_preflights_authenticated_owner_update'
            ) AS present
        `);
        expect(policyBeforeMigration.rows).toEqual([{ present: true }]);

        await pool.query(revenueSettlementReadinessMigrationSql);

        const policyAfterMigration = await pool.query<{ present: boolean }>(`
            SELECT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_policies
                WHERE schemaname = 'public'
                  AND tablename = 'analysis_preflights'
                  AND policyname = 'analysis_preflights_authenticated_owner_update'
            ) AS present
        `);
        expect(policyAfterMigration.rows).toEqual([{ present: false }]);

        const directOwnerMutation = await invokerCall(
            pool,
            'authenticated',
            `UPDATE public.analysis_preflights
             SET target_instagram_id = 'forged.target',
                 pricing_version = 'forged-economic'
             WHERE id = $1::UUID`,
            [preflightId],
            userId,
        );
        expect(directOwnerMutation.rowCount).toBe(0);
        await expect(pool.query(`
            SELECT target_instagram_id, pricing_version
            FROM public.analysis_preflights
            WHERE id = '${preflightId}'::UUID
        `)).resolves.toMatchObject({
            rows: [{
                target_instagram_id: 'target.account',
                pricing_version: 'revenue-settlement-test-v1',
            }],
        });

        const created = await invokerCall<{
            preflight_id: string;
            created: boolean;
            preflight_status: string;
        }>(pool, 'anon', `
            SELECT * FROM public.create_anonymous_analysis_v2_preflight(
                $1::TEXT, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR,
                pg_catalog.clock_timestamp() + INTERVAL '10 minutes',
                $5::JSONB, $6::JSONB, $7::VARCHAR, $8::JSONB, $9::JSONB
            )
        `, [
            'anonymous.target',
            inputHash,
            'migration-window-anonymous-capability-001',
            anonymousClaimHash,
            JSON.stringify({ basic: 'test_only', standard: 'test_only', plus: 'production' }),
            JSON.stringify({
                basic: { launchStatus: 'test_only', relationshipCapacity: { followers: 10, following: 10 }, detailedMutualLimit: 1 },
                standard: { launchStatus: 'test_only', relationshipCapacity: { followers: 20, following: 20 }, detailedMutualLimit: 2 },
                plus: { launchStatus: 'production', relationshipCapacity: { followers: 30, following: 30 }, detailedMutualLimit: 3 },
            }),
            'revenue-settlement-test-v1',
            JSON.stringify({
                basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
                standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
                plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
            }),
            JSON.stringify({ fixture: 'revenue-settlement-test-v1' }),
        ]);
        expect(created.rows).toHaveLength(1);
        expect(created.rows[0]).toMatchObject({ created: true, preflight_status: 'pending' });
    }, 20_000);
});

describePostgres('revenue settlement effective PostgreSQL chain', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        await pool.query(
            'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS extensions CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;'
        );
        await pool.query(revenueSettlementProductionFixtureSql);
        await pool.query(`
            INSERT INTO public.users(
                id,email,account_class,traffic_class,lifecycle,classification_version
            ) VALUES (
                '${userId}','runner@example.test','e2e_test','e2e_test','active','revenue-settlement-test-v1'
            );
            INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES (
                '${userId}','runner@example.test','{"analysis_test_runner_v1":"basic"}'::JSONB
            ), (
                '${oauthUserId}','oauth@example.test','{}'::JSONB
            );
            INSERT INTO public.account_ledger_rollout_state(
                singleton,paid_ever_state,classification_command_version
            ) VALUES (TRUE,'active','revenue-settlement-test-v1');
            INSERT INTO public.account_e2e_test_runners(account_id,runner_plan,command_version)
            VALUES ('${userId}','basic','revenue-settlement-test-v1');
            INSERT INTO public.analysis_preflights(
                id,user_id,status,expires_at,access_mode,exclusion_decision,
                target_instagram_id,target_input_hash,capacity_required_plan_id,required_plan_id,
                target_followers_count,target_following_count,
                plan_cards_snapshot,pricing_version,pricing_snapshot,launch_status_snapshot,
                policy_versions_snapshot,admission_generation,admission_status,
                admission_selected_plan_id,admission_entitlement_jti_hash,admission_token,
                admission_refreshed_at,admission_target_followers_count,
                admission_target_following_count,admission_capacity_required_plan_id,
                admission_required_plan_id,admission_plan_cards_snapshot,admission_dispatch_generation
            ) VALUES (
                '${preflightId}','${userId}','ready',clock_timestamp()+INTERVAL '10 minutes',
                'test_entitlement','skip','target.account','${inputHash}','basic','basic',
                1,1,
                '{"basic":{"launchStatus":"test_only","selectionState":"required","unavailableReason":null,"relationshipCapacity":{"followers":10,"following":10},"detailedMutualLimit":1},"standard":{"launchStatus":"test_only","selectionState":"available_upgrade","unavailableReason":null,"relationshipCapacity":{"followers":20,"following":20},"detailedMutualLimit":2},"plus":{"launchStatus":"production","selectionState":"available_upgrade","unavailableReason":null,"relationshipCapacity":{"followers":30,"following":30},"detailedMutualLimit":3}}'::JSONB,
                'revenue-settlement-test-v1',
                '{"basic":{"status":"deferred","currency":"KRW","amountKrw":0},"standard":{"status":"deferred","currency":"KRW","amountKrw":0},"plus":{"status":"deferred","currency":"KRW","amountKrw":0}}'::JSONB,
                '{"basic":"test_only","standard":"test_only","plus":"production"}'::JSONB,
                '{"fixture":"revenue-settlement-test-v1"}'::JSONB,
                1,'ready','basic','${entitlementHash}','${admissionToken}',
                clock_timestamp()-INTERVAL '3 minutes',1,1,'basic','basic',
                '{"basic":{"selectionState":"required"}}'::JSONB,1
            );
            INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id,operation_key,input_hash,status,actual_usage_usd,
                terminalized_at,usage_reconciled_at
            ) VALUES
                ('${preflightId}','target-profile-fallback','${inputHash}','succeeded',0.002,
                 clock_timestamp()-INTERVAL '2 minutes',clock_timestamp()-INTERVAL '1 minute'),
                ('${preflightId}','target-profile-fresh-admission:g1','${inputHash}','succeeded',0.003,
                 clock_timestamp()-INTERVAL '2 minutes',clock_timestamp()-INTERVAL '1 minute');
            CREATE FUNCTION public.revenue_settlement_test_hold_ready_refresh()
            RETURNS TRIGGER LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_catalog.set_config(
                    'application_name','revenue-settlement-holding-preflight',FALSE
                );
                PERFORM pg_catalog.pg_sleep(0.75);
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER revenue_settlement_test_hold_ready_refresh
            BEFORE UPDATE OF admission_refreshed_at ON public.analysis_preflights
            FOR EACH ROW
            WHEN (OLD.admission_refreshed_at IS DISTINCT FROM NEW.admission_refreshed_at)
            EXECUTE FUNCTION public.revenue_settlement_test_hold_ready_refresh();

            INSERT INTO public.analysis_preflights(
                id,user_id,status,expires_at,access_mode,exclusion_decision,
                target_instagram_id,target_input_hash,provider_selector
            ) VALUES (
                '${ownerExclusionPreflightId}','${userId}','ready',
                clock_timestamp()+INTERVAL '10 minutes','production','pending',
                'owner.exclude','${inputHash}','selfhosted_auth'
            );
        `);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('uses exact production consume/policy/readiness/ledger/guard definitions without handwritten replacements', () => {
        expect(revenueSettlementEffectiveDefinitionEvidence.baseConsume).toContain(
            'analysis_v2_consume_entitlement_after_admission_internal',
        );
        expect(revenueSettlementEffectiveDefinitionEvidence.policy).toContain(
            'bind_analysis_v2_authorized_test_provider_policy',
        );
        expect(revenueSettlementEffectiveDefinitionEvidence.readiness).toContain(
            'analysis_preflight_provider_runs',
        );
        expect(revenueSettlementEffectiveDefinitionEvidence.hotfixAuthorizedConsume).toContain(
            'prepare_analysis_v2_authorized_revenue_settlement_admission',
        );
        expect(revenueSettlementEffectiveDefinitionEvidence.ledger).toContain(
            'begin_analysis_revenue_cost_ledger_v1',
        );
        expect(revenueSettlementEffectiveDefinitionEvidence.guard).toContain(
            'activate_analysis_revenue_dispatch_guard_v1',
        );
        expect(revenueSettlementEffectiveDefinitionEvidence.targetLineageHardening).toContain(
            'DROP POLICY IF EXISTS analysis_preflights_authenticated_owner_update',
        );
    });

    it('reproduces the pre-hardening owner-policy target rewrite only inside a rolled-back RED transaction', async () => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
                CREATE POLICY analysis_preflights_authenticated_owner_update
                    ON public.analysis_preflights
                    FOR UPDATE TO authenticated
                    USING ((SELECT auth.uid()) = user_id)
                    WITH CHECK ((SELECT auth.uid()) = user_id)
            `);
            await client.query(
                "SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, TRUE)",
                [userId],
            );
            await client.query('SET LOCAL ROLE authenticated');
            const rewritten = await client.query(
                `UPDATE public.analysis_preflights
                 SET target_instagram_id = 'rewritten.target',
                     target_input_hash = $1,
                     pricing_version = 'rewritten',
                     admission_status = 'blocked'
                 WHERE id = $2::UUID`,
                [anonymousClaimHash, preflightId],
            );
            expect(rewritten.rowCount).toBe(1);
        } finally {
            await client.query('ROLLBACK').catch(() => undefined);
            client.release();
        }
    });

    it('serializes actual wrapper and base callers in JTI → user → preflight order and durably creates the full chain exactly once', async () => {
        const first = await pool.connect();
        const second = await pool.connect();
        let wrapper: Promise<{ request_id: string; created: boolean }[]> | undefined;
        let base: Promise<{ request_id: string; created: boolean }[]> | undefined;
        try {
            await first.query("SET application_name = 'revenue-settlement-wrapper'");
            await second.query("SET application_name = 'revenue-settlement-base'");
            const firstPid = (await first.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const secondPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;

            wrapper = serviceCall<{ request_id: string; created: boolean }>(first, `
                SELECT * FROM public.consume_analysis_v2_authorized_test_entitlement(
                    $1::UUID,$2::UUID,'basic',$3::TEXT,$4::UUID,
                    'target.account','authorized-free-e2e-v1',$5::JSONB
                )
            `, [preflightId, userId, entitlementHash, admissionToken, JSON.stringify(operationSlots)]);
            await waitForApplicationName(pool, 'revenue-settlement-holding-preflight');

            base = serviceCall<{ request_id: string; created: boolean }>(second, `
                SELECT * FROM public.consume_analysis_v2_test_entitlement(
                    $1::UUID,$2::UUID,'basic',$3::TEXT,$4::UUID
                )
            `, [preflightId, userId, entitlementHash, admissionToken]);
            await waitForLockWait(pool, secondPid, firstPid);

            const [wrapped, replayed] = await Promise.all([wrapper, base]);
            expect(wrapped).toHaveLength(1);
            expect(replayed).toHaveLength(1);
            expect(wrapped[0]?.created).toBe(true);
            expect(replayed[0]?.created).toBe(false);
            expect(replayed[0]?.request_id).toBe(wrapped[0]?.request_id);
            const requestId = wrapped[0]!.request_id;

            const beginSql = 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::UUID) AS result';
            const begun = await Promise.all([
                pooledServiceCall<{ result: { created: boolean } }>(pool, beginSql, [requestId]),
                pooledServiceCall<{ result: { created: boolean } }>(pool, beginSql, [requestId]),
            ]);
            expect(begun.map(result => result[0]?.result.created).sort()).toEqual([false, true]);

            const guardSql = `
                SELECT public.activate_analysis_revenue_dispatch_guard_v1(
                    $1::UUID,'coordinator:bootstrap'
                ) AS result
            `;
            const guarded = await Promise.all([
                pooledServiceCall<{ result: { created: boolean } }>(pool, guardSql, [requestId]),
                pooledServiceCall<{ result: { created: boolean } }>(pool, guardSql, [requestId]),
            ]);
            expect(guarded.map(result => result[0]?.result.created).sort()).toEqual([false, true]);

            await expect(pool.query(`
                SELECT
                    (SELECT count(*)::INTEGER FROM public.analysis_requests) AS request_count,
                    (SELECT count(*)::INTEGER FROM public.analysis_v2_test_entitlement_consumptions) AS consumption_count,
                    (SELECT count(*)::INTEGER FROM public.analysis_v2_provider_execution_policies) AS policy_count,
                    (SELECT count(*)::INTEGER FROM public.analysis_revenue_run_ledgers) AS ledger_parent_count,
                    (SELECT count(*)::INTEGER FROM public.analysis_revenue_cost_operations) AS ledger_child_count,
                    (SELECT count(*)::INTEGER FROM public.analysis_revenue_dispatch_guards
                     WHERE state = 'active') AS active_guard_count
            `)).resolves.toMatchObject({
                rows: [{
                    request_count: 1,
                    consumption_count: 1,
                    policy_count: 1,
                    ledger_parent_count: 1,
                    ledger_child_count: 2,
                    active_guard_count: 1,
                }],
            });
        } finally {
            await wrapper?.catch(() => undefined);
            await base?.catch(() => undefined);
            first.release();
            second.release();
        }
    }, 20_000);

    it('keeps actual exposed hotfix RPC signatures service-role-only', async () => {
        await expect(pool.query(`
            SELECT
                has_function_privilege('anon',
                    'public.prepare_analysis_v2_authorized_revenue_settlement_admission(uuid,uuid,text,text)',
                    'EXECUTE') AS prepare_anon,
                has_function_privilege('authenticated',
                    'public.prepare_analysis_v2_authorized_revenue_settlement_admission(uuid,uuid,text,text,text)',
                    'EXECUTE') AS prepare_with_server_hash_authenticated,
                has_function_privilege('service_role',
                    'public.prepare_analysis_v2_authorized_revenue_settlement_admission(uuid,uuid,text,text,text)',
                    'EXECUTE') AS prepare_with_server_hash_service,
                has_function_privilege('authenticated',
                    'public.consume_analysis_v2_authorized_test_entitlement(uuid,uuid,text,text,uuid,text,text,jsonb)',
                    'EXECUTE') AS consume_authenticated,
                has_function_privilege('service_role',
                    'public.consume_analysis_v2_authorized_test_entitlement(uuid,uuid,text,text,uuid,text,text,jsonb)',
                    'EXECUTE') AS consume_service
        `)).resolves.toMatchObject({
            rows: [{
                prepare_anon: false,
                prepare_with_server_hash_authenticated: false,
                prepare_with_server_hash_service: true,
                consume_authenticated: false,
                consume_service: true,
            }],
        });
    });

    it('keeps owner mutation closed while preserving invoker anonymous capabilities and the hardened owner exclusion RPC', async () => {
        const directOwnerMutation = await invokerCall(
            pool,
            'authenticated',
            `UPDATE public.analysis_preflights
             SET target_instagram_id = 'rewritten.target',
                 target_input_hash = $1,
                 pricing_version = 'rewritten',
                 admission_status = 'blocked',
                 status = 'blocked'
             WHERE id = $2::UUID`,
            [anonymousClaimHash, preflightId],
            userId,
        );
        expect(directOwnerMutation.rowCount).toBe(0);

        const ownerExclusion = await invokerCall<{ excluded: boolean }>(
            pool,
            'authenticated',
            `SELECT public.set_authenticated_analysis_v2_preflight_exclusion(
                $1::UUID, $2::UUID, 'exclude', 'other.owner'
            ) AS excluded`,
            [ownerExclusionPreflightId, userId],
            userId,
        );
        expect(ownerExclusion.rows).toEqual([{ excluded: true }]);

        const createArgs = [
            'anonymous.target',
            inputHash,
            'anonymous-capability-replay-001',
            anonymousClaimHash,
            JSON.stringify({ basic: 'test_only', standard: 'test_only', plus: 'production' }),
            JSON.stringify({
                basic: { launchStatus: 'test_only', relationshipCapacity: { followers: 10, following: 10 }, detailedMutualLimit: 1 },
                standard: { launchStatus: 'test_only', relationshipCapacity: { followers: 20, following: 20 }, detailedMutualLimit: 2 },
                plus: { launchStatus: 'production', relationshipCapacity: { followers: 30, following: 30 }, detailedMutualLimit: 3 },
            }),
            'revenue-settlement-test-v1',
            JSON.stringify({
                basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
                standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
                plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
            }),
            JSON.stringify({ fixture: 'revenue-settlement-test-v1' }),
        ];
        const createSql = `
            SELECT * FROM public.create_anonymous_analysis_v2_preflight(
                $1::TEXT, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR,
                pg_catalog.clock_timestamp() + INTERVAL '10 minutes',
                $5::JSONB, $6::JSONB, $7::VARCHAR, $8::JSONB, $9::JSONB
            )
        `;
        const created = await invokerCall<{
            preflight_id: string;
            created: boolean;
            preflight_status: string;
        }>(pool, 'anon', createSql, createArgs);
        expect(created.rows).toHaveLength(1);
        expect(created.rows[0]).toMatchObject({ created: true, preflight_status: 'pending' });
        const anonymousPreflightId = created.rows[0]!.preflight_id;

        const separateSessionDirectMutation = await invokerCall(
            pool,
            'anon',
            `UPDATE public.analysis_preflights
             SET target_instagram_id = 'forged.target'
             WHERE id = $1::UUID`,
            [anonymousPreflightId],
        );
        expect(separateSessionDirectMutation.rowCount).toBe(0);

        const replayed = await invokerCall<{
            preflight_id: string;
            created: boolean;
            preflight_status: string;
        }>(pool, 'anon', createSql, [
            ...createArgs.slice(0, 3),
            replayClaimHash,
            ...createArgs.slice(4),
        ]);
        expect(replayed.rows).toHaveLength(1);
        expect(replayed.rows[0]).toMatchObject({
            preflight_id: anonymousPreflightId,
            created: false,
            preflight_status: 'pending',
        });

        const exclusion = await invokerCall<{ excluded: boolean }>(
            pool,
            'anon',
            `SELECT public.set_anonymous_analysis_v2_preflight_exclusion(
                $1::UUID, $2::VARCHAR, 'exclude', 'other.anonymous'
            ) AS excluded`,
            [anonymousPreflightId, replayClaimHash],
        );
        expect(exclusion.rows).toEqual([{ excluded: true }]);

        const dispatchToken = '66666666-6666-4666-8666-666666666666';
        const reserved = await invokerCall<{
            should_enqueue: boolean;
            dispatch_generation: number;
            reservation_token: string | null;
        }>(
            pool,
            'anon',
            `SELECT * FROM public.reserve_anonymous_analysis_v2_preflight_dispatch(
                $1::UUID, $2::VARCHAR, $3::UUID
            )`,
            [anonymousPreflightId, replayClaimHash, dispatchToken],
        );
        expect(reserved.rows).toHaveLength(1);
        expect(reserved.rows[0]).toMatchObject({
            should_enqueue: true,
            dispatch_generation: 1,
            reservation_token: dispatchToken,
        });
        const marked = await invokerCall<{ marked: boolean }>(
            pool,
            'anon',
            `SELECT public.mark_anonymous_analysis_v2_preflight_dispatched(
                $1::UUID, $2::VARCHAR, 1, $3::UUID
            ) AS marked`,
            [anonymousPreflightId, replayClaimHash, dispatchToken],
        );
        expect(marked.rows).toEqual([{ marked: true }]);

        await pool.query(
            `UPDATE public.analysis_preflights SET status = 'ready'
             WHERE id = $1::UUID`,
            [anonymousPreflightId],
        );
        const claimed = await invokerCall<{
            claimed: boolean;
            preflight_status: string;
            owner_preflight_id: string | null;
        }>(
            pool,
            'authenticated',
            `SELECT * FROM public.claim_anonymous_analysis_v2_preflight(
                $1::UUID, $2::VARCHAR, $3::UUID
            )`,
            [anonymousPreflightId, replayClaimHash, oauthUserId],
            oauthUserId,
        );
        expect(claimed.rows).toEqual([{
            claimed: true,
            preflight_status: 'claimed',
            owner_preflight_id: null,
        }]);

        const claimedOwnerMutation = await invokerCall(
            pool,
            'authenticated',
            `UPDATE public.analysis_preflights
             SET admission_status = 'blocked', status = 'blocked'
             WHERE id = $1::UUID`,
            [anonymousPreflightId],
            oauthUserId,
        );
        expect(claimedOwnerMutation.rowCount).toBe(0);

        const functionSecurity = await pool.query<{
            readiness_owner: string;
            readiness_security_definer: boolean;
            readiness_config: string[];
            exclusion_owner: string;
            exclusion_security_definer: boolean;
            exclusion_config: string[];
        }>(`
            SELECT
                pg_catalog.pg_get_userbyid(readiness.proowner) AS readiness_owner,
                readiness.prosecdef AS readiness_security_definer,
                readiness.proconfig AS readiness_config,
                pg_catalog.pg_get_userbyid(exclusion.proowner) AS exclusion_owner,
                exclusion.prosecdef AS exclusion_security_definer,
                exclusion.proconfig AS exclusion_config
            FROM pg_catalog.pg_proc AS readiness
            CROSS JOIN pg_catalog.pg_proc AS exclusion
            WHERE readiness.oid =
                'public.prepare_analysis_v2_authorized_revenue_settlement_admission(uuid,uuid,text,text,text)'::REGPROCEDURE
              AND exclusion.oid =
                'public.set_authenticated_analysis_v2_preflight_exclusion(uuid,uuid,text,text)'::REGPROCEDURE
        `);
        expect(functionSecurity.rows).toHaveLength(1);
        expect(functionSecurity.rows[0]).toMatchObject({
            readiness_owner: 'postgres',
            readiness_security_definer: true,
            exclusion_owner: 'postgres',
            exclusion_security_definer: true,
        });
        expect(functionSecurity.rows[0]?.readiness_config).toContain('search_path=""');
        expect(functionSecurity.rows[0]?.exclusion_config).toContain('search_path=""');

        const invokerCapabilities = await pool.query<{
            prosecdef: boolean;
            proconfig: string[];
        }>(`
            SELECT capability.prosecdef, capability.proconfig
            FROM pg_catalog.pg_proc AS capability
            WHERE capability.oid = ANY (ARRAY[
                'public.create_anonymous_analysis_v2_preflight(text,character varying,character varying,character varying,timestamp with time zone,jsonb,jsonb,character varying,jsonb,jsonb)'::REGPROCEDURE,
                'public.claim_anonymous_analysis_v2_preflight(uuid,character varying,uuid)'::REGPROCEDURE,
                'public.set_anonymous_analysis_v2_preflight_exclusion(uuid,character varying,text,text)'::REGPROCEDURE,
                'public.reserve_anonymous_analysis_v2_preflight_dispatch(uuid,character varying,uuid)'::REGPROCEDURE,
                'public.mark_anonymous_analysis_v2_preflight_dispatched(uuid,character varying,integer,uuid)'::REGPROCEDURE
            ])
        `);
        expect(invokerCapabilities.rows).toHaveLength(5);
        for (const capability of invokerCapabilities.rows) {
            expect(capability.prosecdef).toBe(false);
            expect(capability.proconfig).toContain('search_path=public, extensions');
        }
    }, 20_000);
});
