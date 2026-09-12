import { describe, expect, it, vi } from 'vitest';
import {
    parseSupabase22ArchiveRestoreCliArgs,
    parseSupabase22IndependentArchiveProof,
    runSupabase22ArchiveRestoreCli,
    type Supabase22ArchiveRestoreCliDependencies,
} from './verify-supabase-22-archive-restore';

const HASH = 'a'.repeat(64);
const REQUEST_ID = '423e4567-e89b-42d3-a456-426614174001';
const section = () => ({
    sourceCount: 0,
    bundleCount: 0,
    sourceChecksum: HASH,
    bundleChecksum: HASH,
    sourceComplete: true,
    bundleComplete: true,
});

const dependencies = (overrides: Partial<Supabase22ArchiveRestoreCliDependencies> = {}) => ({
    readSnapshot: vi.fn(async () => ({
        request: { completed: true, productionOrder: true, sourceDataPresent: true },
        bundle: { present: true, completeness: 'complete' as const, costStatus: 'complete' as const, version: 1 },
        recovery: { present: true, completed: true },
        sections: {
            relationships: section(),
            targetEvidence: section(),
            candidates: section(),
            risk: section(),
            costLedger: section(),
        },
    })),
    readManifest: vi.fn(async () => ({})),
    readRestoreManifest: vi.fn(async () => ({})),
    writeStdout: vi.fn(),
    ...overrides,
}) as unknown as Supabase22ArchiveRestoreCliDependencies;

describe('operational-policy-v1 archive/restore verifier CLI', () => {
    it('rejects every destructive mode and bounds restore inputs', () => {
        for (const option of ['--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate']) {
            expect(() => parseSupabase22ArchiveRestoreCliArgs([option])).toThrow('read-only');
        }
        expect(parseSupabase22ArchiveRestoreCliArgs([
            '--report-only', '--request-id', REQUEST_ID, '--restore-path', 'restore.json',
        ])).toEqual({
            reportOnly: true,
            requestIds: [REQUEST_ID],
            includeArchiveManifest: false,
            restorePath: 'restore.json',
            manifestPath: null,
        });
    });

    it('requires an explicitly shaped independent encrypted archive proof', () => {
        expect(() => parseSupabase22IndependentArchiveProof({})).toThrow(
            'OPERATIONAL_POLICY_INDEPENDENT_ARCHIVE_PROOF_INVALID',
        );
        expect(parseSupabase22IndependentArchiveProof({
            source: 'independent-read-only',
            selectedCount: 1,
            archiveChecksum: HASH,
            restoreCount: 1,
            restoreChecksum: HASH,
            encryptionAlgorithm: 'AES-256-GCM',
            retentionClass: 'standard',
            isolatedRestoreVerified: true,
        })).toMatchObject({ selectedCount: 1, restoreCount: 1 });
    });

    it('keeps report-only output blocked when no fresh policy evidence is available', async () => {
        const writeStdout = vi.fn();
        const deps = dependencies({ writeStdout });
        const result = await runSupabase22ArchiveRestoreCli(['--report-only'], deps);
        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('blocked');
        expect(result.report.destructiveOperations).toBe('refused');
        expect(JSON.stringify(writeStdout.mock.calls)).not.toContain(REQUEST_ID);
    });

    it('keeps an isolated restore checksum comparison observable without enabling production apply', async () => {
        const deps = dependencies({
            readArchiveEvidence: vi.fn(async () => ({
                source: 'independent-read-only',
                selectedCount: 0,
                archiveChecksum: HASH,
                restoreCount: 0,
                restoreChecksum: HASH,
                encryptionAlgorithm: 'AES-256-GCM',
                retentionClass: 'standard',
                isolatedRestoreVerified: true,
            })),
        });
        const result = await runSupabase22ArchiveRestoreCli([
            '--report-only', '--request-id', REQUEST_ID,
        ], deps);
        expect(result.exitCode).toBe(1);
        expect(result.report.status).toBe('blocked');
        expect(result.report.destructiveOperations).toBe('refused');
    });
});
