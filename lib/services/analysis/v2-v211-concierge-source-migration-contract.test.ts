import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260808270000_add_v211_concierge_recovery_source.sql',
        import.meta.url,
    ),
    'utf8',
);

describe('v2.11 first-payment concierge recovery source migration', () => {
    it('exposes only the exact incident ledger and retained AI payloads', () => {
        expect(migration).toContain(
            'CREATE FUNCTION public.read_earlybird_v211_concierge_recovery_source()',
        );
        expect(migration).toContain('LANGUAGE plpgsql');
        expect(migration).toContain('STABLE');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain(
            'FROM public.earlybird_v211_apify_transient_replays AS replay',
        );
        expect(migration).toContain(
            'JOIN public.earlybird_fulfillments AS fulfillment',
        );
        expect(migration).toContain("current_request.error_message = 'SCRAPING_INCOMPLETE_ERROR'");
        expect(migration).toContain("receipt.failed_job_key = 'track:relationships:collect'");
        expect(migration).toContain("receipt.error_code = 'SCRAPING_INCOMPLETE_ERROR'");
        expect(migration).toContain('JOIN public.analysis_preflight_provider_runs AS run');
        expect(migration).toContain('JOIN public.analysis_v2_provider_runs AS run');
        expect(migration).toContain('FROM public.analysis_v2_scheduler_operations AS operation');
        expect(migration).toContain("operation.status = 'ready'");
        expect(migration).toContain('operation.result_json IS NOT NULL');
        expect(migration).not.toContain("'userId'");
        expect(migration).not.toContain("'targetInstagramId'");
        expect(migration).not.toContain('earlybird_order.target_instagram_id');
    });

    it('keeps the source service-role-only and read-only', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.read_earlybird_v211_concierge_recovery_source\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.read_earlybird_v211_concierge_recovery_source\(\)[\s\S]*?TO service_role;/,
        );
        expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\./i);
    });
});
