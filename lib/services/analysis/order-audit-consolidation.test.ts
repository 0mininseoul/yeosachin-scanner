import { describe, expect, it } from 'vitest';
import {
    assertConsolidationMutationRefused,
    assertPiiSafeConsolidationOutput,
    buildOrderAuditParityAggregate,
    buildOrderAuditParityReport,
    createArchiveManifest,
    evaluateConsolidationReadiness,
    stableChecksum,
    verifyArchiveRestore,
    type OrderAuditParitySnapshot,
} from './order-audit-consolidation';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function completeSnapshot(
    overrides: Partial<OrderAuditParitySnapshot> = {},
): OrderAuditParitySnapshot {
    return {
        request: {
            completed: true,
            productionOrder: true,
            sourceDataPresent: true,
        },
        bundle: {
            present: true,
            completeness: 'complete',
            costStatus: 'complete',
            version: 1,
        },
        recovery: {
            present: true,
            completed: true,
        },
        sections: {
            relationships: {
                sourceCount: 2,
                bundleCount: 2,
                sourceChecksum: HASH_A,
                bundleChecksum: HASH_A,
                sourceComplete: true,
                bundleComplete: true,
            },
            targetEvidence: {
                sourceCount: 3,
                bundleCount: 3,
                sourceChecksum: HASH_A,
                bundleChecksum: HASH_A,
                sourceComplete: true,
                bundleComplete: true,
            },
            candidates: {
                sourceCount: 2,
                bundleCount: 2,
                sourceChecksum: HASH_A,
                bundleChecksum: HASH_A,
                sourceComplete: true,
                bundleComplete: true,
            },
            risk: {
                sourceCount: 2,
                bundleCount: 2,
                sourceChecksum: HASH_A,
                bundleChecksum: HASH_A,
                sourceComplete: true,
                bundleComplete: true,
            },
            costLedger: {
                sourceCount: 1,
                bundleCount: 1,
                sourceChecksum: HASH_A,
                bundleChecksum: HASH_A,
                sourceComplete: true,
                bundleComplete: true,
            },
        },
        ...overrides,
    };
}

describe('order-audit consolidation parity tooling', () => {
    it('produces a stable checksum independent of object key order', () => {
        expect(stableChecksum({ b: 2, a: { d: true, c: 1 } }))
            .toBe(stableChecksum({ a: { c: 1, d: true }, b: 2 }));
        expect(stableChecksum(['a', 'b']))
            .not.toBe(stableChecksum(['b', 'a']));
    });

    it('blocks an empty source and absent bundle instead of treating zero rows as parity', () => {
        const report = buildOrderAuditParityReport({
            request: {
                completed: false,
                productionOrder: false,
                sourceDataPresent: false,
            },
            bundle: {
                present: false,
                completeness: null,
                costStatus: null,
                version: null,
            },
            recovery: {
                present: false,
                completed: false,
            },
            sections: {
                relationships: null,
                targetEvidence: null,
                candidates: null,
                risk: null,
                costLedger: null,
            },
        });

        expect(report.status).toBe('blocked');
        expect(report.parityPassed).toBe(false);
        expect(report.mismatchPaths).toEqual([
            'request.not-a-real-completed-production-order',
            'source.no-data',
            'bundle.missing',
            'recovery.missing',
        ]);
    });

    it('reports deterministic section count and checksum mismatch paths', () => {
        const snapshot = completeSnapshot({
            sections: {
                ...completeSnapshot().sections,
                targetEvidence: {
                    sourceCount: 3,
                    bundleCount: 2,
                    sourceChecksum: HASH_A,
                    bundleChecksum: HASH_B,
                    sourceComplete: true,
                    bundleComplete: true,
                },
            },
        });
        const report = buildOrderAuditParityReport(snapshot);

        expect(report.status).toBe('mismatch');
        expect(report.parityPassed).toBe(false);
        expect(report.mismatchPaths).toEqual([
            'sections.targetEvidence.count',
            'sections.targetEvidence.checksum',
        ]);
    });

    it('rejects identifier-bearing or raw-payload output', () => {
        expect(() => assertPiiSafeConsolidationOutput({
            requestId: '423e4567-e89b-42d3-a456-426614174001',
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        expect(() => assertPiiSafeConsolidationOutput({
            nested: { providerToken: 'secret' },
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        expect(() => assertPiiSafeConsolidationOutput({
            status: 'ready',
            mismatchPaths: [],
            aggregateChecksum: HASH_A,
        })).not.toThrow();
    });

    it('keeps archive scaffolding reversible and marks restore verification as not run', () => {
        const manifest = createArchiveManifest({
            selectedCount: 0,
            aggregateChecksum: null,
            parityStatus: 'blocked',
        });
        expect(manifest).toMatchObject({
            mode: 'dry-run',
            reversible: true,
            destructiveOperations: 'refused',
            restore: { status: 'not_run', verified: false },
        });
        expect(verifyArchiveRestore(manifest, {
            observedCount: 0,
            observedChecksum: null,
        })).toMatchObject({ status: 'blocked', verified: false });
    });

    it('marks archive parity ready from real parity while keeping contraction readiness blocked', () => {
        const aggregate = buildOrderAuditParityAggregate([
            buildOrderAuditParityReport(completeSnapshot()),
        ]);

        expect(aggregate.archive.parityStatus).toBe('ready');
        expect(aggregate.archive.selectedCount).toBe(1);
        expect(aggregate.readiness.status).toBe('blocked');
        expect(aggregate.readiness.gates['archive-manifest']).toBe(false);
        expect(aggregate.readiness.missingGates).toEqual([
            'archive-manifest',
            'restore-drill',
            'rollback-evidence',
            'dependency-inventory',
            'separate-approval',
            'observation-window',
        ]);
    });

    it('does not use zero selected requests as archive parity evidence', () => {
        const aggregate = buildOrderAuditParityAggregate([]);

        expect(aggregate.selectedCount).toBe(0);
        expect(aggregate.realCompletedCount).toBe(0);
        expect(aggregate.parityPassedCount).toBe(0);
        expect(aggregate.archive.parityStatus).toBe('blocked');
        expect(aggregate.archive.aggregateChecksum).toBeNull();
        expect(aggregate.readiness.gates['genuine-completed-bundle']).toBe(false);
        expect(() => createArchiveManifest({
            selectedCount: 0,
            aggregateChecksum: null,
            parityStatus: 'ready',
        })).toThrow('ANALYSIS_ORDER_AUDIT_ARCHIVE_PARITY_EMPTY');
    });

    it('requires every explicit gate before readiness and never permits mutation', () => {
        const readiness = evaluateConsolidationReadiness({
            genuineCompletedBundleCount: 0,
            perOrderParityCount: 0,
            aggregateChecksumsMatch: false,
            archiveManifestVerified: false,
            restoreDrillVerified: false,
            rollbackEvidenceVerified: false,
            dependencyInventoryComplete: false,
            separateApprovalGranted: false,
            observationWindowClosed: false,
        });
        expect(readiness.status).toBe('blocked');
        expect(readiness.missingGates).toEqual([
            'genuine-completed-bundle',
            'per-order-parity',
            'aggregate-checksums',
            'archive-manifest',
            'restore-drill',
            'rollback-evidence',
            'dependency-inventory',
            'separate-approval',
            'observation-window',
        ]);
        expect(() => assertConsolidationMutationRefused()).toThrow(
            'ANALYSIS_ORDER_AUDIT_CONSOLIDATION_MUTATION_REFUSED',
        );
    });
});
