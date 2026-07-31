import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731150000_tolerate_v24_preliminary_upper_bound_float_drift.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.4/v2.5 preliminary upper-bound float tolerance migration', () => {
    it('accepts serialization dust but rejects drift beyond the existing tolerance', async () => {
        const db = await PGlite.create();
        try {
            await db.exec(`
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;
                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
                    p_request_id UUID,
                    p_job_key TEXT,
                    p_claim_token UUID,
                    p_job_input_hash TEXT,
                    p_rows JSONB,
                    p_risk_policy_version TEXT
                ) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
                BEGIN
                    IF p_risk_policy_version NOT IN ('risk-policy-v2.4', 'risk-policy-v2.5')
                       OR EXISTS (
                            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
                            WHERE pg_catalog.jsonb_typeof(item.value->'possibleUpperBound') <> 'number'
                               OR (item.value->>'possibleUpperBound')::NUMERIC
                                    NOT BETWEEN (item.value->>'preScore')::NUMERIC
                                        AND LEAST((item.value->>'preScore')::NUMERIC + 5, 100)
                       ) THEN
                        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
                        WHERE pg_catalog.abs(
                            (item.value->>'possibleUpperBound')::NUMERIC
                            - LEAST((item.value->>'preScore')::NUMERIC + 5, 100)
                        ) > 0.0001
                    ) THEN
                        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
                    END IF;
                    RETURN '{}'::JSONB;
                END;
                $function$;
            `);

            await db.exec(migration);

            const call = (possibleUpperBound: number) => db.query(
                `SELECT public.checkpoint_analysis_v2_preliminary_scores_v24(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:candidate-screening',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.5'
                )`,
                [JSON.stringify([{ preScore: 10, possibleUpperBound }])]
            );

            await expect(call(15.000000000000003)).resolves.toBeDefined();
            await expect(call(15.0002)).rejects.toThrow('ANALYSIS_V2_RESULT_INVALID');
        } finally {
            await db.close();
        }
    });

    it('keeps the patch drift-guarded and service-role-only', () => {
        expect(migration).toContain('ANALYSIS_V2_PRELIMINARY_UPPER_BOUND_TOLERANCE_DRIFT');
        expect(migration).toContain('> 0.0001');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24');
        expect(migration).toContain('TO service_role');
    });
});
