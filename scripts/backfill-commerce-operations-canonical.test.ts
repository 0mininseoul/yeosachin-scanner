import { describe, expect, it } from 'vitest';
import {
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

        expect(requestedLimit).toBe(100);
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
});
