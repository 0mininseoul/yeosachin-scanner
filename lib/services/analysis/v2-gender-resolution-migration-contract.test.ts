import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stageMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260725010000_add_analysis_v2_gender_resolution_stage.sql',
        import.meta.url
    ),
    'utf8'
);
const provenanceMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260725013000_persist_analysis_v2_gender_resolution_provenance.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(migration: string, name: string): string {
    const marker = new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\(`
    ).exec(migration);
    expect(marker, `${name} must exist`).not.toBeNull();
    const start = marker!.index;
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('gender resolution forward migration contract', () => {
    it('pins both forward migrations after the paid-price predecessor', () => {
        for (const migration of [stageMigration, provenanceMigration]) {
            expect(migration).toContain('MIGRATION_PREDECESSOR=20260724230000');
            expect(migration).toContain("version = '20260724230000'");
            expect(migration).toContain('ANALYSIS_V2_GENDER_RESOLUTION_PREDECESSOR_MISSING');
        }
    });

    it('adds resolver stage identity while keeping its cache request-scoped', () => {
        expect(stageMigration).toContain("'genderResolution'");
        expect(stageMigration).toContain("'gender-resolution:'");
        expect(stageMigration).toContain("'cutoff'");
        expect(stageMigration).toContain(
            'analysis_v2_ai_attempt_status_check'
        );
        expect(stageMigration).toContain(
            'analysis_v2_ai_result_checkpoint_stage_check'
        );
        expect(functionDefinition(
            stageMigration,
            'analysis_v2_valid_ai_result_identity'
        )).toContain("p_identity->>'cache_scope' = 'request'");
    });

    it('uses operation-aware v2 admission with resolver two and shared eight limits', () => {
        const acquire = functionDefinition(
            stageMigration,
            'acquire_analysis_v2_gemini_lease_v2'
        );
        expect(acquire).toContain('p_operation_key');
        expect(acquire).toContain('p_stage');
        expect(acquire).toContain("lease.stage = 'genderResolution'");
        expect(acquire).toContain('v_resolver_count >= 2');
        expect(acquire).toContain("'resolver_capacity_pending'::TEXT");
        expect(acquire).toContain('pg_advisory_xact_lock');
        expect(acquire).toContain("lease.state = 'quarantined'");
        expect(acquire).toContain('lease.expires_at <= v_now');
        expect(acquire).toContain("SET state = 'available'");
        expect(acquire).toMatch(
            /SET state = 'available',[\s\S]+?WHERE lease\.state = 'quarantined'\s+AND lease\.stage = 'genderResolution'\s+AND lease\.expires_at <= v_now/
        );
        expect(acquire).toContain('NOT EXISTS');
        expect(acquire).toContain("ai_attempt.status = 'reserved'");
        expect(stageMigration).toContain('CHECK (slot BETWEEN 1 AND 8)');
    });

    it('quarantines cutoff and permits only fenced SDK completion or TTL reaping', () => {
        const legacyCutoff = functionDefinition(
            stageMigration,
            'cutoff_analysis_v2_gemini_lease_v2'
        );
        const atomicCutoff = functionDefinition(
            stageMigration,
            'cutoff_analysis_v2_gender_resolution_attempt'
        );
        const release = functionDefinition(
            stageMigration,
            'release_analysis_v2_gemini_lease_v2'
        );
        const reap = functionDefinition(
            stageMigration,
            'reap_analysis_v2_gemini_cutoff_leases_v2'
        );
        const recover = functionDefinition(
            stageMigration,
            'recover_analysis_v2_gender_resolution_cutoffs'
        );
        expect(legacyCutoff).toContain("SET state = 'quarantined'");
        expect(atomicCutoff).toContain(
            'public.analysis_v2_terminalize_ai_attempt_internal'
        );
        expect(atomicCutoff).toContain("'cutoff'");
        expect(atomicCutoff).toContain("SET state = 'quarantined'");
        expect(atomicCutoff).toContain("'already_terminal'");
        expect(atomicCutoff).toContain('pg_advisory_xact_lock');
        for (const definition of [legacyCutoff, release]) {
            expect(definition).toContain('lease.lease_claim_token = p_claim_token');
            expect(definition).toContain('lease.fence = p_fence');
            expect(definition).toContain('lease.operation_key = p_operation_key');
        }
        expect(atomicCutoff).toContain(
            'lease.lease_claim_token = p_lease_claim_token'
        );
        expect(atomicCutoff).toContain('lease.fence = p_lease_fence');
        expect(atomicCutoff).toContain('lease.operation_key = p_operation_key');
        expect(reap).toContain("lease.stage = 'genderResolution'");
        expect(reap).toContain('lease.expires_at <= v_now');
        expect(reap).toContain('NOT EXISTS');
        expect(recover).toContain("attempt.status = 'reserved'");
        expect(recover).toContain(
            'public.cutoff_analysis_v2_gender_resolution_attempt'
        );
    });

    it('persists resolver provenance and keeps rolling internal summary compatibility', () => {
        for (const field of [
            'baseline_classification',
            'classification_source',
            'gender_resolution_status',
            'gender_resolution_operation_key',
            'gender_resolution_result_hash',
        ]) {
            expect(provenanceMigration).toContain(field);
        }
        expect(provenanceMigration).toContain(
            'analysis_v2_gender_resolution_metrics'
        );
        const summary = functionDefinition(
            provenanceMigration,
            'analysis_v2_result_summary_json'
        );
        for (const externalField of [
            'successfullyScreenedMutuals',
            'fetchUnavailableMutuals',
            'mediaUnavailableMutuals',
            'analysisUnavailableMutuals',
        ]) {
            expect(summary).toContain(`'${externalField}'`);
        }
        expect(summary).toContain("'genderStats'");
    });

    it('exposes only durable aggregate resolver quality to the service role', () => {
        const seal = functionDefinition(
            provenanceMigration,
            'analysis_v2_seal_gender_resolution_metrics'
        );
        const quality = functionDefinition(
            provenanceMigration,
            'load_analysis_v2_gender_resolution_quality'
        );
        expect(provenanceMigration).toContain('applied_with_fenced_result_count');
        expect(provenanceMigration).toContain('verified_baseline_mutation_count');
        expect(provenanceMigration).toContain('resolver_estimated_cost_usd');
        expect(provenanceMigration).toContain(
            'resolver_nonterminal_attempt_count'
        );
        expect(provenanceMigration).toContain('metrics_finalized_at');
        expect(seal).toContain("attempt.status = 'reserved'");
        expect(seal).toContain("'ANALYSIS_V2_RESULT_NOT_READY'");
        expect(seal).toContain('ON CONFLICT (request_id) DO UPDATE');
        expect(seal).toContain('v_features.cutoff_count');
        expect(seal).toContain('v_features.terminal_unavailable_count');
        expect(provenanceMigration).toContain(
            'CREATE TRIGGER seal_analysis_v2_gender_resolution_metrics'
        );
        expect(provenanceMigration).toContain(
            'BEFORE INSERT\nON public.analysis_v2_result_summaries'
        );
        expect(quality).toContain('analysis_v2_gender_resolution_metrics');
        expect(quality).toContain("'unknownGatePassed'");
        expect(quality).toContain("'provenanceGatePassed'");
        expect(quality).toContain("'immutabilityGatePassed'");
        expect(quality).toContain('public.analysis_requests');
        expect(quality).toContain("status = 'completed'");
        expect(quality).toContain("selected_plan_id_snapshot = 'standard'");
        expect(quality).toContain('public.analysis_v2_result_summaries');
        expect(quality).toContain("plan_id = 'standard'");
        expect(quality).toContain("'requestGatePassed'");
        expect(quality).toContain("'allResolverAttemptsTerminal'");
        expect(quality).toContain("'metricsFinalized'");
        expect(quality).toContain("'metricsFresh'");
        expect(quality).toContain("'resolverConcurrencyLimit', 2");
        expect(quality).toContain("'sharedConcurrencyLimit', 8");
        expect(provenanceMigration).toContain(
            'GRANT EXECUTE ON FUNCTION public.load_analysis_v2_gender_resolution_quality(UUID)'
        );
        expect(provenanceMigration).toContain(
            'FROM PUBLIC, anon, authenticated, service_role'
        );
    });
});
