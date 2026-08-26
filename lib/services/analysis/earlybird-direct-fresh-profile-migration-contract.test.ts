import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = readdirSync(migrationsUrl).find(name => (
    name.endsWith('_earlybird_direct_fresh_apify_checkpoint.sql')
));
const migration = migrationName
    ? readFileSync(new URL(migrationName, migrationsUrl), 'utf8')
    : '';

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('Earlybird direct fresh-Apify checkpoint migration contract', () => {
    it('creates only the service-role Earlybird RPC with the exact signature and definer fence', () => {
        const rpc = functionDefinition('checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1');
        expect(migration).toMatch(
            /checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1\(\s*UUID,\s*TEXT,\s*UUID,\s*TEXT,\s*TEXT\[\],\s*JSONB,\s*TEXT,\s*TEXT\s*\)/
        );
        expect(rpc).toContain('RETURNS JSONB');
        expect(rpc).toContain('SECURITY DEFINER');
        expect(rpc).toContain("SET search_path = ''");
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1\([\s\S]*?TO service_role/);
        expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1\([\s\S]*?TO (PUBLIC|anon|authenticated)/);
    });

    it('locks and proves the paid Earlybird order lineage before the current provider row and batch', () => {
        const rpc = functionDefinition('checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1');
        expectInOrder(rpc, [
            'FROM public.earlybird_fulfillments',
            'FROM public.earlybird_orders',
            'FROM public.earlybird_fulfillments',
            'FROM public.analysis_preflights',
            'FROM public.analysis_requests',
            'FROM public.analysis_pipeline_jobs',
            'FROM public.analysis_v2_provider_runs',
            'FROM public.analysis_v2_profile_fetch_batches',
        ]);
        for (const fragment of [
            "v_order.status IS DISTINCT FROM 'analysis_in_progress'",
            "v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress'",
            'v_fulfillment.manual_review_at IS NOT NULL',
            'v_order.payment_id IS NULL',
            'v_order.paid_at IS NULL',
            'v_order.seller_reference_confirmed_at IS NULL',
            'v_order.actual_amount_krw < 0',
            'v_order.actual_amount_krw > v_order.expected_amount_krw',
            'v_order.actual_groble_product_id IS DISTINCT FROM v_order.expected_groble_product_id',
            'v_order.target_followers_count IS DISTINCT FROM v_preflight.target_followers_count',
            'v_order.target_following_count IS DISTINCT FROM v_preflight.target_following_count',
            'v_preflight.capacity_required_plan_id IS DISTINCT FROM v_request.capacity_required_plan_id_snapshot',
            'v_preflight.required_plan_id IS DISTINCT FROM v_request.required_plan_id_snapshot',
            "v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'",
            "v_request.analysis_entry_channel IS DISTINCT FROM 'standard'",
            'v_request.test_entitlement_jti_hash IS NOT NULL',
            'v_order.concierge_apify_credential_slot IS DISTINCT FROM \'secondary\'',
            'v_preflight.order_scoped_apify_credential_slot IS DISTINCT FROM \'secondary\'',
            'analysis_v2_provider_execution_policies',
            'analysis_v2_test_entitlement_consumptions',
            'analysis_revenue_run_ledgers',
        ]) {
            expect(rpc, fragment).toContain(fragment);
        }
    });

    it('pins target and profile-batch job/provider identities and rejects adoption or drift', () => {
        const rpc = functionDefinition('checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1');
        for (const fragment of [
            "track:target-evidence:collect",
            "track:profiles:batch:",
            "target-profile:[a-f0-9]{64}",
            "profile-fallback:[a-f0-9]{64}",
            "v_job.track IS DISTINCT FROM 'target_evidence'",
            "v_job.kind IS DISTINCT FROM 'collection'",
            "v_job.track IS DISTINCT FROM 'profiles'",
            "v_job.kind IS DISTINCT FROM 'profile_fetch'",
            "v_provider.logical_provider IS DISTINCT FROM 'apify'",
            "v_provider.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'",
            "v_provider.credential_slot IS DISTINCT FROM 'secondary'",
            "v_provider.status IS DISTINCT FROM 'succeeded'",
            'v_provider.run_id IS NULL',
            'v_provider.run_started_at IS NULL',
            'v_provider.terminalized_at IS NULL',
            'v_provider.usage_reconciled_at',
        ]) {
            expect(rpc, fragment).toContain(fragment);
        }
    });

    it('uses the strict bounded payload hash/frozen set and exact replay with no fallback or repair rows', () => {
        const rpc = functionDefinition('checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1');
        expectInOrder(rpc, [
            'analysis_v2_valid_profile_username_list',
            'analysis_v2_valid_profile_outcomes',
            "'requested_usernames'",
            "'outcomes'",
            'v_unresolved',
            'primary_payload_hash',
            "'fresh_apify'",
            'INSERT INTO public.analysis_v2_profile_fetch_outcomes',
            'analysis_v2_profile_checkpoint_snapshot',
        ]);
        for (const fragment of [
            "v_batch.fallback_completed_at IS NOT NULL",
            "v_batch.repair_completed_at IS NOT NULL",
            "outcome.attempt IN ('fallback', 'repair')",
            "outcome.attempt <> 'fresh_apify'",
            'v_existing_fresh_count',
            'ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT',
        ]) {
            expect(rpc, fragment).toContain(fragment);
        }
        expect(rpc).toContain('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH');
    });

    it('widens fresh telemetry and preserves trigger behavior while selecting fresh terminal rows', () => {
        expect(migration).toContain(
            "source IN ('cache', 'selfhosted', 'fallback', 'repair', 'fresh_apify')"
        );
        const telemetry = functionDefinition('capture_analysis_v2_profile_fetch_telemetry');
        expectInOrder(telemetry, [
            "WHEN NEW.attempt = 'fresh_apify' THEN 'fresh_apify'",
            "WHEN NEW.attempt = 'fallback' THEN 'fallback'",
            "WHEN NEW.attempt = 'repair' THEN 'repair'",
            'ELSE NEW.source',
            'ON CONFLICT',
        ]);
        const selector = functionDefinition('analysis_v2_profile_terminal_attempt');
        expectInOrder(selector, [
            "outcome.attempt = 'repair'",
            "outcome.attempt = 'fresh_apify'",
            "p_username = ANY(p_frozen)",
            "ELSE 'primary'",
        ]);
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1(');
    });
});
