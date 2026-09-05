import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260905110000_add_order_audit_consolidation_readiness.sql',
    import.meta.url,
), 'utf8');

describe('order-audit consolidation readiness migration contract', () => {
    it('adds the queue attestation and stable, service-role parity RPC after the permanent bundle migration', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260904130000');
        expect(migration).toContain("WHERE version = '20260904130000'");
        expect(migration).toContain('parity_attestation JSONB');
        expect(migration).toContain('analysis_order_audit_queue_parity_attestation_check');
        expect(migration).toContain(
            'capture_analysis_order_audit_parity_attestation_after_completion',
        );
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.capture_analysis_order_audit_parity_attestation()',
        );
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.read_analysis_order_audit_parity_snapshot',
        );
        expect(migration).toContain('RETURNS JSONB');
        expect(migration).toContain('LANGUAGE plpgsql');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain('STABLE');
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.read_analysis_order_audit_parity_snapshot(UUID)\n    TO service_role',
        );
        expect(migration).toContain("'sourceCount'");
        expect(migration).toContain("'bundleChecksum'");
        expect(migration).toContain("'costLedger'");
    });

    it('contains only the bounded queue-attestation write and no destructive DDL', () => {
        expect(migration).toContain(
            'ADD COLUMN parity_attestation JSONB',
        );
        expect(migration).toContain(
            'UPDATE public.analysis_order_audit_assembly_queue',
        );
        expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\b/i);
        expect(migration).not.toMatch(
            /\bUPDATE\s+public\.(?!analysis_order_audit_assembly_queue\b)/i,
        );
        expect(migration).not.toMatch(
            /\bALTER\s+TABLE\s+public\.(?!analysis_order_audit_assembly_queue\b)/i,
        );
        expect(migration).not.toMatch(/\b(?:TRUNCATE|DROP)\b/i);
        expect(migration).not.toMatch(/CREATE\s+TABLE/i);
        expect(migration).not.toMatch(/CREATE\s+INDEX/i);
    });

    it('does not return request, order, preflight, handle, comment, or provider fields', () => {
        const returnedJson = migration.slice(migration.lastIndexOf('RETURN pg_catalog.jsonb_build_object'));
        expect(returnedJson).not.toMatch(/'request[_-]?id'|'order[_-]?id'|'preflight[_-]?id'/i);
        expect(returnedJson).not.toMatch(/'username'|'handle'|'comment[_-]?text'/i);
        expect(returnedJson).not.toMatch(/'token'|'cookie'|'provider[_-]?(?:payload|response|account)'/i);
    });
});
