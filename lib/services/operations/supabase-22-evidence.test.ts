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
            manifest: {
                schemaVersion: 'supabase-22-archive-manifest-v1',
                selectedCount: 1,
                aggregateChecksum: HASH,
                encrypted: true,
                encryption: { algorithm: 'AES-256-GCM', verified: true },
                retentionClass: 'permanent',
            },
            restoreManifest: {
                schemaVersion: 'supabase-22-restore-manifest-v1',
                selectedCount: 1,
                aggregateChecksum: HASH,
                encrypted: true,
                encryption: { algorithm: 'AES-256-GCM', verified: true },
                retentionClass: 'permanent',
            },
        },
        rollbackEvidenceVerified: true,
        observationWindowClosed: true,
        ownerApprovalRecorded: true,
        canonicalSetMatch: true,
        catalogDependencyClean: true,
        paymentPendingDispositionRecorded: true,
        noActivationOrCanary: true,
        archiveRestoreChecksumMatch: true,
        paymentPendingEvidence: {
            pendingOrderCount: 1,
            independentlyEvidencedCount: 1,
            dispositionRecordedCount: 1,
        },
        noActivationEvidence: {
            source: 'independent-read-only',
            verified: true,
            admissionActivated: false,
            realCanaryStarted: false,
        },
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
            canonicalSetMatch: false,
            catalogDependencyClean: false,
            paymentPendingDispositionRecorded: false,
            noActivationOrCanary: true,
            archiveRestoreChecksumMatch: false,
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

    it('fails closed when v1 evidence omits production operation attestations', () => {
        const v1Input = Object.fromEntries(
            Object.entries(completeInput({ publicTableCount: 21 }))
                .filter(([key]) => key !== 'paymentPendingDispositionRecorded' && key !== 'noActivationOrCanary'),
        ) as Supabase22GateInput;
        const result = evaluateSupabase22Gate(v1Input);

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'public-table-count',
            'payment-pending-disposition',
            'no-activation-or-canary',
        ]));
    });

    it('fails closed when a production attestation is absent', () => {
        const input = { ...completeInput() } as Record<string, unknown>;
        delete input.paymentPendingDispositionRecorded;
        delete input.noActivationOrCanary;

        const result = evaluateSupabase22Gate(input as unknown as Supabase22GateInput);

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'payment-pending-disposition',
            'no-activation-or-canary',
        ]));
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

    it.each([
        'deviceId', 'raw_device_id', 'anonymousDeviceId', 'anonymous_principal_hash',
        'userAgent', 'ipAddress', 'client_ip', 'apiKey', 'access_token',
        'hashKey', 'hmac_key', 'user_id_hash', 'owner_id_hash', 'ip_hash',
        'visitor_id', 'fingerprint', 'browser_fingerprint', 'customer_id',
        'tenant_uuid', 'tracking_hash', 'profile_fingerprint',
    ])('rejects sensitive key variant %s', key => {
        expect(() => assertPiiSafeConsolidationOutput({ [key]: 'redacted' }))
            .toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
    });

    it('rejects raw network and credential values even under an otherwise safe key', () => {
        for (const value of ['192.168.0.10', '2001:db8::1', 'Bearer secret-token']) {
            expect(() => assertPiiSafeConsolidationOutput({ value }))
                .toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        }
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

    it('requires every production readiness attestation even when no extended field is supplied', () => {
        const readiness = evaluateConsolidationReadiness({
            genuineCompletedBundleCount: 1,
            perOrderParityCount: 1,
            aggregateChecksumsMatch: true,
            archiveManifestVerified: true,
            restoreDrillVerified: true,
            rollbackEvidenceVerified: true,
            dependencyInventoryComplete: true,
            separateApprovalGranted: true,
            observationWindowClosed: true,
        } as never);

        expect(readiness.status).toBe('blocked');
        expect(readiness.missingGates).toEqual(expect.arrayContaining([
            'public-table-count',
            'canonical-set',
            'catalog-dependency',
            'payment-pending-disposition',
            'no-activation-or-canary',
            'archive-restore-checksum',
        ]));
    });

    it('does not treat truthy legacy payment or activation attestations as proof', () => {
        const input = { ...completeInput() } as Record<string, unknown>;
        delete input.paymentPendingEvidence;
        delete input.noActivationEvidence;
        const result = evaluateSupabase22Gate(input as unknown as Supabase22GateInput);

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'payment-pending-disposition',
            'no-activation-or-canary',
        ]));
    });

    it('refuses an unbounded activation assertion with extra fields', () => {
        const result = evaluateSupabase22Gate(completeInput({
            noActivationEvidence: {
                source: 'independent-read-only',
                verified: true,
                admissionActivated: false,
                realCanaryStarted: false,
                observationCount: Number.MAX_SAFE_INTEGER,
            } as never,
        }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toContain('no-activation-or-canary');
    });
});
