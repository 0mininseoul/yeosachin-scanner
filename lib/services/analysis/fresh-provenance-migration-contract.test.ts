import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publishedMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql', import.meta.url),
    'utf8',
);
const hardeningMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);

function functionSection(name: string, nextName: string): string {
    const start = hardeningMigration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const end = hardeningMigration.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start);
    expect(start, `missing ${name}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing successor for ${name}`).toBeGreaterThan(start);
    return hardeningMigration.slice(start, end);
}

describe('fresh revenue provenance migration contract', () => {
    it('keeps the published migration byte-for-byte and moves all fresh evidence forward', () => {
        expect(createHash('sha256').update(publishedMigration, 'utf8').digest('hex'))
            .toBe('449455fa1d3c59bb60522f6f379aa521e32cfb171f6dcc3c329c344807a09dda');
        expect(hardeningMigration).toContain('DROP CONSTRAINT analysis_revenue_run_ledgers_request_id_fkey');
        expect(hardeningMigration).toContain('DROP COLUMN fresh_provenance');
        expect(hardeningMigration).toContain('CREATE TABLE public.analysis_revenue_fresh_provider_evidence');
        expect(hardeningMigration).toContain('analysis_revenue_run_ledger_lineage_immutable');
    });

    it('uses normalized, service-only, opaque Apify evidence with the exact fresh operation family', () => {
        expect(hardeningMigration).toContain('provider_run_hash VARCHAR(64) NOT NULL');
        expect(hardeningMigration).toContain('provider_dataset_hash VARCHAR(64)');
        expect(hardeningMigration).toContain("provider TEXT NOT NULL DEFAULT 'apify'");
        expect(hardeningMigration).toContain('record_analysis_revenue_fresh_provider_evidence_v1');
        expect(hardeningMigration).toContain('assert_analysis_revenue_fresh_provider_admission_v1');
        expect(hardeningMigration).toContain('bind_analysis_revenue_fresh_provider_dataset_v1');
        expect(hardeningMigration).toContain(
            '^(target-profile|profile-fallback|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$',
        );
        expect(hardeningMigration).not.toContain("'profile-repair'");
        expect(hardeningMigration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.analysis_revenue_run_ledgers FROM service_role');
        expect(hardeningMigration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.analysis_revenue_fresh_provider_evidence FROM service_role');
        expect(hardeningMigration).toContain('analysis_revenue_fresh_provider_evidence_immutable');
        expect(hardeningMigration).not.toContain('run_id TEXT');
        expect(hardeningMigration).not.toContain('dataset_id TEXT');
    });

    it('requires exact replay and a terminal succeeded source before one-way Dataset binding', () => {
        const record = functionSection(
            'record_analysis_revenue_fresh_provider_evidence_v1',
            'bind_analysis_revenue_fresh_provider_dataset_v1',
        );
        const bind = functionSection(
            'bind_analysis_revenue_fresh_provider_dataset_v1',
            'analysis_v2_profile_checkpoint_snapshot',
        );
        expect(record).toContain("RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT'");
        expect(record).toContain("'created', FALSE, 'replayed', TRUE");
        expect(bind).toContain('provider_dataset_hash IS NULL');
        expect(bind).toContain("v_provider.status IS DISTINCT FROM 'succeeded'");
        expect(bind).toContain("RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH'");
    });

    it('allows the trusted direct profile checkpoint only from exact terminal Apify evidence', () => {
        const freshProfile = functionSection(
            'checkpoint_analysis_v2_profile_fresh_apify_v1',
            'assert_analysis_revenue_dispatch_guard_v1',
        );
        expect(hardeningMigration).toContain("attempt IN ('primary', 'fallback', 'repair', 'fresh_apify')");
        expect(freshProfile).toMatch(/fresh_apify' AND outcome\.source = 'apify'/);
        expect(freshProfile).toContain('assert_analysis_revenue_fresh_provider_admission_v1');
        expect(freshProfile).toContain('provider_dataset_hash IS NULL');
        expect(freshProfile).toContain("v_provider.status IS DISTINCT FROM 'succeeded'");
        expect(freshProfile).toContain("MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH'");
        expect(freshProfile).toContain('REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1');
        expect(freshProfile).toContain('TO service_role');
    });
});
