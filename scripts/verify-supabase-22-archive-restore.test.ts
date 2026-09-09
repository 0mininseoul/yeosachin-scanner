import { describe, expect, it, vi } from 'vitest';
import {
    parseSupabase22ArchiveRestoreCliArgs,
    runSupabase22ArchiveRestoreCli,
    type Supabase22ArchiveRestoreCliDependencies,
} from './verify-supabase-22-archive-restore';

const REQUEST_ID = '423e4567-e89b-42d3-a456-426614174001';
const HASH = 'a'.repeat(64);

describe('Supabase 22 archive/restore verifier CLI', () => {
    it('rejects execute/apply/mutate/archive deletion flags', () => {
        for (const option of ['--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate']) {
            expect(() => parseSupabase22ArchiveRestoreCliArgs([option])).toThrow('read-only');
        }
    });

    it('bounds explicit request IDs and accepts isolated restore inputs', () => {
        expect(parseSupabase22ArchiveRestoreCliArgs([
            '--report-only', '--request-id', REQUEST_ID, '--archive-manifest',
            '--restore-path', 'restored.json', '--manifest', 'evidence.json',
        ])).toEqual({
            reportOnly: true,
            requestIds: [REQUEST_ID],
            includeArchiveManifest: true,
            restorePath: 'restored.json',
            manifestPath: 'evidence.json',
        });
        expect(() => parseSupabase22ArchiveRestoreCliArgs([
            '--request-id', REQUEST_ID, '--request-id', REQUEST_ID,
        ])).toThrow('unique');
    });

    it('blocks an empty sanitized evidence manifest and does not write files', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
                status: 'blocked' as const,
                publicTableCount: 174,
                canonicalTables: [],
                unexpectedTables: [],
                missingTables: [],
                dependencyClean: false,
                migrationHistoryClean: false,
                genuineCompletedBundleCount: 0,
                parityStatus: 'blocked' as const,
                archiveManifest: {
                    verified: false,
                    aggregateChecksum: null,
                    restoreStatus: 'blocked' as const,
                },
                rollbackEvidenceVerified: false,
                observationWindowClosed: false,
                ownerApprovalRecorded: false,
                canonicalSetMatch: false,
                catalogDependencyClean: false,
                paymentPendingDispositionRecorded: false,
                noActivationOrCanary: true,
                archiveRestoreChecksumMatch: false,
                destructiveOperations: 'refused' as const,
                missingGates: ['genuine-completed-bundle'],
            })),
            readRestoreManifest: vi.fn(),
            readSnapshot: vi.fn(),
            writeStdout,
        };

        const result = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', 'evidence.json', '--archive-manifest',
        ], dependencies);

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(writeStdout.mock.calls[0]?.[0] as string)).toMatchObject({
            status: 'blocked',
            destructiveOperations: 'refused',
        });
        expect(dependencies.readRestoreManifest).not.toHaveBeenCalled();
    });

    it('rejects unknown evidence fields before they can reach stdout', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
                status: 'blocked' as const,
                publicTableCount: 0,
                canonicalTables: [],
                unexpectedTables: [],
                missingTables: [],
                dependencyClean: false,
                migrationHistoryClean: false,
                genuineCompletedBundleCount: 0,
                parityStatus: 'blocked' as const,
                archiveManifest: {
                    verified: false,
                    aggregateChecksum: null,
                    restoreStatus: 'blocked' as const,
                },
                rollbackEvidenceVerified: false,
                observationWindowClosed: false,
                ownerApprovalRecorded: false,
                canonicalSetMatch: false,
                catalogDependencyClean: false,
                paymentPendingDispositionRecorded: false,
                noActivationOrCanary: true,
                archiveRestoreChecksumMatch: false,
                destructiveOperations: 'refused' as const,
                missingGates: ['genuine-completed-bundle'],
                sentinel: 'do-not-emit',
            })),
            readRestoreManifest: vi.fn(),
            readSnapshot: vi.fn(),
            writeStdout,
        } as unknown as Supabase22ArchiveRestoreCliDependencies;

        await expect(runSupabase22ArchiveRestoreCli(
            ['--report-only', '--manifest', 'evidence.json'],
            dependencies,
        )).rejects.toThrow('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
        expect(JSON.stringify(writeStdout.mock.calls)).not.toContain('do-not-emit');
    });

    it('never upgrades a fabricated sanitized ready manifest to readiness', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
                status: 'ready' as const,
                publicTableCount: 22,
                canonicalTables: [
                    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
                    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
                    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
                    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
                    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
                    'notification_outbox', 'payment_events', 'result_feedback',
                    'system_configuration', 'system_leases', 'users',
                ],
                unexpectedTables: [],
                missingTables: [],
                dependencyClean: true,
                migrationHistoryClean: true,
                genuineCompletedBundleCount: 1,
                parityStatus: 'ready' as const,
                archiveManifest: {
                    verified: true,
                    aggregateChecksum: HASH,
                    restoreStatus: 'verified' as const,
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
                destructiveOperations: 'refused' as const,
                missingGates: [],
            })),
            readRestoreManifest: vi.fn(),
            readSnapshot: vi.fn(),
            writeStdout,
        };

        const result = await runSupabase22ArchiveRestoreCli(
            ['--report-only', '--manifest', 'fabricated.json'],
            dependencies,
        );

        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('blocked');
    });

    it('binds request-id archive output to an independent read-only proof', async () => {
        const writeStdout = vi.fn();
        const readArchiveEvidence = vi.fn(async (
            _requestIds: readonly string[],
            expectedChecksum: string | null,
        ) => ({
            source: 'independent-read-only',
            selectedCount: 1,
            archiveChecksum: expectedChecksum ?? HASH,
            restoreCount: 1,
            restoreChecksum: expectedChecksum ?? HASH,
            encryptionAlgorithm: 'AES-256-GCM',
            retentionClass: 'standard',
            isolatedRestoreVerified: true,
        }));
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readSnapshot: vi.fn(async () => ({
                request: { completed: true, productionOrder: true, sourceDataPresent: true },
                bundle: { present: true, completeness: 'complete' as const, costStatus: 'complete' as const, version: 1 },
                recovery: { present: true, completed: true },
                sections: {
                    relationships: {
                        sourceCount: 1, bundleCount: 1, sourceChecksum: HASH,
                        bundleChecksum: HASH, sourceComplete: true, bundleComplete: true,
                    },
                    targetEvidence: {
                        sourceCount: 1, bundleCount: 1, sourceChecksum: HASH,
                        bundleChecksum: HASH, sourceComplete: true, bundleComplete: true,
                    },
                    candidates: {
                        sourceCount: 1, bundleCount: 1, sourceChecksum: HASH,
                        bundleChecksum: HASH, sourceComplete: true, bundleComplete: true,
                    },
                    risk: {
                        sourceCount: 1, bundleCount: 1, sourceChecksum: HASH,
                        bundleChecksum: HASH, sourceComplete: true, bundleComplete: true,
                    },
                    costLedger: {
                        sourceCount: 1, bundleCount: 1, sourceChecksum: HASH,
                        bundleChecksum: HASH, sourceComplete: true, bundleComplete: true,
                    },
                },
            })),
            readManifest: vi.fn(),
            readRestoreManifest: vi.fn(),
            readArchiveEvidence,
            writeStdout,
        };

        const result = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--request-id', REQUEST_ID, '--archive-manifest',
        ], dependencies);

        expect(readArchiveEvidence).toHaveBeenCalledWith([REQUEST_ID], expect.any(String));
        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('blocked');
        expect(result.report.archiveManifest).toMatchObject({
            verified: true,
            encrypted: true,
            retentionClass: 'standard',
        });
        expect(result.report.checksumMatch).toBe(true);
    });

    it('compares an encrypted isolated restore by count and aggregate checksum', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
                status: 'ready' as const,
                publicTableCount: 22,
                canonicalTables: [
                    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
                    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
                    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
                    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
                    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
                    'notification_outbox', 'payment_events', 'result_feedback',
                    'system_configuration', 'system_leases', 'users',
                ],
                unexpectedTables: [],
                missingTables: [],
                dependencyClean: true,
                migrationHistoryClean: true,
                genuineCompletedBundleCount: 1,
                parityStatus: 'ready' as const,
                archiveManifest: {
                    verified: true,
                    aggregateChecksum: HASH,
                    restoreStatus: 'not_run' as const,
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
                destructiveOperations: 'refused' as const,
                missingGates: [],
            })),
            readRestoreManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-restore-manifest-v1',
                selectedCount: 1,
                aggregateChecksum: HASH,
                encrypted: true,
                encryption: { algorithm: 'AES-256-GCM', verified: true },
                retentionClass: 'permanent',
            })),
            readSnapshot: vi.fn(),
            writeStdout,
        };

        const withoutIsolatedRestore = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', 'evidence.json',
        ], dependencies);

        expect(withoutIsolatedRestore.exitCode).toBe(1);
        expect(withoutIsolatedRestore.report.status).not.toBe('ready');
        expect(withoutIsolatedRestore.report.checksumMatch).toBe(false);

        const sameRestorePath = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', './evidence.json', '--restore-path', 'evidence.json',
        ], dependencies);
        expect(sameRestorePath.exitCode).toBe(1);
        expect(sameRestorePath.report.status).not.toBe('ready');
        expect(sameRestorePath.report.checksumMatch).toBe(false);
        expect(dependencies.readRestoreManifest).not.toHaveBeenCalled();

        const result = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', 'evidence.json', '--restore-path', 'restored.json',
        ], dependencies);

        expect(result.exitCode).toBe(1);
        expect(result.report).toMatchObject({
            status: 'blocked',
            destructiveOperations: 'refused',
        });

        vi.mocked(dependencies.readRestoreManifest).mockResolvedValueOnce({
            schemaVersion: 'supabase-22-restore-manifest-v1',
            selectedCount: 1,
            aggregateChecksum: 'b'.repeat(64),
            encrypted: true,
            encryption: { algorithm: 'AES-256-GCM', verified: true },
            retentionClass: 'permanent',
        });
        const checksumMismatch = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', 'evidence.json', '--restore-path', 'restored.json',
        ], dependencies);
        expect(checksumMismatch.exitCode).toBe(1);
        expect(checksumMismatch.report.status).not.toBe('ready');
        expect(checksumMismatch.report.checksumMatch).toBe(false);
    });

    it('does not treat a bare encrypted flag as a genuine restore manifest', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
                status: 'ready' as const,
                publicTableCount: 22,
                canonicalTables: [
                    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
                    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
                    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
                    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
                    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
                    'notification_outbox', 'payment_events', 'result_feedback',
                    'system_configuration', 'system_leases', 'users',
                ],
                unexpectedTables: [],
                missingTables: [],
                dependencyClean: true,
                migrationHistoryClean: true,
                genuineCompletedBundleCount: 1,
                parityStatus: 'ready' as const,
                archiveManifest: {
                    verified: true,
                    aggregateChecksum: HASH,
                    restoreStatus: 'not_run' as const,
                    manifest: {
                        schemaVersion: 'supabase-22-archive-manifest-v1',
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
                archiveRestoreChecksumMatch: false,
                destructiveOperations: 'refused' as const,
                missingGates: [],
            })),
            readRestoreManifest: vi.fn(async () => ({
                selectedCount: 1,
                aggregateChecksum: HASH,
                encrypted: true,
            })),
            readSnapshot: vi.fn(),
            writeStdout,
        };

        const result = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', 'evidence.json', '--restore-path', 'restored.json',
        ], dependencies);

        expect(result.exitCode).toBe(1);
        expect(result.report.restoreStatus).not.toBe('verified');
        expect(result.report.destructiveOperations).toBe('refused');
        expect(dependencies.readRestoreManifest).not.toHaveBeenCalled();
    });

    it('uses explicit encryption and retention evidence from a genuine restore manifest', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
                status: 'ready' as const,
                publicTableCount: 22,
                canonicalTables: [
                    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
                    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
                    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
                    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
                    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
                    'notification_outbox', 'payment_events', 'result_feedback',
                    'system_configuration', 'system_leases', 'users',
                ],
                unexpectedTables: [],
                missingTables: [],
                dependencyClean: true,
                migrationHistoryClean: true,
                genuineCompletedBundleCount: 1,
                parityStatus: 'ready' as const,
                archiveManifest: {
                    verified: true,
                    aggregateChecksum: HASH,
                    restoreStatus: 'not_run' as const,
                    manifest: {
                        schemaVersion: 'supabase-22-archive-manifest-v1',
                        selectedCount: 1,
                        aggregateChecksum: HASH,
                        encrypted: true,
                        encryption: { algorithm: 'AES-256-GCM', verified: true },
                        retentionClass: 'standard',
                    },
                },
                rollbackEvidenceVerified: true,
                observationWindowClosed: true,
                ownerApprovalRecorded: true,
                canonicalSetMatch: true,
                catalogDependencyClean: true,
                paymentPendingDispositionRecorded: true,
                noActivationOrCanary: true,
                archiveRestoreChecksumMatch: false,
                destructiveOperations: 'refused' as const,
                missingGates: [],
            })),
            readRestoreManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-restore-manifest-v1',
                selectedCount: 1,
                aggregateChecksum: HASH,
                encrypted: true,
                encryption: { algorithm: 'AES-256-GCM', verified: true },
                retentionClass: 'standard',
            })),
            readSnapshot: vi.fn(),
            writeStdout,
        };

        const result = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--manifest', 'evidence.json', '--restore-path', 'restored.json',
        ], dependencies);

        expect(result.exitCode).toBe(1);
        expect(result.report).toMatchObject({
            status: 'blocked',
        });
    });
});
