import { readdirSync, readFileSync } from 'node:fs';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = readdirSync(migrationDirectory)
    .find((name) => name.endsWith('_correct_claim_analysis_v2_preflight_admission_v3_return_contract.sql'));
if (!migrationName) throw new Error('FRESH_ADMISSION_V3_RETURN_CONTRACT_MIGRATION_MISSING');
const migration = readFileSync(new URL(migrationName, migrationDirectory), 'utf8');

const databaseUrl = process.env.FRESH_ADMISSION_V3_POSTGRES_TEST_URL;
const suppliedMarker = process.env.FRESH_ADMISSION_V3_POSTGRES_TEST_MARKER;
const marker = 'local-ephemeral-fresh-admission-v3-only';
const preflightId = '40000000-0000-4000-8000-000000000001';
const dispatchToken = '50000000-0000-4000-8000-000000000001';
const claimToken = '60000000-0000-4000-8000-000000000001';
const signature =
    'public.claim_analysis_v2_preflight_admission_v3(uuid,integer,integer,uuid,uuid,integer)';

export function isSafeFreshAdmissionV3PostgresTestTarget(
    connectionString: string | undefined,
    suppliedTestMarker: string | undefined,
): boolean {
    if (!connectionString || suppliedTestMarker !== marker) return false;
    try {
        const target = new URL(connectionString);
        if (target.search) return false;
        return target.protocol === 'postgresql:'
            && (target.hostname === '127.0.0.1' || target.hostname === 'localhost')
            && target.pathname === '/fresh_admission_v3_return_contract_test';
    } catch {
        return false;
    }
}

const describePostgres = isSafeFreshAdmissionV3PostgresTestTarget(databaseUrl, suppliedMarker)
    ? describe
    : describe.skip;

describe('fresh-admission v3 PostgreSQL destructive-test target guard', () => {
    it.each([
        ['postgresql://tester@127.0.0.1:5432/fresh_admission_v3_return_contract_test', marker, true],
        ['postgresql://tester@db.example.com/fresh_admission_v3_return_contract_test', marker, false],
        ['postgresql://tester@127.0.0.1:5432/fresh_admission_v3_return_contract_test?host=db.example.com', marker, false],
        ['postgresql://tester@127.0.0.1:5432/postgres', marker, false],
        ['postgresql://tester@127.0.0.1:5432/fresh_admission_v3_return_contract_test', undefined, false],
    ])('accepts only an explicit disposable loopback target', (url, testMarker, expected) => {
        expect(isSafeFreshAdmissionV3PostgresTestTarget(url, testMarker)).toBe(expected);
    });
});

describePostgres('fresh-admission v3 PostgreSQL return contract', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 2 });
        await pool.query(`
            DROP SCHEMA IF EXISTS public CASCADE;
            CREATE SCHEMA public;
            DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            GRANT service_role TO CURRENT_USER;
            CREATE TABLE public.analysis_preflights (
                id UUID PRIMARY KEY, status TEXT NOT NULL, consumed_request_id UUID,
                expires_at TIMESTAMP WITH TIME ZONE NOT NULL, admission_generation INTEGER,
                admission_dispatch_generation INTEGER, admission_dispatch_token UUID,
                admission_dispatch_state TEXT, admission_status TEXT,
                admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
                analysis_entry_channel TEXT, access_mode TEXT, target_instagram_id TEXT,
                order_scoped_apify_credential_slot TEXT, admission_claim_token UUID,
                admission_dispatched_at TIMESTAMP WITH TIME ZONE,
                updated_at TIMESTAMP WITH TIME ZONE
            );
            CREATE FUNCTION public.claim_analysis_v2_preflight_admission_v3(
                UUID, INTEGER, INTEGER, UUID, UUID, INTEGER
            ) RETURNS TABLE(
                claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT,
                analysis_entry_channel TEXT, access_mode TEXT
            ) LANGUAGE sql AS $$ SELECT FALSE, 'broken', NULL::TEXT, 'standard', 'production'; $$;
            GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        `);
        await pool.query(migration);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('executes all six columns and restricts execution to service_role', async () => {
        await pool.query(`
            INSERT INTO public.analysis_preflights(
                id,status,expires_at,admission_generation,admission_dispatch_generation,
                admission_dispatch_token,admission_dispatch_state,admission_status,
                analysis_entry_channel,access_mode,target_instagram_id,
                order_scoped_apify_credential_slot,updated_at
            ) VALUES (
                $1,'ready',clock_timestamp() + interval '10 minutes',1,1,
                $2,'reserved','queued','earlybird','paid','target','tertiary',clock_timestamp()
            )
        `, [preflightId, dispatchToken]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE service_role');
            await expect(client.query(
                `SELECT * FROM ${signature}($1, 1, 1, $2, $3, 30)`,
                [preflightId, dispatchToken, claimToken],
            )).resolves.toMatchObject({ rows: [{
                claimed: true,
                admission_status: 'processing',
                target_instagram_id: 'target',
                analysis_entry_channel: 'earlybird',
                access_mode: 'paid',
                order_scoped_credential_slot: 'tertiary',
            }] });
            await client.query('COMMIT');
        } finally {
            client.release();
        }
        await expect(pool.query(`
            SELECT proc.prosecdef AS security_definer,
                COALESCE('search_path=""' = ANY(proc.proconfig), FALSE) AS empty_search_path,
                has_function_privilege('anon', proc.oid, 'EXECUTE') AS anon_execute,
                has_function_privilege('authenticated', proc.oid, 'EXECUTE') AS authenticated_execute,
                has_function_privilege('service_role', proc.oid, 'EXECUTE') AS service_execute
            FROM pg_proc AS proc WHERE proc.oid = $1::regprocedure
        `, [signature])).resolves.toMatchObject({ rows: [{
            security_definer: true,
            empty_search_path: true,
            anon_execute: false,
            authenticated_execute: false,
            service_execute: true,
        }] });
    });
});
