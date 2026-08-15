import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDir = new URL('../../../supabase/migrations/', import.meta.url);
const migrationFile = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).find(file => file.endsWith('_concierge_v213_full_evidence_copy_correction.sql'))
    : undefined;
const migration = migrationFile
    ? readFileSync(new URL(`../../../supabase/migrations/${migrationFile}`, import.meta.url), 'utf8')
    : '';

describe('v2.13 concierge full copy correction migration contract', () => {
    it('is an immutable, service-role-only one-shot correction chained to v2.12', () => {
        expect(migrationFile).toBeDefined();
        expect(migration).toContain('CREATE TABLE public.earlybird_v213_concierge_copy_corrections');
        expect(migration).toContain('CREATE FUNCTION public.correct_earlybird_v213_concierge_copy');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('TO service_role');
        expect(migration).toContain('prior_correction_result_hash');
        expect(migration).toContain('CONCIERGE_COPY_V213_PRIOR_CORRECTION_CONFLICT');
    });

    it('requires a semantic review for every v2.12 row and updates no fields beyond public copy', () => {
        expect(migration).toContain("p_copy_payload->>'qualityVersion' IS DISTINCT FROM 'v213-full-evidence-review-v1'");
        expect(migration).toContain("item->'review'->>'overviewChanged' IS DISTINCT FROM 'true'");
        expect(migration).toContain("item->'review'->>'previousOverview' IS DISTINCT FROM prior_row->>'oneLineOverview'");
        expect(migration).toContain("item->>'oneLineOverview' IS NOT DISTINCT FROM prior_row->>'oneLineOverview'");
        expect(migration).toContain('retainedSentenceJustifications');
        expect(migration).toContain('CONCIERGE_COPY_V213_INTERACTION_DIRECTION_CONFLICT');
        expect(migration).toContain("item->'review'->>'rank' IS DISTINCT FROM item->>'rank'");
        expect(migration).toContain('CONCIERGE_COPY_V213_SEMANTIC_DIFF_CONFLICT');
        expect(migration).toContain('v213CopyCorrection');
        expect(migration).toContain('SET one_line_overview');
        expect(migration).not.toContain('DELETE FROM public.analysis_results');
        expect(migration).not.toContain('UPDATE public.earlybird_orders');
    });
});
