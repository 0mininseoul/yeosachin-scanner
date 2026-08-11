import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    new URL('../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql', import.meta.url),
    'utf8'
);

describe('fresh revenue provenance migration contract', () => {
    it('keeps the revenue parent after request cleanup and protects its immutable lineage', () => {
        const ledger = source.slice(
            source.indexOf('CREATE TABLE public.analysis_revenue_run_ledgers'),
            source.indexOf('CREATE TABLE public.analysis_result_share_observations')
        );
        expect(ledger).toMatch(/request_id UUID PRIMARY KEY(?!\s+REFERENCES)/);
        expect(ledger).not.toContain('fresh_provenance JSONB');
        expect(source).toContain('analysis_revenue_run_ledger_lineage_immutable');
        expect(source).toContain('OLD.preflight_id IS DISTINCT FROM NEW.preflight_id');
        expect(source).toContain('OLD.request_started_at IS DISTINCT FROM NEW.request_started_at');
        expect(source).toContain('analysis_v2_result_image_manifests.request_id');
    });

    it('uses normalized, service-only, opaque Apify evidence with exact source locks', () => {
        expect(source).toContain('CREATE TABLE public.analysis_revenue_fresh_provider_evidence');
        expect(source).toContain('provider_run_hash VARCHAR(64) NOT NULL');
        expect(source).toContain('provider_dataset_hash VARCHAR(64)');
        expect(source).toContain("provider TEXT NOT NULL DEFAULT 'apify'");
        expect(source).toContain('record_analysis_revenue_fresh_provider_evidence_v1');
        expect(source).toContain('assert_analysis_revenue_fresh_provider_admission_v1');
        expect(source).toContain('bind_analysis_revenue_fresh_provider_dataset_v1');
        expect(source).toContain('read_analysis_revenue_fresh_provider_evidence_summary_v1');
        expect(source).toContain('FROM public.analysis_v2_provider_runs AS provider_run');
        expect(source).toContain('FOR UPDATE');
        expect(source).toContain("SET search_path = ''");
        expect(source).toContain('REVOKE ALL ON FUNCTION public.assert_analysis_revenue_fresh_provider_admission_v1');
        expect(source).toContain('GRANT EXECUTE ON FUNCTION public.assert_analysis_revenue_fresh_provider_admission_v1');
        expect(source).not.toContain('run_id TEXT');
        expect(source).not.toContain('dataset_id TEXT');
    });

    it('requires exact replay and only binds a previously-null dataset hash', () => {
        const record = source.slice(
            source.indexOf('CREATE OR REPLACE FUNCTION public.record_analysis_revenue_fresh_provider_evidence_v1'),
            source.indexOf('CREATE OR REPLACE FUNCTION public.bind_analysis_revenue_fresh_provider_dataset_v1')
        );
        const bind = source.slice(
            source.indexOf('CREATE OR REPLACE FUNCTION public.bind_analysis_revenue_fresh_provider_dataset_v1'),
            source.indexOf('CREATE OR REPLACE FUNCTION public.read_analysis_revenue_fresh_provider_evidence_summary_v1')
        );
        expect(record).toContain("RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT'");
        expect(record).toContain("'created', FALSE, 'replayed', TRUE");
        expect(bind).toContain('provider_dataset_hash IS NULL');
        expect(bind).toContain("RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT'");
    });

    it('allows the trusted direct profile checkpoint only from exact terminal Apify evidence', () => {
        const freshProfile = source.slice(
            source.indexOf('-- Trusted fresh Apify profile checkpoint.'),
            source.indexOf('CREATE TABLE public.analysis_result_share_observations')
        );
        expect(freshProfile).toContain('checkpoint_analysis_v2_profile_fresh_apify_v1');
        expect(freshProfile).toContain("attempt IN ('primary', 'fallback', 'repair', 'fresh_apify')");
        expect(freshProfile).toMatch(/fresh_apify'\) AND source = 'apify'/);
        expect(freshProfile).toContain('assert_analysis_revenue_fresh_provider_admission_v1');
        expect(freshProfile).toContain('provider_dataset_hash IS NULL');
        expect(freshProfile).toContain("v_provider.status IS DISTINCT FROM 'succeeded'");
        expect(freshProfile).toContain("MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH'");
        expect(freshProfile).toContain('REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1');
        expect(freshProfile).toContain('TO service_role');
    });
});
