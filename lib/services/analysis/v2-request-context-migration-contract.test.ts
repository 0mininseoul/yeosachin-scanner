import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713195941_add_analysis_v2_collection_request_context.sql',
        import.meta.url
    ),
    'utf8'
);
const policyMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260715103605_expose_v2_access_mode_to_collection_context.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 collection request context migration contract', () => {
    it('locks preflight, request, then job before refreshing the clock and checking the fence', () => {
        const ordered = [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'v_now := pg_catalog.clock_timestamp()',
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_job.lease_expires_at <= v_now',
        ];
        let previous = -1;
        for (const fragment of ordered) {
            const index = migration.indexOf(fragment, previous + 1);
            expect(index, fragment).toBeGreaterThan(previous);
            previous = index;
        }
    });

    it('returns only the bounded immutable collection snapshot and grants service_role only', () => {
        for (const key of [
            'targetUsername',
            'excludedUsername',
            'planId',
            'followersDeclaredCount',
            'followingDeclaredCount',
            'detailedMutualLimit',
        ]) expect(migration).toContain(`'${key}'`);
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.load_analysis_v2_collection_request_context('
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_request_context('
        );
        expect(migration).toContain('TO service_role');
        expect(migration).not.toContain('profile_image_url');
        expect(migration).not.toContain('target_bio');
    });

    it('adds only a service-bound immutable test policy to the collection snapshot', () => {
        for (const fragment of [
            'analysis_v2_provider_execution_policies',
            'consume_analysis_v2_authorized_test_entitlement',
            'load_analysis_v2_collection_context_with_policy',
            "v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'",
            "'accessMode', v_request.plan_access_mode_snapshot",
            "'providerExecutionPolicy'",
            'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH',
        ]) expect(policyMigration).toContain(fragment);
        expect(policyMigration).toContain(
            'ALTER TABLE public.analysis_v2_provider_execution_policies FORCE ROW LEVEL SECURITY'
        );
        expect(policyMigration).toContain(
            'REVOKE ALL ON TABLE public.analysis_v2_provider_execution_policies'
        );
        expect(policyMigration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_request_context('
        );
        expect(policyMigration).not.toMatch(/\bapi_token\s+(?:TEXT|VARCHAR)/i);
        expect(policyMigration).not.toMatch(/\bsecret_value\s+(?:TEXT|VARCHAR)/i);
    });
});
