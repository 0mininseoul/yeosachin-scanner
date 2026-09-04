import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
    'supabase/migrations/20260904130000_add_permanent_order_audit_bundle.sql';

function migration(): string {
    return readFileSync(migrationPath, 'utf8');
}

describe('operator order-audit list RPC migration contract', () => {
    it('defines a bounded service-only latest-bundle keyset wrapper', () => {
        const sql = migration();
        const start = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.list_analysis_order_audit_bundles(',
        );
        expect(start).toBeGreaterThanOrEqual(0);
        const end = sql.indexOf(
            'REVOKE ALL ON FUNCTION public.list_analysis_order_audit_bundles(',
            start,
        );
        expect(end).toBeGreaterThan(start);
        const definition = sql.slice(start, end);

        expect(definition).toContain('RETURNS JSONB');
        expect(definition).toContain('SECURITY DEFINER');
        expect(definition).toContain("SET search_path = ''");
        expect(definition).toContain("SET statement_timeout = '5s'");
        expect(definition).toContain('DISTINCT ON (bundle.request_id)');
        expect(definition).toContain('ORDER BY bundle.request_id, bundle.version DESC');
        expect(definition).toContain('p_cursor_assembled_at');
        expect(definition).toContain('p_cursor_request_id');
        expect(definition).toContain('p_page_size NOT BETWEEN 1 AND 50');
        expect(definition).toContain('assembled_at DESC, request_id DESC');
        expect(definition).toContain('assembled_at < p_cursor_assembled_at');
        expect(definition).toContain('request_id < p_cursor_request_id');
        expect(definition).toContain('LIMIT p_page_size + 1');
        expect(definition).toContain("'nextCursor'");
        expect(definition).not.toContain('OFFSET');
    });

    it('returns only the compact overview projection', () => {
        const sql = migration();
        const start = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.list_analysis_order_audit_bundles(',
        );
        const end = sql.indexOf(
            'REVOKE ALL ON FUNCTION public.list_analysis_order_audit_bundles(',
            start,
        );
        const definition = sql.slice(start, end);

        for (const key of [
            'requestId', 'orderId', 'targetInstagramId', 'planId', 'version',
            'completenessStatus', 'gapCodes', 'cost', 'status', 'knownUsd',
            'conservativeUsd', 'usageUnknown', 'stageStatus', 'assembledAt',
            'relationships', 'targetEvidence', 'candidateFeatures', 'riskScores',
            'finalized',
        ]) {
            expect(definition).toContain(`'${key}'`);
        }
        expect(definition).not.toContain('provider_runs');
        expect(definition).not.toContain('providerRuns');
        expect(definition).not.toContain('cost_provenance');
        expect(definition).not.toContain('user_id');
        expect(definition).not.toContain('raw_payload');
    });

    it('revokes all callers before granting only the public wrapper to service_role', () => {
        const sql = migration();
        const revokeStart = sql.indexOf(
            'REVOKE ALL ON FUNCTION public.list_analysis_order_audit_bundles(',
        );
        const grantStart = sql.indexOf(
            'GRANT EXECUTE ON FUNCTION public.list_analysis_order_audit_bundles(',
            revokeStart,
        );
        expect(revokeStart).toBeGreaterThanOrEqual(0);
        expect(grantStart).toBeGreaterThan(revokeStart);
        const acl = sql.slice(revokeStart, grantStart);
        expect(acl).toContain('FROM PUBLIC, anon, authenticated, service_role');
        expect(sql.slice(grantStart, grantStart + 240)).toContain('TO service_role');
    });
});
