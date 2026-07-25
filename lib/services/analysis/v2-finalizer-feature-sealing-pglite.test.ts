import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sealingMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260725033000_allow_analysis_unavailable_finalizer_sealing.sql',
        import.meta.url
    ),
    'utf8'
);

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE TABLE public.analysis_v2_candidate_feature_rows (
            candidate_id TEXT PRIMARY KEY,
            terminal_classification TEXT NOT NULL,
            unavailable_reason TEXT,
            baseline_classification TEXT NOT NULL,
            classification_source TEXT NOT NULL,
            gender_resolution_status TEXT NOT NULL,
            CONSTRAINT analysis_v2_candidate_feature_unavailable_reason_check CHECK (
                (
                    terminal_classification = 'unavailable'
                    AND unavailable_reason IN ('profile_fetch', 'ai_response')
                )
                OR (
                    terminal_classification <> 'unavailable'
                    AND unavailable_reason IS NULL
                )
            ),
            CONSTRAINT analysis_v2_candidate_feature_resolution_change_check CHECK (
                (
                    classification_source = 'gender_resolution'
                    AND gender_resolution_status = 'ready_applied'
                    AND baseline_classification IN (
                        'unresolved', 'unresolved_stage_conflict'
                    )
                    AND terminal_classification IN (
                        'verified_female', 'verified_non_female'
                    )
                )
                OR (
                    classification_source <> 'gender_resolution'
                    AND gender_resolution_status <> 'ready_applied'
                    AND terminal_classification = CASE baseline_classification
                        WHEN 'fetch_unavailable' THEN 'unavailable'
                        WHEN 'analysis_unavailable' THEN 'unavailable'
                        ELSE baseline_classification
                    END
                )
            )
        );
        INSERT INTO public.analysis_v2_candidate_feature_rows VALUES (
            'candidate:sealed',
            'unavailable',
            'ai_response',
            'analysis_unavailable',
            'unavailable',
            'terminal_unavailable'
        );
    `);
});

afterAll(async () => {
    await db.close();
});

describe('analysis-unavailable finalizer sealing constraint', () => {
    it('rejects the production sealing update before the forward migration', async () => {
        await expect(db.exec(`
            UPDATE public.analysis_v2_candidate_feature_rows
            SET terminal_classification = 'media_unavailable',
                unavailable_reason = NULL
            WHERE candidate_id = 'candidate:sealed'
        `)).rejects.toThrow(
            /analysis_v2_candidate_feature_resolution_change_check/
        );
    });

    it('allows only the sealed analysis-unavailable provenance after migration', async () => {
        await db.exec(sealingMigration);
        await db.exec(`
            UPDATE public.analysis_v2_candidate_feature_rows
            SET terminal_classification = 'media_unavailable',
                unavailable_reason = NULL
            WHERE candidate_id = 'candidate:sealed'
        `);

        const sealed = await db.query<{
            terminal_classification: string;
            unavailable_reason: string | null;
            baseline_classification: string;
        }>(`
            SELECT terminal_classification, unavailable_reason,
                   baseline_classification
            FROM public.analysis_v2_candidate_feature_rows
            WHERE candidate_id = 'candidate:sealed'
        `);
        expect(sealed.rows).toEqual([{
            terminal_classification: 'media_unavailable',
            unavailable_reason: null,
            baseline_classification: 'analysis_unavailable',
        }]);

        for (const invalid of [
            [
                'candidate:wrong-baseline',
                'media_unavailable',
                null,
                'unresolved',
                'unavailable',
                'cutoff',
            ],
            [
                'candidate:wrong-source',
                'media_unavailable',
                null,
                'analysis_unavailable',
                'unknown',
                'cutoff',
            ],
            [
                'candidate:ready-resolver',
                'media_unavailable',
                null,
                'analysis_unavailable',
                'unavailable',
                'ready_applied',
            ],
        ]) {
            await expect(db.query(
                `INSERT INTO public.analysis_v2_candidate_feature_rows
                    (candidate_id, terminal_classification, unavailable_reason,
                     baseline_classification, classification_source,
                     gender_resolution_status)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                invalid
            )).rejects.toThrow(
                /analysis_v2_candidate_feature_resolution_change_check/
            );
        }
    });
});
