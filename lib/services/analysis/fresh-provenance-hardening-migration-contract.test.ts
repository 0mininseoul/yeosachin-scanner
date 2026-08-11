import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const historicalMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql', import.meta.url),
    'utf8',
);
const hardeningMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);

describe('fresh provenance forward hardening migration contract', () => {
    it('preserves the published revenue migration byte-for-byte and moves fresh provenance forward', () => {
        expect(createHash('sha256').update(historicalMigration, 'utf8').digest('hex'))
            .toBe('449455fa1d3c59bb60522f6f379aa521e32cfb171f6dcc3c329c344807a09dda');
        expect(hardeningMigration).toContain('ALTER TABLE public.analysis_revenue_run_ledgers');
        expect(hardeningMigration).toContain('DROP CONSTRAINT analysis_revenue_run_ledgers_request_id_fkey');
        expect(hardeningMigration).toContain('DROP COLUMN fresh_provenance');
        expect(hardeningMigration).toContain('CREATE TABLE public.analysis_revenue_fresh_provider_evidence');
    });

    it('uses RPC-only immutable fresh evidence and an exact fresh operation family', () => {
        expect(hardeningMigration).toContain('analysis_revenue_valid_fresh_provider_operation_key_v1');
        expect(hardeningMigration).toContain(
            '^(target-profile|profile-fallback|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$'
        );
        expect(hardeningMigration).not.toContain("'profile-repair'");
        expect(hardeningMigration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.analysis_revenue_run_ledgers FROM service_role');
        expect(hardeningMigration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.analysis_revenue_fresh_provider_evidence FROM service_role');
        expect(hardeningMigration).toContain("SET search_path = ''");
        expect(hardeningMigration).toContain('analysis_revenue_run_ledger_lineage_immutable');
        expect(hardeningMigration).toContain('analysis_revenue_fresh_provider_evidence_immutable');
        expect(hardeningMigration).toContain('reject_analysis_revenue_fresh_provider_evidence_mutation');
    });

    it('requires a terminal succeeded source before dataset binding and preserves canonical locks', () => {
        const bind = hardeningMigration.slice(
            hardeningMigration.indexOf('CREATE OR REPLACE FUNCTION public.bind_analysis_revenue_fresh_provider_dataset_v1'),
            hardeningMigration.indexOf('CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1'),
        );
        expect(bind).toContain("v_provider.status IS DISTINCT FROM 'succeeded'");
        expect(bind).toContain('preflight → request → job → provider/source → revenue parent');
        expect(bind).toContain('FRESH_PROVENANCE_NOT_FRESH');
    });
});
