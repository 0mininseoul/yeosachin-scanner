import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260714055611_fix_analysis_v2_fanout_conflict_target.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 fan-out conflict target correction', () => {
    it('targets the primary-key constraint without colliding with the request_id OUT parameter', () => {
        const definition = functionDefinition('complete_analysis_v2_job_and_fanout');

        expect(definition).toContain(
            'ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING'
        );
        expect(definition).not.toContain('ON CONFLICT (request_id, job_key)');
    });

    it('retains the lease fence, successor validation, and service-role boundary', () => {
        const definition = functionDefinition('complete_analysis_v2_job_and_fanout');

        expect(definition).toContain(
            'v_job.lease_token <> p_claim_token'
        );
        expect(definition).toContain(
            'ANALYSIS_V2_JOB_FANOUT_CONFLICT'
        );
        expect(definition).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.complete_analysis_v2_job_and_fanout\([\s\S]*?TO service_role;/
        );
    });
});
