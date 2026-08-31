import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260831100000_add_analysis_provider_admission_leases.sql',
    import.meta.url,
), 'utf8');
const capacityMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260831100000_add_analysis_provider_admission_leases.sql',
    import.meta.url,
), 'utf8');

function capacityFunctionDefinition(name: string): string {
    const start = capacityMigration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = capacityMigration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return capacityMigration.slice(start, end);
}

describe('provider admission migration contract', () => {
    it('defines fenced global budgets, restrictive ACLs, and hot-path indexes', () => {
        expect(migration).toContain('analysis_provider_admission_budgets');
        expect(migration).toContain('analysis_provider_admission_leases');
        expect(migration).toContain('acquire_analysis_provider_admission');
        expect(migration).toContain('renew_analysis_provider_admission');
        expect(migration).toContain('release_analysis_provider_admission');
        expect(migration).toContain('recover_expired_analysis_provider_admission');
        expect(migration).toContain('resolve_analysis_provider_admission');
        expect(migration).toContain('assert_analysis_provider_admission_claim');
        expect(migration).toContain("state IN ('leased', 'recovery_required')");
        expect(migration).not.toContain("state <> 'released'");
        expect(migration).toContain("WHERE lease.state IN ('leased', 'recovery_required')");
        expect(migration).toContain("v_ledger_state = 'running'");
        expect(migration).toContain("p_lease.claim_token IS NOT DISTINCT FROM p_provider_claim_token");
        expect(migration).toContain("p_lease.job_claim_token IS NOT DISTINCT FROM p_job_claim_token");
        expect(migration).toContain('job_claim_token UUID NOT NULL');
        expect(migration).toContain('p_job_claim_token UUID');
        expect(migration).toContain('p_provider_claim_token UUID');
        expect(migration).toContain('p_provider_fence BIGINT');
        expect(migration).toContain('provider_fence BIGINT');
        expect(migration).toContain('v_gemini_lease.lease_claim_token IS DISTINCT FROM p_provider_claim_token');
        expect(migration).toContain('list_expired_analysis_provider_admissions');
        expect(migration).toContain('p_limit INTEGER DEFAULT 64');
        expect(migration).toContain("'hasMore', (SELECT overflow.has_more FROM overflow)");
        expect(migration).toContain("'nextCursor'");
        expect(migration).toContain('SET search_path = \'\'');
        expect(migration).toContain('REVOKE ALL ON TABLE public.analysis_provider_admission_leases');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.acquire_analysis_provider_admission');
        expect(migration).toMatch(/CREATE INDEX[\s\S]+analysis_provider_admission_leases[\s\S]+expires_at/);
        expect(migration).toContain("'preflight:apify:global'");
        expect(migration).toContain("'paid:apify:global'");
        expect(migration).toContain("'paid:apify:secondary'");
        expect(migration).toContain("p_credential_slot NOT IN ('primary', 'quinary', 'senary')");
        expect(migration).toContain("p_credential_slot <> 'secondary'");
        expect(migration).toContain("'paid:apify:septenary'");
        expect(migration).toContain("'paid:apify:tenth'");
        expect(migration).toContain('ANALYSIS_PROVIDER_ADMISSION_BUDGET_DRIFT');
        expect(migration).toContain('list_analysis_preflight_dispatch_recovery_v2');
        expect(migration).toContain('list_precheckout_blite_dispatch_recovery_v2');
        expect(migration).toContain('list_analysis_v2_preflight_admission_dispatch_recovery_v2');
        expect(migration).toContain('dispatch_reserved_at <= v_now - INTERVAL \'30 seconds\'');
        expect(migration).not.toContain('release_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2');
        expect(migration).toContain("dispatch_state = 'reserved'");
        expect(migration).toContain("dispatch_token = NULL");
        expect(migration).toContain('last_dispatch_token = p_dispatch_token');
        expect(migration).toContain("release_reason IN ('terminal', 'prestart_rejected', 'ledger_resolved')");
        expect(migration).toContain('p_release_reason TEXT DEFAULT \'terminal\'');
        const renewStart = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.renew_analysis_provider_admission',
        );
        const releaseStart = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.release_analysis_provider_admission',
        );
        expect(renewStart).toBeGreaterThanOrEqual(0);
        expect(releaseStart).toBeGreaterThan(renewStart);
        const renewBody = migration.slice(renewStart, releaseStart);
        expect(renewBody.match(/OR p_lease_token IS NULL/g)).toHaveLength(1);
        expect(renewBody).not.toContain('OR p_lease_token IS NULL OR p_lease_token IS NULL');
        expect(migration).not.toContain('p_now_ms');
        // The anonymous preflight dispatch wrappers intentionally grant only their
        // marker-aware reserve/mark functions to anon/authenticated.  Privileged
        // admission, recovery, and readiness functions must remain service-role-only.
        for (const functionName of [
            'acquire_analysis_provider_admission',
            'renew_analysis_provider_admission',
            'release_analysis_provider_admission',
            'recover_expired_analysis_provider_admission',
            'resolve_analysis_provider_admission',
            'list_expired_analysis_provider_admissions',
            'list_expired_analysis_provider_admissions_page',
            'analysis_capacity_activation_readiness',
        ]) {
            const functionGrant = new RegExp(
                `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${functionName}\\([^;]*?;`,
                'i',
            );
            const grants = migration.match(functionGrant) ?? [];
            expect(grants.join('\n')).not.toMatch(/TO\s+(?:anon|authenticated)(?:[,;]|\s)/i);
        }
    });

    it('keeps fresh and ordinary rearmed marks fenced to their own dispatch domains', () => {
        const fresh = capacityFunctionDefinition(
            'mark_analysis_v2_preflight_admission_rearmed_dispatch_v2',
        );
        expect(fresh).toContain("v_preflight.admission_status = 'pending'");
        expect(fresh).toContain("v_preflight.admission_dispatch_state = 'enqueued'");
        expect(fresh).toContain(
            'v_preflight.admission_dispatch_token IS NOT DISTINCT FROM p_dispatch_token',
        );
        expect(fresh).not.toContain('v_preflight.status');
        expect(fresh).not.toContain('v_preflight.dispatch_state');
        expect(fresh).not.toContain('last_dispatch_token');

        const ordinary = capacityFunctionDefinition(
            'mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2',
        );
        expect(ordinary).toContain("v_preflight.status = 'pending'");
        expect(ordinary).toContain("v_preflight.dispatch_state = 'enqueued'");
        expect(ordinary).toContain(
            'v_preflight.last_dispatch_token IS NOT DISTINCT FROM p_dispatch_token',
        );
        expect(ordinary).not.toContain('v_preflight.admission_status');
        expect(ordinary).not.toContain('admission_dispatch_token');
    });

    it('preserves the legacy ordinary claim column order including beta channel', () => {
        const claim = capacityFunctionDefinition('claim_analysis_v2_preflight_v2');
        expect(claim).toMatch(
            /access_mode TEXT,\s*analysis_entry_channel TEXT,\s*plan_catalog_snapshot JSONB/,
        );
        expect(claim).toContain('v_result.access_mode, v_result.analysis_entry_channel');
    });

    it('uses exact role/version/fence predicates for activation readiness', () => {
        const readiness = capacityFunctionDefinition('analysis_capacity_activation_readiness');
        expect(readiness).toContain('dispatch_workload_role IS NULL');
        expect(readiness).toContain('dispatch_contract_version IS NULL');
        expect(readiness).toContain('dispatch_workload_role IS DISTINCT FROM');
        expect(readiness).toContain('dispatch_contract_version IS DISTINCT FROM 2');
        expect(readiness).toContain('last_dispatch_token IS NULL');
        expect(readiness).toContain('admission_dispatch_workload_role IS NULL');
        expect(readiness).toContain('admission_dispatch_contract_version IS NULL');
        expect(readiness).toContain('admission_claim_workload_role IS NOT NULL');
        expect(readiness).toContain('admission_claim_contract_version IS NOT NULL');
        expect(readiness).toContain('admission.job_claim_token = preflight.admission_claim_token');
        expect(readiness).toContain('admission.claim_token = preflight.admission_claim_token');
        expect(readiness).toContain("analysis_entry_channel = 'betatest'");
        expect(readiness).toContain('beta_prepare_dispatch_state IN');
    });

    it('fences explicit V2 rearm/reserve marker mismatches before legacy delegation', () => {
        const reserve = capacityFunctionDefinition('reserve_analysis_v2_job_dispatch_v2');
        const reserveGuard = reserve.indexOf('v_job.dispatch_state IN');
        const reserveLegacyCall = reserve.indexOf('public.reserve_analysis_v2_job_dispatch(');
        expect(reserveGuard).toBeGreaterThanOrEqual(0);
        expect(reserveLegacyCall).toBeGreaterThan(reserveGuard);
        expect(reserve.slice(reserveGuard, reserveLegacyCall)).toContain(
            'v_job.dispatch_workload_role IS NULL',
        );
        expect(reserve.slice(reserveGuard, reserveLegacyCall)).toContain(
            'v_job.dispatch_contract_version IS NULL',
        );
        const rearm = capacityFunctionDefinition('rearm_analysis_v2_job_dispatch_v2');
        const rearmGuard = rearm.indexOf('IF FOUND AND (');
        const rearmLegacyCall = rearm.indexOf('public.rearm_analysis_v2_job_dispatch(');
        expect(rearmGuard).toBeGreaterThanOrEqual(0);
        expect(rearmLegacyCall).toBeGreaterThan(rearmGuard);
        expect(rearm.slice(rearmGuard, rearmLegacyCall)).toContain(
            'v_job.dispatch_workload_role IS DISTINCT FROM \'paid\'',
        );
        expect(rearm.slice(rearmGuard, rearmLegacyCall)).toContain(
            'v_job.dispatch_contract_version IS DISTINCT FROM 2',
        );
        const blite = capacityFunctionDefinition('reserve_precheckout_blite_dispatch_v2');
        const bliteLegacyCall = blite.indexOf('public.reserve_precheckout_blite_dispatch_v1(');
        expect(blite.slice(0, bliteLegacyCall)).toContain(
            'ANALYSIS_V2_LEGACY_DISPATCH_ROLELESS',
        );
        expect(blite.slice(0, bliteLegacyCall)).toContain(
            'v_dispatch.dispatch_workload_role IS DISTINCT FROM \'preflight\'',
        );
    });
});
