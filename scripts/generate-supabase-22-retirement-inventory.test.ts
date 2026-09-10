import { describe, expect, it } from 'vitest';
import {
    SUPABASE_22_EXPECTED_LEGACY_COUNT,
    SUPABASE_22_RETIREMENT_INVENTORY_QUERY,
    assertSupabase22RetirementQueryReadOnly,
    buildSupabase22RetirementInventoryReport,
    destinationFor,
    dispositionFor,
    parseSupabase22RetirementCliResponse,
    parseSupabase22RetirementInventoryArgs,
    scanSupabase22RuntimeCallers,
} from './generate-supabase-22-retirement-inventory';

const aggregate = (tableName: string) => ({
    tableName,
    relationClass: 'base' as const,
    estimatedRowCount: 0,
    foreignKeyCount: 0,
    dependencyCount: 0,
    viewDependencyCount: 0,
    routineDependencyCount: 0,
    triggerCount: 0,
    policyCount: 0,
});

describe('Supabase 22 retirement inventory generator', () => {
    it('requires a project ref and keeps the CLI boundary read-only', () => {
        expect(parseSupabase22RetirementInventoryArgs([
            '--project-ref=abcdefghijklmnopqrst', '--cli-path', '/custom/bin/supabase',
        ])).toEqual({ projectRef: 'abcdefghijklmnopqrst', cliPath: '/custom/bin/supabase' });
        expect(() => parseSupabase22RetirementInventoryArgs(['--project-ref=bad'])).toThrow();
        expect(() => parseSupabase22RetirementInventoryArgs(['--drop'])).toThrow('unknown argument');
        expect(() => assertSupabase22RetirementQueryReadOnly('SELECT 1')).not.toThrow();
        expect(() => assertSupabase22RetirementQueryReadOnly('DROP TABLE public.users')).toThrow('NOT_READ_ONLY');
        expect(SUPABASE_22_RETIREMENT_INVENTORY_QUERY).toMatch(/pg_catalog\.pg_class/);
        expect(SUPABASE_22_RETIREMENT_INVENTORY_QUERY).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b/i);
        expect(parseSupabase22RetirementCliResponse('[{"table_name":"users","relation_class":"base","estimated_row_count":0,"foreign_key_count":0,"dependency_count":0,"view_dependency_count":0,"routine_dependency_count":0,"trigger_count":0,"policy_count":0}]')).toHaveLength(1);
    });

    it('counts runtime files and references without returning source content', async () => {
        const result = await scanSupabase22RuntimeCallers(
            ['legacy_table'],
            async () => ['app/route.ts', 'app/route.test.ts'],
            async path => path.endsWith('route.ts') ? 'legacy_table legacy_table' : 'legacy_table',
        );
        expect(result).toEqual({ legacy_table: { callerCount: 1, referenceCount: 2 } });
    });

    it('uses only explicit legacy destinations and leaves unproven tables unknown', () => {
        expect(destinationFor('earlybird_webhook_events')).toBe('payment_events');
        expect(destinationFor('account_deletion_jobs')).toBe('maintenance_jobs');
        expect(destinationFor('payment_orders')).not.toBe('analysis_events');
        expect(destinationFor('payments')).not.toBe('analysis_events');
        expect(destinationFor('payment_event_log')).toBeNull();
        expect(destinationFor('unrelated_legacy_table')).toBeNull();
        expect(dispositionFor('unrelated_legacy_table')).toBe('unknown');
    });

    it('fails closed unless the production aggregate closes 22 + 165', async () => {
        const canonical = [
            'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
            'analysis_costs', 'analysis_events', 'analysis_jobs', 'analysis_preflights',
            'analysis_provider_runs', 'analysis_requests', 'analysis_results', 'earlybird_orders',
            'earlybird_waitlist', 'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
            'notification_outbox', 'payment_events', 'result_feedback', 'system_configuration',
            'system_leases', 'users',
        ].map(aggregate);
        const legacy = Array.from({ length: SUPABASE_22_EXPECTED_LEGACY_COUNT }, (_, index) =>
            aggregate(`legacy_${String(index).padStart(3, '0')}`));
        const report = await buildSupabase22RetirementInventoryReport([...canonical, ...legacy]);
        expect(report.publicBasePartitionedTableCount).toBe(187);
        expect(report.canonicalTableCount).toBe(22);
        expect(report.legacyTableCount).toBe(165);
        expect(report.contractionCandidateAllowlist).toEqual([]);
        expect(report.contractionCandidateAllowlistSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(report.legacyTables.every(row => row.disposition && row.reason && row.dependencyEvidence && row.callerEvidence)).toBe(true);
        expect(report.legacyTables.every(row => row.intendedCanonicalDestination === null && row.disposition === 'unknown')).toBe(true);
    });
});
