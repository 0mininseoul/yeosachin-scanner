import { describe, expect, it } from 'vitest';
import { canonicalJsonHash as sharedCanonicalJsonHash } from '@/lib/services/commerce/canonical-commerce-store';
import {
    backfillAccountDeletionCanonical,
    buildAccountDeletionArchiveRestoreManifest,
    buildAccountDeletionCanonicalProjection,
    compareAccountDeletionParity,
    type AccountDeletionSourceRow,
} from './backfill-account-deletion-canonical';

const ACCOUNT_ID = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';
const HASH = 'a'.repeat(64);

const source: AccountDeletionSourceRow = {
    accountId: ACCOUNT_ID,
    state: 'completed',
    requestedAt: '2026-09-01T00:00:00.000Z',
    objectsPurgedAt: '2026-09-01T00:01:00.000Z',
    databasePurgedAt: '2026-09-01T00:02:00.000Z',
    completedAt: '2026-09-01T00:03:00.000Z',
    updatedAt: '2026-09-01T00:03:00.000Z',
};

describe('account deletion canonical report-only backfill', () => {
    it('projects a source row without exposing the account identifier', () => {
        const projection = buildAccountDeletionCanonicalProjection(source);

        expect(projection.kind).toBe('purge');
        expect(projection.canonicalState).toBe('succeeded');
        expect(projection.payload).toMatchObject({
            source_table: 'account_deletion_jobs',
            legacy_state: 'completed',
            requested_at: source.requestedAt,
            completed_at: source.completedAt,
        });
        expect(JSON.stringify(projection)).not.toContain(ACCOUNT_ID);
        expect(JSON.stringify(projection.payload)).not.toContain('account_id');
        expect(projection.targetKeyHash).toBe(sharedCanonicalJsonHash('account-deletion-target', {
            account_id: ACCOUNT_ID,
        }));
        expect(projection.contentHash).toBe(sharedCanonicalJsonHash(
            'account-deletion-maintenance-content',
            projection.payload,
        ));
    });

    it('blocks a missing canonical row and detects checksum mismatches', () => {
        const projection = buildAccountDeletionCanonicalProjection(source);
        expect(compareAccountDeletionParity([projection], [])).toMatchObject({
            status: 'blocked',
            sourceCount: 1,
            canonicalCount: 0,
            mismatchFields: ['missing_record', 'record_count'],
        });
        expect(compareAccountDeletionParity(
            [projection],
            [{ ...projection, contentHash: HASH }],
        )).toMatchObject({
            status: 'mismatch',
            sourceCount: 1,
            canonicalCount: 1,
            mismatchFields: ['content_hash'],
        });
    });

    it('enforces a bounded report-only page and refuses mutation options', async () => {
        const records = Array.from({ length: 101 }, (_, index) => ({
            ...source,
            accountId: `${index.toString().padStart(8, '0')}-d809-496a-8efc-14a7a64c0000`,
        }));
        const result = await backfillAccountDeletionCanonical({
            limit: 1000,
            reportOnly: true,
            readSource: async () => records,
            readCanonical: async () => records.map(buildAccountDeletionCanonicalProjection),
        });

        expect(result.batchSize).toBe(100);
        expect(result.status).toBe('blocked');
        expect(result.blockedReasons).toContain('source_tail_truncated');
        await expect(backfillAccountDeletionCanonical({
            reportOnly: false,
            readSource: async () => [],
        })).rejects.toThrow('REPORT_ONLY_REQUIRED');
    });

    it('emits a blocked archive/restore manifest until both proofs exist', () => {
        expect(buildAccountDeletionArchiveRestoreManifest({
            sourceCount: 12,
            sourceChecksum: HASH,
            canonicalCount: 0,
            canonicalChecksum: null,
        })).toEqual({
            schemaVersion: 'supabase-22-account-deletion-archive-restore-v1',
            sourceTable: 'account_deletion_jobs',
            canonicalTable: 'maintenance_jobs',
            sourceCount: 12,
            sourceChecksum: HASH,
            canonicalCount: 0,
            canonicalChecksum: null,
            archiveStatus: 'not_run',
            restoreStatus: 'not_run',
            destructiveAllowlist: [],
        });
    });
});
