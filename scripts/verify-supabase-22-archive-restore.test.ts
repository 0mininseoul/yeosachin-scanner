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

    it('compares an encrypted isolated restore by count and aggregate checksum', async () => {
        const writeStdout = vi.fn();
        const dependencies: Supabase22ArchiveRestoreCliDependencies = {
            readManifest: vi.fn(async () => ({
                schemaVersion: 'supabase-22-evidence-v1',
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
                },
                rollbackEvidenceVerified: true,
                observationWindowClosed: true,
                ownerApprovalRecorded: true,
                paymentPendingDispositionRecorded: true,
                noActivationOrCanary: true,
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

        expect(result.exitCode).toBe(0);
        expect(result.report).toMatchObject({
            status: 'ready',
            restoreStatus: 'verified',
            checksumMatch: true,
            archiveManifest: { encrypted: true, retention: 'permanent' },
            destructiveOperations: 'refused',
        });
    });
});
