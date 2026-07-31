import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731090000_adopt_capacity_safe_relationship_provider_runs.sql',
        import.meta.url
    ),
    'utf8'
);
const relationshipProvider = readFileSync(
    new URL('../instagram/providers/apify.ts', import.meta.url),
    'utf8'
);

describe('capacity-safe relationship provider-run adoption migration', () => {
    it('separates destination and immutable source identities', () => {
        expect(migration).toContain('ADD COLUMN source_operation_key');
        expect(migration).toContain('ADD COLUMN destination_input_hash');
        expect(migration).toContain(
            'source_request_id, source_job_key, source_operation_key, source_run_id'
        );
        expect(migration).toContain(
            'request_id, job_key, operation_key, run_id'
        );
        expect(migration).toContain(
            'adoption.destination_input_hash = p_input_hash'
        );
        expect(migration).toContain(
            'provider_run.operation_key = adoption.source_operation_key'
        );
    });

    it('validates current identity and uses a deterministic old-count witness when retained', () => {
        expect(migration).toContain(
            'CREATE FUNCTION public.analysis_v2_relationship_provider_identity'
        );
        expect(migration).toContain(
            'v_current.target_followers_count'
        );
        expect(migration).toContain('v_order.target_followers_count');
        expect(migration).toContain(
            'v_current_operation = p_operation_key'
        );
        expect(migration).toContain(
            'v_current_input = p_input_hash'
        );
        expect(migration).not.toMatch(/LIKE\s+['"]relationship-/iu);
    });

    it('uses the immutable paid-order count when retained admission counts are scrubbed', () => {
        expect(migration).toContain(
            'The paid order freezes the old/source counts'
        );
        expect(migration).not.toContain(
            'v_recovery_preflight.admission_target_followers_count'
        );
        expect(migration).not.toMatch(/operation_key\s+LIKE/iu);
    });

    it('keeps exact and non-relationship paths unchanged', () => {
        expect(migration).toContain(
            'ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run'
        );
        expect(migration).toContain(
            'public.resolve_analysis_v2_exact_recovery_provider_run('
        );
        expect(migration).toContain(
            "p_job_key <> 'track:relationships:collect'"
        );
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE'
        );
    });

    it('pins the same relationship actor as the runtime', () => {
        const actor = relationshipProvider.match(
            /APIFY_RELATIONSHIP_ACTOR_ID\s*=\s*\n?\s*'([^']+)'/
        )?.[1];
        expect(actor).toBe(
            'scraping_solutions/instagram-scraper-followers-following-no-cookies'
        );
        expect(migration).toContain(`'${actor}'`);
    });

    it('requires an immutable initial checkpoint before replacement adoption', () => {
        expect(migration).toContain(
            'IF v_replacement THEN'
        );
        expect(migration).toContain('v_initial_source_operation');
        expect(migration).toContain("initial_run.status = 'succeeded'");
        expect(migration).toContain(
            'initial_run.usage_reconciled_at IS NOT NULL'
        );
    });
});
