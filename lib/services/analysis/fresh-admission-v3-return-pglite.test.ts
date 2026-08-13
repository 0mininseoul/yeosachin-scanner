import { readdirSync, readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = readdirSync(migrationDirectory)
    .find((name) => name.endsWith('_correct_claim_analysis_v2_preflight_admission_v3_return_contract.sql'));
if (!migrationName) throw new Error('FRESH_ADMISSION_V3_RETURN_CONTRACT_MIGRATION_MISSING');
const migration = readFileSync(new URL(migrationName, migrationDirectory), 'utf8');

const v3Signature =
    'public.claim_analysis_v2_preflight_admission_v3(uuid,integer,integer,uuid,uuid,integer)';
const v2Function = 'public.claim_analysis_v2_preflight_admission_v2';
const v3Function = 'public.claim_analysis_v2_preflight_admission_v3';
const preflightId = '10000000-0000-4000-8000-000000000001';
const dispatchToken = '20000000-0000-4000-8000-000000000001';
const claimToken = '30000000-0000-4000-8000-000000000001';

let db: PGlite;

async function asService<T>(sql: string, params: unknown[] = []) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY,
            status TEXT NOT NULL,
            consumed_request_id UUID,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            admission_generation INTEGER,
            admission_dispatch_generation INTEGER,
            admission_dispatch_token UUID,
            admission_dispatch_state TEXT,
            admission_status TEXT,
            admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
            analysis_entry_channel TEXT,
            access_mode TEXT,
            target_instagram_id TEXT,
            order_scoped_apify_credential_slot TEXT,
            admission_claim_token UUID,
            admission_dispatched_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE
        );
        CREATE FUNCTION public.claim_analysis_v2_preflight_admission_v2(
            UUID, INTEGER, INTEGER, UUID, UUID, INTEGER
        ) RETURNS TABLE(
            claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT,
            analysis_entry_channel TEXT, access_mode TEXT
        ) LANGUAGE sql AS $$
            SELECT FALSE, 'legacy', NULL::TEXT, 'standard', 'production';
        $$;
        CREATE FUNCTION public.claim_analysis_v2_preflight_admission_v3(
            UUID, INTEGER, INTEGER, UUID, UUID, INTEGER
        ) RETURNS TABLE(
            claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT,
            analysis_entry_channel TEXT, access_mode TEXT
        ) LANGUAGE sql AS $$
            SELECT FALSE, 'broken', NULL::TEXT, 'standard', 'production';
        $$;
    `);
    await db.exec(migration);
});

afterAll(async () => {
    await db.close();
});

describe('fresh-admission v3 return contract PGlite regression', () => {
    it('replaces the malformed v3 contract with six executable columns while leaving v2 unchanged', async () => {
        const legacy = await db.query<Record<string, unknown>>(
            `SELECT * FROM ${v2Function}(NULL, 1, 1, NULL, NULL, 30)`,
        );
        expect(Object.keys(legacy.rows[0])).toEqual([
            'claimed', 'admission_status', 'target_instagram_id',
            'analysis_entry_channel', 'access_mode',
        ]);

        await db.query(
            `INSERT INTO public.analysis_preflights(
                id,status,expires_at,admission_generation,admission_dispatch_generation,
                admission_dispatch_token,admission_dispatch_state,admission_status,
                analysis_entry_channel,access_mode,target_instagram_id,
                order_scoped_apify_credential_slot,updated_at
            ) VALUES (
                $1,'ready',clock_timestamp() + interval '10 minutes',1,1,
                $2,'reserved','queued','earlybird','paid','target','tertiary',clock_timestamp()
            )`,
            [preflightId, dispatchToken],
        );

        const claimed = await asService<{
            claimed: boolean;
            admission_status: string;
            target_instagram_id: string | null;
            analysis_entry_channel: string;
            access_mode: string;
            order_scoped_credential_slot: string | null;
        }>(
            `SELECT * FROM ${v3Function}($1, 1, 1, $2, $3, 30)`,
            [preflightId, dispatchToken, claimToken],
        );
        expect(claimed.rows).toEqual([{
            claimed: true,
            admission_status: 'processing',
            target_instagram_id: 'target',
            analysis_entry_channel: 'earlybird',
            access_mode: 'paid',
            order_scoped_credential_slot: 'tertiary',
        }]);

        const alreadyProcessing = await asService<{
            claimed: boolean;
            admission_status: string;
            target_instagram_id: string | null;
            analysis_entry_channel: string;
            access_mode: string;
            order_scoped_credential_slot: string | null;
        }>(
            `SELECT * FROM ${v3Function}($1, 1, 1, $2, $3, 30)`,
            [preflightId, dispatchToken, claimToken],
        );
        expect(alreadyProcessing.rows).toEqual([{
            claimed: false,
            admission_status: 'processing',
            target_instagram_id: null,
            analysis_entry_channel: 'earlybird',
            access_mode: 'paid',
            order_scoped_credential_slot: 'tertiary',
        }]);
    });

    it('retains a SECURITY DEFINER empty-search-path service-role-only ACL', async () => {
        const permissions = await db.query<{
            security_definer: boolean;
            empty_search_path: boolean;
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_execute: boolean;
        }>(`
            SELECT proc.prosecdef AS security_definer,
                COALESCE('search_path=""' = ANY(proc.proconfig), FALSE) AS empty_search_path,
                pg_catalog.has_function_privilege('anon', proc.oid, 'EXECUTE') AS anon_execute,
                pg_catalog.has_function_privilege('authenticated', proc.oid, 'EXECUTE') AS authenticated_execute,
                pg_catalog.has_function_privilege('service_role', proc.oid, 'EXECUTE') AS service_execute
            FROM pg_catalog.pg_proc AS proc
            WHERE proc.oid = $1::regprocedure
        `, [v3Signature]);
        expect(permissions.rows).toEqual([{
            security_definer: true,
            empty_search_path: true,
            anon_execute: false,
            authenticated_execute: false,
            service_execute: true,
        }]);
    });
});
