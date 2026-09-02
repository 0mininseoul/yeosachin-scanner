import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const budgetMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260902090000_add_vertex_ai_cost_budget_reservations.sql',
    import.meta.url,
), 'utf8');
const aclCorrectionMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260902091001_revoke_vertex_ai_budget_rpc_api_execute.sql',
    import.meta.url,
), 'utf8');

const budgetRpcSignatures = {
    reserve: 'public.reserve_vertex_ai_budget(text,text,text,text,integer,text,text,text,bigint,integer,numeric,date,numeric,numeric,numeric)',
    settle: 'public.settle_vertex_ai_budget(text,uuid,numeric)',
    cancel: 'public.cancel_vertex_ai_budget(text,uuid)',
    snapshot: 'public.snapshot_vertex_ai_budget()',
} as const;

let db: PGlite;

describe('Vertex AI budget RPC ACL regression', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS UUID
            LANGUAGE sql VOLATILE
            AS $$ SELECT '11111111-1111-4111-8111-111111111111'::uuid $$;
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;

            -- Supabase projects commonly grant function EXECUTE to API roles through
            -- default privileges. This reproduces those explicit grants without changing
            -- global/default privileges in the migration under test.
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
        `);
        await db.exec(budgetMigration);
        await db.exec(aclCorrectionMigration);
        await db.exec(aclCorrectionMigration);
    }, 30_000);

    afterAll(async () => {
        await db?.close();
    });

    it('denies API-role EXECUTE while retaining service_role EXECUTE for every budget RPC', async () => {
        const rows = await db.query<{
            rpc: string;
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_role_execute: boolean;
        }>(`
            SELECT *
            FROM (
                SELECT 'reserve' AS rpc,
                    has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon_execute,
                    has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated_execute,
                    has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_role_execute
                UNION ALL
                SELECT 'settle',
                    has_function_privilege('anon', $2::regprocedure, 'EXECUTE'),
                    has_function_privilege('authenticated', $2::regprocedure, 'EXECUTE'),
                    has_function_privilege('service_role', $2::regprocedure, 'EXECUTE')
                UNION ALL
                SELECT 'cancel',
                    has_function_privilege('anon', $3::regprocedure, 'EXECUTE'),
                    has_function_privilege('authenticated', $3::regprocedure, 'EXECUTE'),
                    has_function_privilege('service_role', $3::regprocedure, 'EXECUTE')
                UNION ALL
                SELECT 'snapshot',
                    has_function_privilege('anon', $4::regprocedure, 'EXECUTE'),
                    has_function_privilege('authenticated', $4::regprocedure, 'EXECUTE'),
                    has_function_privilege('service_role', $4::regprocedure, 'EXECUTE')
            ) rpc_acl
            ORDER BY rpc
        `, Object.values(budgetRpcSignatures));

        expect(rows.rows).toEqual([
            { rpc: 'cancel', anon_execute: false, authenticated_execute: false, service_role_execute: true },
            { rpc: 'reserve', anon_execute: false, authenticated_execute: false, service_role_execute: true },
            { rpc: 'settle', anon_execute: false, authenticated_execute: false, service_role_execute: true },
            { rpc: 'snapshot', anon_execute: false, authenticated_execute: false, service_role_execute: true },
        ]);
    });
});
