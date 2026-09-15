import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260717160000_allow_analysis_v2_rate_limit_exhaustion_fallback.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 rate-limit fallback migration contract', () => {
    it('accepts only response rejection or exact terminal four-attempt exhaustion', () => {
        const helper = functionDefinition('analysis_v2_ai_fallback_evidence_matches');

        expect(helper).toContain("rejected_attempt.status = 'response_rejected'");
        expect(helper).toContain('pg_catalog.count(*) = 4');
        expect(helper).toContain('pg_catalog.count(DISTINCT exhausted_attempt.attempt) = 4');
        expect(helper).toContain('pg_catalog.min(exhausted_attempt.attempt) = 1');
        expect(helper).toContain('pg_catalog.max(exhausted_attempt.attempt) = 4');
        expect(helper).toContain("exhausted_attempt.status = 'rate_limited'");
        expect(helper).toContain('exhausted_attempt.terminalized_at IS NOT NULL');
        expect(helper).toContain(
            'exhausted_attempt.retry_count = exhausted_attempt.attempt - 1'
        );
        expect(helper).toContain('pg_catalog.count(DISTINCT ROW(');
    });

    it('patches all three deterministic fallback persistence gates', () => {
        for (const signature of [
            'checkpoint_analysis_v2_private_names(uuid,text,uuid,text,integer,text,text,text,jsonb)',
            'checkpoint_analysis_v2_narratives(uuid,text,uuid,text,jsonb)',
            'analysis_v2_result_partner_safety_row_matches(uuid,text,jsonb)',
        ]) {
            expect(migration).toContain(`public.${signature}`);
        }
        expect(migration.match(/analysis_v2_ai_fallback_evidence_matches\(/g)).toHaveLength(6);
        expect(migration).toContain("'privateAccountName'");
        expect(migration).toContain("'highRiskNarrative'");
        expect(migration).toContain("'partnerSafety'");
    });

    it('keeps the evidence helper private to trusted database routines', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_ai_fallback_evidence_matches\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_ai_fallback_evidence_matches/
        );
        expect(functionDefinition('analysis_v2_ai_fallback_evidence_matches')).toContain(
            "SET search_path = ''"
        );
    });
});
