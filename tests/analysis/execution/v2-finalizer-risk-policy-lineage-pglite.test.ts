import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260731180000_accept_finalizer_risk_policy_lineage.sql',
    import.meta.url
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

const REQUEST_V23 = '10000000-0000-4000-8000-000000000023';
const REQUEST_V25 = '10000000-0000-4000-8000-000000000025';
const REQUEST_UNSUPPORTED = '10000000-0000-4000-8000-000000000099';
const REQUEST_MISSING = '10000000-0000-4000-8000-000000000000';
const REQUEST_NULL = '10000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '20000000-0000-4000-8000-000000000001';

async function createPredecessor(): Promise<PGlite> {
    const db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            policy_versions_snapshot JSONB NOT NULL,
            exclusion_decision_snapshot TEXT NOT NULL DEFAULT 'include'
        );
        CREATE TABLE public.analysis_v2_result_summaries (
            request_id UUID PRIMARY KEY,
            exclusion_applied BOOLEAN NOT NULL,
            score_policy_version TEXT NOT NULL,
            finalizer_input_hash TEXT NOT NULL
        );
        INSERT INTO public.analysis_requests (id, policy_versions_snapshot) VALUES
            ('${REQUEST_MISSING}', '{"pipeline":"v2"}'),
            ('${REQUEST_NULL}', '{"risk":null}'),
            ('${REQUEST_V23}', '{"risk":"risk-policy-v2.3"}'),
            ('${REQUEST_V25}', '{"risk":"risk-policy-v2.5"}'),
            ('${REQUEST_UNSUPPORTED}', '{"risk":"risk-policy-v9.9"}');

        CREATE FUNCTION public.analysis_v2_complete_result_and_purge_internal(
            p_request_id UUID,
            p_job_key TEXT,
            p_claim_token UUID,
            p_job_input_hash TEXT,
            p_target_profile_image_url TEXT
        ) RETURNS JSONB
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $function$
        DECLARE
            v_request public.analysis_requests%ROWTYPE;
        BEGIN
            SELECT request.* INTO v_request
            FROM public.analysis_requests AS request
            WHERE request.id = p_request_id;

            IF v_request.id IS NULL
               OR v_request.policy_versions_snapshot->>'risk' <> 'risk-policy-v2.3' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
            END IF;

            INSERT INTO public.analysis_v2_result_summaries (
                request_id, exclusion_applied, score_policy_version,
                finalizer_input_hash
            ) VALUES (
                p_request_id,
                v_request.exclusion_decision_snapshot = 'exclude', 'risk-policy-v2.3',
                p_job_input_hash
            );
            RETURN pg_catalog.jsonb_build_object('finalized', TRUE);
        END;
        $function$;

        REVOKE ALL ON FUNCTION public.analysis_v2_complete_result_and_purge_internal(
            UUID, TEXT, UUID, TEXT, TEXT
        ) FROM PUBLIC, anon, authenticated, service_role;
    `);
    return db;
}

async function finalize(db: PGlite, requestId: string) {
    return db.query(
        `SELECT public.analysis_v2_complete_result_and_purge_internal(
            $1, 'coordinator:finalize', $2, $3, '/result-image.webp'
        )`,
        [requestId, CLAIM_TOKEN, 'a'.repeat(64)]
    );
}

describe('analysis v2 finalizer risk policy lineage', () => {
    it('accepts supported request policy snapshots and persists their exact version', async () => {
        const db = await createPredecessor();
        try {
            await expect(finalize(db, REQUEST_V25)).rejects.toThrow(
                /ANALYSIS_V2_RESULT_NOT_READY/
            );

            await db.exec(migration);
            await expect(finalize(db, REQUEST_V25)).resolves.toBeDefined();
            await expect(finalize(db, REQUEST_V23)).resolves.toBeDefined();

            const summaries = await db.query<{
                request_id: string;
                score_policy_version: string;
            }>(`
                SELECT request_id, score_policy_version
                FROM public.analysis_v2_result_summaries
                ORDER BY request_id
            `);
            expect(summaries.rows).toEqual([
                { request_id: REQUEST_V23, score_policy_version: 'risk-policy-v2.3' },
                { request_id: REQUEST_V25, score_policy_version: 'risk-policy-v2.5' },
            ]);
        } finally {
            await db.close();
        }
    });

    it('continues to reject unsupported request policy snapshots', async () => {
        const db = await createPredecessor();
        try {
            await db.exec(migration);
            await expect(finalize(db, REQUEST_UNSUPPORTED)).rejects.toThrow(
                /ANALYSIS_V2_RESULT_NOT_READY/
            );
            await expect(finalize(db, REQUEST_MISSING)).rejects.toThrow(
                /ANALYSIS_V2_RESULT_NOT_READY/
            );
            await expect(finalize(db, REQUEST_NULL)).rejects.toThrow(
                /ANALYSIS_V2_RESULT_NOT_READY/
            );
        } finally {
            await db.close();
        }
    });

    it('preserves the hardened function boundary and exact patch scope', async () => {
        const db = await createPredecessor();
        try {
            await db.exec(migration);
            const definition = await db.query<{ definition: string }>(`
                SELECT pg_catalog.pg_get_functiondef(
                    'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
                        ::pg_catalog.regprocedure
                ) AS definition
            `);
            expect(definition.rows[0]!.definition).toContain('SECURITY DEFINER');
            expect(definition.rows[0]!.definition).toContain("SET search_path TO ''");
            expect(definition.rows[0]!.definition).toContain(
                "(v_request.policy_versions_snapshot->>'risk' IS NULL OR v_request.policy_versions_snapshot->>'risk' NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5'))"
            );
            expect(definition.rows[0]!.definition).toContain(
                "v_request.exclusion_decision_snapshot = 'exclude',\n        v_request.policy_versions_snapshot->>'risk'"
            );

            const privileges = await db.query<{
                public_execute: boolean;
                anon_execute: boolean;
                authenticated_execute: boolean;
                service_role_execute: boolean;
            }>(`
                SELECT
                    COALESCE((
                        SELECT pg_catalog.bool_or(acl.grantee = 0)
                        FROM pg_catalog.aclexplode(COALESCE(
                            proc.proacl,
                            pg_catalog.acldefault('f', proc.proowner)
                        )) AS acl
                        WHERE acl.privilege_type = 'EXECUTE'
                    ), FALSE) AS public_execute,
                    pg_catalog.has_function_privilege(
                        'anon',
                        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)',
                        'EXECUTE'
                    ) AS anon_execute,
                    pg_catalog.has_function_privilege(
                        'authenticated',
                        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)',
                        'EXECUTE'
                    ) AS authenticated_execute,
                    pg_catalog.has_function_privilege(
                        'service_role',
                        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)',
                        'EXECUTE'
                    ) AS service_role_execute
                FROM pg_catalog.pg_proc AS proc
                WHERE proc.oid =
                    'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
                        ::pg_catalog.regprocedure
            `);
            expect(privileges.rows[0]).toEqual({
                public_execute: false,
                anon_execute: false,
                authenticated_execute: false,
                service_role_execute: false,
            });
        } finally {
            await db.close();
        }
    });
});
