import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDir = new URL('../../../supabase/migrations/', import.meta.url);
const migrationFile = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).find(file => file.endsWith('_concierge_v214_gemini_copy_correction.sql'))
    : undefined;
const migration = migrationFile
    ? readFileSync(new URL(`../../../supabase/migrations/${migrationFile}`, import.meta.url), 'utf8')
    : '';

describe('v2.14 first-payment Gemini copy correction migration contract', () => {
    it('is a service-role-only immutable successor to the sealed v2.13 correction', () => {
        expect(migrationFile).toBeDefined();
        expect(migration).toContain('CREATE TABLE public.earlybird_v214_concierge_gemini_copy_corrections');
        expect(migration).toContain('CREATE FUNCTION public.correct_earlybird_v214_concierge_gemini_copy');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('TO service_role');
        expect(migration).toContain('earlybird_v213_concierge_copy_corrections');
        expect(migration).toContain('CONCIERGE_COPY_V214_PRIOR_CORRECTION_CONFLICT');
        expect(migration).toContain('CONCIERGE_COPY_V214_CORRECTION_IMMUTABLE');
    });

    it('CAS-binds all sixteen v2.13 rows, Gemini source, and every non-copy field before changing only copy', () => {
        expect(migration).toContain("p_copy_payload->>'qualityVersion' IS DISTINCT FROM 'v214-gemini-first-payment-copy-v1'");
        expect(migration).toContain("item->>'source' IS DISTINCT FROM 'gemini'");
        expect(migration).toContain('p_expected_v213_fact_snapshot JSONB');
        expect(migration).toContain('CONCIERGE_COPY_V214_FACT_SNAPSHOT_CONFLICT');
        expect(migration).toContain('v_result_count IS DISTINCT FROM 16');
        expect(migration).toContain('v_high_risk_count IS DISTINCT FROM 2');
        expect(migration).toContain('CONCIERGE_COPY_V214_HIGH_RISK_EVIDENCE_INVALID');
        expect(migration).toContain('CONCIERGE_COPY_V214_HIGH_RISK_NARRATIVE_UNCHANGED');
        expect(migration).toContain('SET one_line_overview');
        expect(migration).toContain('risk_analysis = v_row');
        expect(migration).not.toContain('DELETE FROM public.analysis_results');
        expect(migration).not.toContain('UPDATE public.earlybird_orders');
    });
});
