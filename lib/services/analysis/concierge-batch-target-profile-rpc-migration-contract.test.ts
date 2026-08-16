import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260816155700_list_concierge_batch_target_profile_artifacts.sql', import.meta.url),
    'utf8',
);

describe('concierge batch target-profile artifact RPC migration contract', () => {
    it('keeps the provider ledger RPC-only and bounded to succeeded target-profile identities', () => {
        expect(migration).toContain('CREATE FUNCTION public.list_concierge_batch_target_profile_artifacts(');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("provider_run.status = 'succeeded'");
        expect(migration).toContain("provider_run.operation_key LIKE 'target-profile%'");
        expect(migration).toContain('LIMIT 8');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.list_concierge_batch_target_profile_artifacts(UUID)');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.list_concierge_batch_target_profile_artifacts(UUID)');
        expect(migration).toContain('TO service_role');
        expect(migration).not.toContain('GRANT SELECT ON TABLE public.analysis_preflight_provider_runs');
    });
});
