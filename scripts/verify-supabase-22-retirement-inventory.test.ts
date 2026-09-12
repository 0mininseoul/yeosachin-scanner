import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REPORT_PATH = 'docs/reports/2026-09-10-supabase-22-retirement-inventory.json';

describe('historical Supabase retirement inventory artifact', () => {
    it('retains the sanitized baseline without making it an operational policy invariant', () => {
        const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as {
            schemaVersion: string;
            generatedFrom: { projectRefSupplied: boolean; readOnly: boolean };
            canonicalTables: Array<Record<string, unknown>>;
            legacyTables: Array<Record<string, unknown>>;
            contractionCandidateAllowlist: string[];
            destructiveOperations: string;
        };

        expect(report.schemaVersion).toBe('supabase-22-retirement-inventory-v1');
        expect(report.generatedFrom).toEqual({ projectRefSupplied: true, readOnly: true });
        expect(report.canonicalTables.length).toBeGreaterThan(0);
        expect(report.legacyTables.length).toBeGreaterThan(0);
        expect(report.contractionCandidateAllowlist).toEqual([]);
        expect(report.destructiveOperations).toBe('refused');
        for (const table of [...report.canonicalTables, ...report.legacyTables]) {
            expect(table).toHaveProperty('rowCountClass');
            expect(table).toHaveProperty('dependencyEvidence');
            expect(table).toHaveProperty('callerEvidence');
            expect(table).toHaveProperty('intendedCanonicalDestination');
            expect(table).toHaveProperty('disposition');
            expect(table.contractionCandidate).toBe(false);
        }
    });

    it('does not contain credentials, identifiers, or raw payload fields', () => {
        const serialized = readFileSync(REPORT_PATH, 'utf8');
        expect(serialized).not.toMatch(
            /access_token|service_role|password|cookie|raw_payload|rawPayload|user_id|device_id|authorization/i,
        );
    });
});
