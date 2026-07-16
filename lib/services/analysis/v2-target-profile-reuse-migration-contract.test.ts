import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationName = '20260716143000_reuse_fresh_admission_target_profile.sql';
const migration = readFileSync(
    new URL(`../../../supabase/migrations/${migrationName}`, import.meta.url),
    'utf8'
);

function functionBlock(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', migration.indexOf('AS $$', start));
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end + 4);
}

describe('reusable fresh-admission target profile migration', () => {
    it('runs after every existing migration and adds only a nullable schema-v1 marker', () => {
        const names = readdirSync(
            new URL('../../../supabase/migrations/', import.meta.url)
        ).filter(name => name.endsWith('.sql')).sort();
        expect(names.at(-1)).toBe(migrationName);
        expect(migration).toMatch(
            /ADD COLUMN reusable_profile_schema_version SMALLINT/
        );
        expect(migration).toMatch(
            /reusable_profile_schema_version IS NULL\s+OR reusable_profile_schema_version = 1/
        );
        expect(migration).not.toMatch(/profile_json|latest_posts|profile_payload/i);
    });

    it('attests only the exact succeeded fresh generation under its live claim', () => {
        const block = functionBlock(
            'mark_analysis_v2_fresh_admission_profile_run_reusable_v1'
        );
        for (const required of [
            "v_preflight.status IS DISTINCT FROM 'ready'",
            'v_preflight.consumed_request_id IS NOT NULL',
            'v_preflight.admission_generation IS DISTINCT FROM p_admission_generation',
            "v_preflight.admission_status IS DISTINCT FROM 'processing'",
            'v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token',
            'v_preflight.admission_lease_expires_at <= v_now',
            "'target-profile-fresh-admission:g' || p_admission_generation::TEXT",
            "v_run.status IS DISTINCT FROM 'succeeded'",
            'v_run.run_id IS DISTINCT FROM p_run_id',
            "v_run.logical_provider IS DISTINCT FROM 'apify'",
            "v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'",
            'v_run.max_charge_usd IS DISTINCT FROM 0.002600000000',
            'SET reusable_profile_schema_version = 1',
        ]) expect(block).toContain(required);
    });

    it('loads only the consumed matching target under the exact live target-evidence lease', () => {
        const block = functionBlock('load_analysis_v2_reusable_target_profile_run');
        for (const required of [
            "p_job_key IS DISTINCT FROM 'track:target-evidence:collect'",
            "v_request.pipeline_version IS DISTINCT FROM 'v2'",
            "v_request.status NOT IN ('pending', 'processing')",
            'v_request.preflight_id IS DISTINCT FROM v_preflight.id',
            "v_preflight.status IS DISTINCT FROM 'consumed'",
            'v_preflight.consumed_request_id IS DISTINCT FROM p_request_id',
            'v_preflight.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)',
            "v_preflight.admission_status IS DISTINCT FROM 'ready'",
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            "provider_run.operation_key = 'target-profile-fresh-admission:g'",
            "v_run.status IS DISTINCT FROM 'succeeded'",
            'v_run.run_id IS NULL',
            'v_run.reusable_profile_schema_version <> 1',
            "'runId', v_run.run_id",
            "'inputHash', v_run.input_hash",
            "'actorId', v_run.actor_id",
            "'credentialSlot', v_run.credential_slot",
            "'maxChargeUsd', v_run.max_charge_usd",
        ]) expect(block).toContain(required);
        expect(block).not.toContain("'operationKey'");
        expect(block).not.toContain("'profile'");
    });

    it('locks preflight, request, then job in the canonical terminal-capable order', () => {
        const block = functionBlock('load_analysis_v2_reusable_target_profile_run');
        const preflightLock = block.indexOf('SELECT preflight.*');
        const requestLock = block.indexOf('SELECT analysis_request.*');
        const jobLock = block.indexOf('SELECT job.*');
        const fenceCheck = block.indexOf('\n    IF v_preflight.id', jobLock);

        expect(preflightLock).toBeGreaterThanOrEqual(0);
        expect(requestLock).toBeGreaterThan(preflightLock);
        expect(jobLock).toBeGreaterThan(requestLock);
        expect(fenceCheck).toBeGreaterThan(jobLock);
        expect(block.slice(preflightLock, requestLock)).toContain(
            'preflight.consumed_request_id = p_request_id'
        );
        expect(block.slice(preflightLock, requestLock)).toContain('FOR UPDATE');
        expect(block.slice(requestLock, jobLock)).toContain('FOR UPDATE');
        expect(block.slice(jobLock, fenceCheck)).toContain('FOR UPDATE');
    });

    it('keeps both RPCs service-role-only', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.mark_analysis_v2_fresh_admission_profile_run_reusable_v1\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.mark_analysis_v2_fresh_admission_profile_run_reusable_v1\([\s\S]*?TO service_role/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_reusable_target_profile_run\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_reusable_target_profile_run\([\s\S]*?TO service_role/
        );
    });
});
