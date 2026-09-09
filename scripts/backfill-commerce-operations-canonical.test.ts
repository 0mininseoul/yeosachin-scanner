import { describe, expect, it } from 'vitest';
import {
    PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID,
    PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED,
    backfillCommerceOperationsCanonical,
    compareCanonicalParity,
    derivePaymentDisposition,
} from './backfill-commerce-operations-canonical';

describe('commerce canonical report-only backfill', () => {
    it('blocks payment_pending without independent provider evidence', () => {
        expect(derivePaymentDisposition({
            orderStatus: 'payment_pending',
            providerEvidence: null,
        })).toEqual({
            status: 'blocked',
            code: PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED,
        });
    });

    it('marks no-sale evidence as separately reconcilable without mutating an order', () => {
        expect(derivePaymentDisposition({
            orderStatus: 'payment_pending',
            providerEvidence: {
                disposition: 'no_sale',
                checkedAt: '2026-09-09T00:00:00.000Z',
            },
        })).toEqual({ status: 'eligible_for_separate_reconciliation' });
    });

    it('keeps malformed no-sale evidence blocked', () => {
        expect(derivePaymentDisposition({
            orderStatus: 'payment_pending',
            providerEvidence: {
                disposition: 'no_sale',
                checkedAt: 'not-a-timestamp',
            },
        })).toEqual({
            status: 'blocked',
            code: PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID,
        });
    });

    it('processes at most 100 records and emits only aggregate checksums', async () => {
        let requestedLimit = 0;
        const report = await backfillCommerceOperationsCanonical({
            limit: 500,
            cursor: null,
            reportOnly: true,
            readBatch: async limit => {
                requestedLimit = limit;
                return [{
                    family: 'payment',
                    key: 'order-secret-id',
                    content: 'buyer@example.com',
                    orderStatus: 'payment_pending',
                    providerEvidence: null,
                }];
            },
        });

        expect(requestedLimit).toBe(101);
        expect(report.status).toBe('blocked');
        expect(report.unknownEvidenceCount).toBe(1);
        expect(JSON.stringify(report)).not.toContain('order-secret-id');
        expect(JSON.stringify(report)).not.toContain('buyer@example.com');
    });

    it('rejects destructive or cutover options', async () => {
        await expect(backfillCommerceOperationsCanonical({
            limit: 100,
            reportOnly: false,
        })).rejects.toThrow('REPORT_ONLY_REQUIRED');
        await expect(backfillCommerceOperationsCanonical({
            limit: 100,
            reportOnly: true,
            destructive: true,
        })).rejects.toThrow('DESTRUCTIVE_OPTION_FORBIDDEN');
    });

    it('reports shadow-read parity as aggregate family matches only', () => {
        const report = compareCanonicalParity(
            [{ family: 'payment', key: 'legacy-id', content: 'a' }],
            [{ family: 'payment', key: 'canonical-id', content: 'a' }],
        );
        expect(report).toEqual(expect.objectContaining({
            status: 'mismatch',
            mismatchedFamilies: ['payment'],
        }));
        expect(JSON.stringify(report)).not.toContain('legacy-id');
        expect(JSON.stringify(report)).not.toContain('canonical-id');
    });

    it('reports bounded field mismatches without values', () => {
        const report = compareCanonicalParity(
            [{ family: 'notification', key: 'one', content: 'ignored', fields: { state: 'queued', attempts: 1 } }],
            [{ family: 'notification', key: 'one', content: 'ignored', fields: { state: 'sent', attempts: 1 } }],
        );
        expect(report).toEqual(expect.objectContaining({
            status: 'mismatch',
            comparedCounts: expect.objectContaining({ notification: 1 }),
            fieldMismatches: expect.objectContaining({ notification: ['state'] }),
            truncatedFamilies: [],
        }));
        expect(JSON.stringify(report)).not.toContain('queued');
        expect(JSON.stringify(report)).not.toContain('sent');
    });

    it('fails closed on a canonical-only tail and on either side being truncated', () => {
        const canonicalOnly = compareCanonicalParity(
            [{ family: 'notification', key: 'one', content: 'ignored' }],
            [
                { family: 'notification', key: 'one', content: 'ignored' },
                { family: 'notification', key: 'two', content: 'ignored' },
            ],
        );
        expect(canonicalOnly.status).toBe('mismatch');
        expect(canonicalOnly.mismatchedFamilies).toContain('notification');
        expect(canonicalOnly.fieldMismatches.notification).toEqual(
            expect.arrayContaining(['missing_record', 'record_count']),
        );

        const rows = Array.from({ length: 101 }, (_, index) => ({
            family: 'maintenance' as const,
            key: `maintenance-${index}`,
            content: 'same',
        }));
        const truncated = compareCanonicalParity(rows, rows);
        expect(truncated.status).toBe('mismatch');
        expect(truncated.truncatedFamilies).toEqual(['maintenance']);
        expect(truncated.fieldMismatches.maintenance).toEqual(['truncated']);
    });

    it('requires bounded source and canonical readers before reporting backfill parity complete', async () => {
        const source = [{ family: 'payment' as const, key: 'one', content: 'same' }];
        const report = await backfillCommerceOperationsCanonical({
            limit: 100,
            reportOnly: true,
            readBatch: async () => source,
            readCanonicalBatch: async () => source,
        });

        expect(report.status).toBe('complete');
        expect(report.parity).toEqual(expect.objectContaining({ status: 'match' }));

        const blocked = await backfillCommerceOperationsCanonical({
            limit: 100,
            reportOnly: true,
            readBatch: async () => source,
        });
        expect(blocked.status).toBe('blocked');
        expect(blocked.blockedReasons).toContain('CANONICAL_SOURCE_NOT_CONFIGURED');
    });
});
