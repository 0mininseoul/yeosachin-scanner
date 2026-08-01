import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260801160000_fix_schema_recovery_source_preflight_partial_adoption.sql',
    import.meta.url
), 'utf8');

let db: PGlite;

beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.earlybird_orders (id uuid);
        CREATE TABLE public.analysis_preflights (id uuid);
        CREATE TABLE public.analysis_pipeline_jobs (id uuid);
        CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_recovery_provider_run(
            uuid, text, uuid, text, text, text, text, text, numeric
        ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
        DECLARE
            v_recovery_preflight public.analysis_preflights%ROWTYPE;
            v_job public.analysis_pipeline_jobs%ROWTYPE;
            v_failed_request record;
            v_order record;
            v_side text;
            v_source_count integer;
        BEGIN
            SELECT preflight.* INTO v_recovery_preflight
            FROM public.analysis_preflights AS preflight
            FOR UPDATE;
            -- Repeat every mutable lineage fence after reacquiring canonical row locks;
            v_source_count := CASE v_side
                WHEN 'followers' THEN v_order.target_followers_count
                ELSE v_order.target_following_count
            END;
            RETURN '{}'::jsonb;
        END;
        $$;
        CREATE OR REPLACE FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
            uuid, uuid, timestamp with time zone
        ) RETURNS TABLE(order_id uuid, fulfillment_status text, preflight_id uuid, failed_request_id uuid)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
        BEGIN
            -- OR v_fulfillment.attempt_count <> 5
            -- AND job.attempt_count = 0
            --               AND job.last_error_code = 'REQUEST_TERMINATED'
            -- OR EXISTS (
            --            SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            --            WHERE adoption.request_id = v_request.id
            --       )
            -- OR v_audit.expected_manual_review_at
            --                IS DISTINCT FROM p_expected_manual_review_at THEN
            RETURN;
        END;
        $$;
    `);
    await db.exec([
        'CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_recovery_provider_run(uuid, text, uuid, text, text, text, text, text, numeric)',
        "RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$",
        'DECLARE',
        '    v_recovery_preflight public.analysis_preflights%ROWTYPE;',
        '    v_job public.analysis_pipeline_jobs%ROWTYPE;',
        '    v_failed_request record;',
        '    v_order record;',
        '    v_side text;',
        '    v_source_count integer;',
        'BEGIN',
        '    SELECT preflight.* INTO v_recovery_preflight FROM public.analysis_preflights AS preflight FOR UPDATE;',
        '    -- Repeat every mutable lineage fence after reacquiring canonical row locks;',
        '    v_source_count := CASE v_side',
        "        WHEN 'followers' THEN v_order.target_followers_count",
        '        ELSE v_order.target_following_count',
        '    END;',
        "    RETURN '{}'::jsonb;",
        'END;',
        '$$;',
    ].join('\n'));
});

afterAll(async () => {
    await db.close();
});

describe('source-preflight partial-adoption migration', () => {
    it('fails closed before either dynamic function is replaced when the resolver is incomplete', async () => {
        await expect(db.exec(migration)).rejects.toThrow(
            'EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_RESOLVER_PATCH_MISMATCH'
        );
        const before = await db.query<{ definition: string }>(`
            SELECT pg_catalog.pg_get_functiondef(
                'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)'::regprocedure
            ) AS definition
        `);
        expect(before.rows[0].definition).not.toContain('v_source_preflight');

        const rearm = await db.query<{ definition: string }>(`
            SELECT pg_catalog.pg_get_functiondef(
                'public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamp with time zone)'::regprocedure
            ) AS definition
        `);
        expect(rearm.rows[0].definition).not.toContain('ANALYSIS_V2_PROGRESS_CONFLICT');
    });
});
