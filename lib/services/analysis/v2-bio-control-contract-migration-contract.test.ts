import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260717150000_allow_analysis_v2_multiline_bio.sql',
    import.meta.url
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

describe('analysis V2 multiline bio migration contract', () => {
    it('allows CR and LF in bio while retaining every other control-character fence', () => {
        expect(migration).toContain(
            'DROP CONSTRAINT analysis_v2_candidate_feature_text_check'
        );
        expect(migration).toContain(
            'ADD CONSTRAINT analysis_v2_candidate_feature_text_check CHECK'
        );
        expect(migration).toContain(
            'DROP CONSTRAINT analysis_v2_female_result_text_check'
        );
        expect(migration).toContain(
            'ADD CONSTRAINT analysis_v2_female_result_text_check CHECK'
        );
        expect(migration.match(/pg_catalog\.translate\(/g)).toHaveLength(3);
        expect(migration.match(/!~ '\[\[:cntrl:\]\]'/g)).toHaveLength(4);
    });

    it('rejects invalid names and bios before the candidate insert', () => {
        expect(migration).toContain(
            'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'
        );
        expect(migration).toContain("item.value->>'fullName' <> ''");
        expect(migration).toContain("item.value->>'fullName' ~ '[[:cntrl:]]'");
        expect(migration).toContain(
            "pg_catalog.char_length(item.value->>'bio') > 2200"
        );
        expect(migration).toContain('ANALYSIS_V2_BIO_CHECKPOINT_MIGRATION_DRIFT');
        expect(migration).toContain('pg_catalog.pg_get_functiondef');
        expect(migration).toContain(
            'pg_catalog.replace(v_definition, v_validation_old, v_validation_new)'
        );
    });
});
