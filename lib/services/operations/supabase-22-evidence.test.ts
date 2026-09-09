import { describe, expect, it } from 'vitest';
import {
    evaluateSupabase22Gate,
    parseSupabase22ApprovalRecord,
    SUPABASE_22_CANONICAL_TABLES,
    type Supabase22GateInput,
} from './supabase-22-evidence';
import { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';
import { evaluateConsolidationReadiness } from '../analysis/order-audit-consolidation';

const HASH = 'a'.repeat(64);

function completeInput(overrides: Partial<Supabase22GateInput> = {}): Supabase22GateInput {
    return {
        publicTableCount: SUPABASE_22_CANONICAL_TABLES.length,
        canonicalTables: [...SUPABASE_22_CANONICAL_TABLES],
        unexpectedTables: [],
        missingTables: [],
        dependencyClean: true,
        migrationHistoryClean: true,
        genuineCompletedBundleCount: 1,
        parityStatus: 'ready',
        archiveManifest: {
            verified: true,
            aggregateChecksum: HASH,
            restoreStatus: 'verified',
        },
        rollbackEvidenceVerified: true,
        observationWindowClosed: true,
        ownerApprovalRecorded: true,
        paymentPendingDispositionRecorded: true,
        noActivationOrCanary: true,
        ...overrides,
    };
}

describe('Supabase 22 evidence gate', () => {
    it('uses the exact sorted canonical table set', () => {
        expect(SUPABASE_22_CANONICAL_TABLES).toHaveLength(22);
        expect([...SUPABASE_22_CANONICAL_TABLES]).toEqual(
            [...SUPABASE_22_CANONICAL_TABLES].sort(),
        );
        expect(new Set(SUPABASE_22_CANONICAL_TABLES).size).toBe(22);
    });

    it('fails closed when no genuine production bundle exists', () => {
        const result = evaluateSupabase22Gate({
            publicTableCount: 22,
            canonicalTables: SUPABASE_22_CANONICAL_TABLES,
            unexpectedTables: [],
            missingTables: [],
            dependencyClean: true,
            migrationHistoryClean: true,
            genuineCompletedBundleCount: 0,
            parityStatus: 'blocked',
            archiveManifest: { verified: false, aggregateChecksum: null, restoreStatus: 'blocked' },
            rollbackEvidenceVerified: false,
            observationWindowClosed: false,
            ownerApprovalRecorded: false,
            paymentPendingDispositionRecorded: false,
            noActivationOrCanary: true,
        });

        expect(result).toMatchObject({
            status: 'blocked',
            destructiveOperations: 'refused',
        });
        expect(result.missingGates).toContain('genuine-completed-bundle');
    });

    it('reports a public-table count mismatch without manufacturing readiness', () => {
        const result = evaluateSupabase22Gate(completeInput({ publicTableCount: 21 }));

        expect(result.status).toBe('mismatch');
        expect(result.missingGates).toContain('public-table-count');
        expect(result.destructiveOperations).toBe('refused');
    });

    it('keeps the v1 evidence shape compatible when optional operation attestations are absent', () => {
        const v1Input = Object.fromEntries(
            Object.entries(completeInput({ publicTableCount: 21 }))
                .filter(([key]) => key !== 'paymentPendingDispositionRecorded' && key !== 'noActivationOrCanary'),
        ) as Supabase22GateInput;
        const result = evaluateSupabase22Gate(v1Input);

        expect(result.status).toBe('mismatch');
        expect(result.missingGates).toEqual(['public-table-count']);
    });

    it('identifies missing and unexpected canonical table names', () => {
        const missing = evaluateSupabase22Gate(completeInput({
            canonicalTables: SUPABASE_22_CANONICAL_TABLES.slice(0, -1),
            missingTables: ['users'],
        }));
        const unexpected = evaluateSupabase22Gate(completeInput({
            canonicalTables: [...SUPABASE_22_CANONICAL_TABLES, 'retired_table'],
            unexpectedTables: ['retired_table'],
        }));

        expect(missing.missingGates).toContain('missing-table');
        expect(unexpected.missingGates).toContain('unexpected-table');
        expect(missing.status).toBe('blocked');
        expect(unexpected.status).toBe('blocked');
    });

    it('rejects unsafe approval records and accepts only complete sanitized approvals', () => {
        expect(parseSupabase22ApprovalRecord({
            allowlistHash: HASH,
            approvedAt: '2026-09-09T12:00:00.000Z',
            approvedByRole: 'owner',
            exactObjectNames: ['retired_table'],
            signatureVerified: true,
        })).toMatchObject({ recorded: true });

        expect(parseSupabase22ApprovalRecord({
            allowlistHash: null,
            approvedAt: null,
            approvedByRole: null,
            exactObjectNames: [],
            signatureVerified: false,
        })).toMatchObject({ recorded: false });
    });

    it('rejects UUID, email, URL, and raw payload keys in evidence output', () => {
        expect(() => assertPiiSafeConsolidationOutput({
            operatorEmail: 'operator@example.com',
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        expect(() => assertPiiSafeConsolidationOutput({
            sourceUrl: 'https://example.test/secret',
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        expect(() => assertPiiSafeConsolidationOutput({
            rawPayload: { safe: false },
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
    });

    it('requires the extended production contract evidence fields', () => {
        const readiness = evaluateConsolidationReadiness({
            genuineCompletedBundleCount: 1,
            perOrderParityCount: 1,
            aggregateChecksumsMatch: true,
            archiveManifestVerified: true,
            restoreDrillVerified: false,
            rollbackEvidenceVerified: true,
            dependencyInventoryComplete: true,
            separateApprovalGranted: false,
            observationWindowClosed: true,
            publicTableCount: 22,
            canonicalSetMatch: true,
            catalogDependencyClean: true,
            paymentPendingDispositionRecorded: true,
            noActivationOrCanary: true,
            archiveRestoreChecksumMatch: false,
        });

        expect(readiness.status).toBe('blocked');
        expect(readiness.missingGates).toContain('archive-restore-checksum');
    });
});
