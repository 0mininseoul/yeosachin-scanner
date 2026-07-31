import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731160000_drop_stale_preliminary_score_upper_bound_constraint.sql',
        import.meta.url
    ),
    'utf8'
);

async function createPreliminaryScoreTable(
    db: PGlite,
    legacyUpperBoundDelta = 3,
    currentUpperBoundDelta = 5
) {
    await db.exec(`
        CREATE TABLE public.analysis_v2_preliminary_score_rows (
            candidate_id TEXT PRIMARY KEY,
            pre_score NUMERIC NOT NULL,
            possible_upper_bound NUMERIC NOT NULL CHECK (
                possible_upper_bound BETWEEN pre_score AND pre_score + ${legacyUpperBoundDelta}
                AND possible_upper_bound <= 100
            )
        );

        ALTER TABLE public.analysis_v2_preliminary_score_rows
            ADD CONSTRAINT analysis_v2_preliminary_score_rows_possible_upper_bound_check
            CHECK (
                possible_upper_bound BETWEEN pre_score AND pre_score + ${currentUpperBoundDelta}
                AND possible_upper_bound <= 100
            ) NOT VALID;
    `);
}

describe('legacy preliminary-score upper-bound constraint cleanup', () => {
    it('drops only the stale three-point constraint and permits the five-point bound', async () => {
        const db = await PGlite.create();
        try {
            await createPreliminaryScoreTable(db);

            await expect(db.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows
                    (candidate_id, pre_score, possible_upper_bound)
                VALUES ('before', 50, 55);
            `)).rejects.toThrow();

            await db.exec(migration);

            await expect(db.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows
                    (candidate_id, pre_score, possible_upper_bound)
                VALUES ('after', 50, 55);
            `)).resolves.toBeDefined();
            await expect(db.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows
                    (candidate_id, pre_score, possible_upper_bound)
                VALUES ('too-high', 50, 55.0001);
            `)).rejects.toThrow();

            const constraints = await db.query<{
                conname: string;
                convalidated: boolean;
            }>(`
                SELECT conname, convalidated
                FROM pg_catalog.pg_constraint
                WHERE conrelid =
                    'public.analysis_v2_preliminary_score_rows'::pg_catalog.regclass
                  AND contype = 'c'
                ORDER BY conname
            `);
            expect(constraints.rows).toEqual([{
                conname: 'analysis_v2_preliminary_score_rows_possible_upper_bound_check',
                convalidated: false,
            }]);
        } finally {
            await db.close();
        }
    });

    it('fails closed when the legacy constraint name has an unexpected definition', async () => {
        const db = await PGlite.create();
        try {
            await createPreliminaryScoreTable(db, 4);

            await expect(db.exec(migration)).rejects.toThrow(
                'ANALYSIS_V2_PRELIMINARY_LEGACY_BOUND_SCHEMA_DRIFT'
            );

            const constraints = await db.query<{ conname: string }>(`
                SELECT conname
                FROM pg_catalog.pg_constraint
                WHERE conrelid =
                    'public.analysis_v2_preliminary_score_rows'::pg_catalog.regclass
                  AND contype = 'c'
                ORDER BY conname
            `);
            expect(constraints.rows.map(({ conname }) => conname)).toEqual([
                'analysis_v2_preliminary_score_rows_check',
                'analysis_v2_preliminary_score_rows_possible_upper_bound_check',
            ]);
        } finally {
            await db.close();
        }
    });

    it('fails closed without dropping legacy when the named current bound drifted', async () => {
        const db = await PGlite.create();
        try {
            await createPreliminaryScoreTable(db, 3, 6);

            await expect(db.exec(migration)).rejects.toThrow(
                'ANALYSIS_V2_PRELIMINARY_CURRENT_BOUND_SCHEMA_DRIFT'
            );

            const constraints = await db.query<{ conname: string }>(`
                SELECT conname
                FROM pg_catalog.pg_constraint
                WHERE conrelid =
                    'public.analysis_v2_preliminary_score_rows'::pg_catalog.regclass
                  AND contype = 'c'
                ORDER BY conname
            `);
            expect(constraints.rows.map(({ conname }) => conname)).toEqual([
                'analysis_v2_preliminary_score_rows_check',
                'analysis_v2_preliminary_score_rows_possible_upper_bound_check',
            ]);
        } finally {
            await db.close();
        }
    });
});
