import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728090000_reconcile_analysis_v2_preliminary_score_upper_bound.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 v2.4 preliminary upper-bound reconciliation', () => {
    it('replaces a stale three-point bound without revalidating legacy rows', async () => {
        const db = await PGlite.create();
        try {
            await db.exec(`
                CREATE TABLE public.analysis_v2_preliminary_score_rows (
                    candidate_id TEXT PRIMARY KEY,
                    pre_score NUMERIC NOT NULL,
                    possible_upper_bound NUMERIC NOT NULL,
                    CONSTRAINT analysis_v2_preliminary_score_rows_possible_upper_bound_check
                        CHECK (
                            possible_upper_bound BETWEEN pre_score AND pre_score + 3
                            AND possible_upper_bound <= 100
                        )
                );

                INSERT INTO public.analysis_v2_preliminary_score_rows (
                    candidate_id, pre_score, possible_upper_bound
                ) VALUES ('legacy', 50, 53);
            `);

            await expect(db.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows (
                    candidate_id, pre_score, possible_upper_bound
                ) VALUES ('before-v24', 50, 55);
            `)).rejects.toThrow();

            await db.exec(migration);

            await expect(db.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows (
                    candidate_id, pre_score, possible_upper_bound
                ) VALUES ('v24', 50, 55);
            `)).resolves.toBeDefined();
            await expect(db.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows (
                    candidate_id, pre_score, possible_upper_bound
                ) VALUES ('too-high', 50, 55.0001);
            `)).rejects.toThrow();

            const rows = await db.query<{ candidate_id: string }>(`
                SELECT candidate_id
                FROM public.analysis_v2_preliminary_score_rows
                ORDER BY candidate_id
            `);
            expect(rows.rows).toEqual([
                { candidate_id: 'legacy' },
                { candidate_id: 'v24' },
            ]);

            const constraint = await db.query<{ convalidated: boolean }>(`
                SELECT convalidated
                FROM pg_catalog.pg_constraint
                WHERE conname =
                    'analysis_v2_preliminary_score_rows_possible_upper_bound_check'
            `);
            expect(constraint.rows).toEqual([{ convalidated: false }]);
        } finally {
            await db.close();
        }
    });
});
