import { describe, expect, it } from 'vitest';
import {
    SUPABASE_22_RETIREMENT_INVENTORY_QUERY,
    assertSupabase22RetirementQueryReadOnly,
    buildSupabase22RetirementInventoryReport,
    destinationFor,
    dispositionFor,
    parseSupabase22RetirementCliResponse,
    parseSupabase22RetirementInventoryArgs,
    scanSupabase22RuntimeCallers,
} from './generate-supabase-22-retirement-inventory';
import {
    SUPABASE_OPERATIONAL_POLICY_SCHEMA,
    SUPABASE_OPERATIONAL_W1A_UPPER_BOUND,
} from '../lib/services/operations/supabase-22-evidence';

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
        expect(destinationFor('earlybird_concierge_batch_target_lineage_repairs')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_partial_adoption_second_rearms')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_profile_evidence_failure_recoveries')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_v211_apify_transient_admission_resumes')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_v211_concierge_copy_corrections')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_v212_concierge_copy_corrections')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_v213_concierge_copy_corrections')).toBe('maintenance_jobs');
        expect(destinationFor('earlybird_v214_concierge_gemini_copy_corrections')).toBe('maintenance_jobs');
        expect(destinationFor('payment_orders')).not.toBe('analysis_events');
        expect(destinationFor('payments')).not.toBe('analysis_events');
        expect(destinationFor('earlybird_webhook_events')).not.toBe('maintenance_jobs');
        expect(destinationFor('earlybird_fulfillments')).toBeNull();
        expect(destinationFor('earlybird_payment_discord_outbox')).toBeNull();
        expect(destinationFor('earlybird_first15_canary_provider_rearms')).toBeNull();
        expect(destinationFor('earlybird_v211_concierge_publications')).toBeNull();
        expect(destinationFor('payment_event_log')).toBeNull();
        expect(destinationFor('unrelated_legacy_table')).toBeNull();
        expect(dispositionFor('unrelated_legacy_table')).toBe('unknown');
    });

    it('classifies retained, W1A, and legacy observations without a numeric invariant', async () => {
        const report = await buildSupabase22RetirementInventoryReport([
            aggregate('analysis_jobs'),
            aggregate('analysis_artifacts'),
            aggregate('unrelated_legacy_table'),
        ]);
        expect(report.schemaVersion).toBe(SUPABASE_OPERATIONAL_POLICY_SCHEMA);
        expect(report.policyReadiness).toBe('blocked');
        expect(report.publicBasePartitionedTableCount).toBe(3);
        expect(report.retainedTables.map(row => row.tableName)).toEqual(['analysis_jobs']);
        expect(report.w1aCandidates.map(row => row.tableName)).toEqual(['analysis_artifacts']);
        expect(report.legacyTables.map(row => row.tableName)).toEqual(['unrelated_legacy_table']);
        expect(report.approvedSubset).toEqual([]);
        expect(Object.keys(report.deferredReasons)).toEqual([...SUPABASE_OPERATIONAL_W1A_UPPER_BOUND].sort());
        expect(report.contractionCandidateAllowlist).toEqual([]);
        expect(report.contractionCandidateAllowlistSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(report.destructiveOperations).toBe('refused');
    });
});
