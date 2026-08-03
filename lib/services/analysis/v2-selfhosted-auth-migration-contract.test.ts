import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260803140000_add_authenticated_selfhosted_scraper_receipts.sql',
        import.meta.url
    ),
    'utf8'
);

describe('authenticated selfhosted V2 evidence migration contract', () => {
    it('adds a separate zero-cost receipt table without widening the paid provider ledger', () => {
        expect(migration).toContain('analysis_v2_selfhosted_auth_runs');
        expect(migration).toContain('checkpoint_analysis_v2_selfhosted_auth_run');
        expect(migration).toContain("provider = 'selfhosted_auth'");
        expect(migration).not.toContain('ALTER TABLE public.analysis_v2_provider_runs');
        expect(migration).not.toContain("logical_provider IN ('apify', 'coderx', 'selfhosted_auth')");
    });

    it('patches both relationship and interaction evidence loaders while preserving Apify paths', () => {
        expect(migration).toContain('SELFHOSTED_AUTH_RELATIONSHIP_LOADER_PATCH_MISMATCH');
        expect(migration).toContain('SELFHOSTED_AUTH_TARGET_LOADER_PATCH_MISMATCH');
        expect(migration).toContain('analysis_v2_load_provider_evidence_source');
        expect(migration).toContain("p_provider = 'selfhosted_auth'");
        expect(migration).toContain("p_source->>'provider' = 'selfhosted_auth'");
    });

    it('admits authenticated-worker telemetry without widening the paid-run ledger', () => {
        expect(migration).toContain('ALTER TABLE public.scraper_provider_usage');
        expect(migration).toContain('selfhosted_auth');
        expect(migration).not.toContain(
            'ALTER TABLE public.analysis_v2_provider_runs\n    DROP CONSTRAINT'
        );
    });

    it('admits a claim-fenced reverse-like receipt without adding it to target evidence', () => {
        expect(migration).toContain("'track:reverse-likes:collect'");
        expect(migration).toContain('candidate-likers');
        expect(migration).toContain(
            "p_job_key = 'track:reverse-likes:collect'"
        );
    });

    it('stores only bounded JSONB items and exposes a separately claim-fenced resume RPC', () => {
        expect(migration).toContain('items JSONB NOT NULL');
        expect(migration).toContain('jsonb_typeof(items) = \'array\'');
        expect(migration).toContain('load_analysis_v2_selfhosted_auth_run');
        expect(migration).toContain('ANALYSIS_V2_SELFHOSTED_AUTH_RUN_CONFLICT');
        expect(migration).not.toContain('analysis_v2_provider_runs ADD COLUMN items');
    });
});
