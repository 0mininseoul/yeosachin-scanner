import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPABASE_22_CANONICAL_TABLES } from '../lib/services/operations/supabase-22-evidence';

const REPORT_PATH = 'docs/reports/2026-09-10-supabase-22-retirement-inventory.json';

describe('Supabase 22 retirement inventory artifact', () => {
    it('contains the exact sanitized public catalog and a conservative empty allowlist', () => {
        const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as {
            schemaVersion: string;
            publicBasePartitionedTableCount: number;
            canonicalTables: Array<{ tableName: string }>;
            legacyTables: Array<Record<string, unknown>>;
            contractionCandidateAllowlist: string[];
            destructiveOperations: string;
        };

        expect(report.schemaVersion).toBe('supabase-22-retirement-inventory-v1');
        expect(report.publicBasePartitionedTableCount).toBe(187);
        expect(report.canonicalTables.map(table => table.tableName)).toEqual(
            SUPABASE_22_CANONICAL_TABLES,
        );
        expect(report.legacyTables).toHaveLength(165);
        expect(report.contractionCandidateAllowlist).toEqual([]);
        expect(report.destructiveOperations).toBe('refused');
        for (const table of report.legacyTables) {
            expect(table).toHaveProperty('rowCountClass');
            expect(table).toHaveProperty('dependencyEvidence');
            expect(table).toHaveProperty('callerEvidence');
            expect(table).toHaveProperty('intendedCanonicalDestination');
            expect(table).toHaveProperty('disposition');
            expect(table).toHaveProperty('contractionCandidate', false);
        }
    });

    it('does not contain credentials, identifiers, or raw payload fields', () => {
        const serialized = readFileSync(REPORT_PATH, 'utf8');
        expect(serialized).not.toMatch(
            /access_token|service_role|password|cookie|raw_payload|rawPayload|user_id|device_id|authorization/i,
        );
    });
});
