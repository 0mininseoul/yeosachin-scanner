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
        expect(stageMigration).toContain('CHECK (slot BETWEEN 1 AND 8)');
    });

    it('quarantines cutoff and permits only fenced SDK completion or TTL reaping', () => {
        const cutoff = functionDefinition(
            stageMigration,
            'cutoff_analysis_v2_gemini_lease_v2'
        );
        const release = functionDefinition(
            stageMigration,
            'release_analysis_v2_gemini_lease_v2'
        );
        const reap = functionDefinition(
            stageMigration,
            'reap_analysis_v2_gemini_cutoff_leases_v2'
        );
        expect(cutoff).toContain("SET state = 'quarantined'");
        for (const definition of [cutoff, release]) {
            expect(definition).toContain('lease.lease_claim_token = p_claim_token');
            expect(definition).toContain('lease.fence = p_fence');
            expect(definition).toContain('lease.operation_key = p_operation_key');
        }
        expect(reap).toContain("lease.stage = 'genderResolution'");
        expect(reap).toContain('lease.expires_at <= v_now');
    });

    it('persists resolver provenance and strips failure aggregates from owner summary', () => {
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
            expect(summary).not.toContain(externalField);
        }
        expect(summary).toContain("'genderStats'");
    });
});
