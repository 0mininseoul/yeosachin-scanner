import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260717120000_fix_analysis_v2_checkpoint_contracts.sql',
    import.meta.url
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

describe('analysis V2 checkpoint contract correction migration', () => {
    it('separates relationship topology content hashes from private-name consumer job hashes', () => {
        expect(migration).toContain(
            'public.checkpoint_analysis_v2_private_names(uuid,text,uuid,text,integer,text,text,text,jsonb)'
        );
        expect(migration).toContain(
            "v_private_old TEXT := '      AND topology.input_hash = p_job_input_hash'"
        );
        expect(migration).toContain("v_private_new TEXT := ''");
        expect(migration).toContain('ANALYSIS_V2_PRIVATE_CHECKPOINT_MIGRATION_DRIFT');
        expect(migration).toContain(
            'pg_catalog.replace(v_definition, v_private_old, v_private_new)'
        );
    });

    it('requires media bundles only for verified-female candidate rows', () => {
        expect(migration).toContain(
            'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'
        );
        expect(migration).toContain(
            "item.value->>'classification' = 'verified_female'"
        );
        expect(migration).toContain('public.analysis_v2_media_artifacts AS artifact');
        expect(migration).toContain('ANALYSIS_V2_CANDIDATE_CHECKPOINT_MIGRATION_DRIFT');
        expect(migration).toContain(
            'pg_catalog.replace(v_definition, v_candidate_old, v_candidate_new)'
        );
    });

    it('guards both targeted replacements against missing or duplicated source predicates', () => {
        expect(migration.match(/pg_catalog\.pg_get_functiondef/g)).toHaveLength(2);
        expect(migration.match(/pg_catalog\.strpos\(v_definition/g)).toHaveLength(4);
        expect(migration.match(/pg_catalog\.char_length\(v_/g)).toHaveLength(2);
    });
});
