import { describe, expect, it, vi } from 'vitest';
import {
    enqueueFinalizedAnalysisOrderAuditBundle,
    recoverQueuedAnalysisOrderAudits,
} from './order-audit-bundle';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

describe('finalization order-audit enqueue hook', () => {
    it('enqueues after a durable result finalization when configured', async () => {
        const enqueue = vi.fn(async () => ({ status: 'queued' }));

        await enqueueFinalizedAnalysisOrderAuditBundle(enqueue, requestId);

        expect(enqueue).toHaveBeenCalledWith(requestId);
    });

    it('keeps a committed result successful while leaving a retryable queue failure observable', async () => {
        const enqueue = vi.fn(async () => {
            throw new Error('network unavailable');
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(
            enqueueFinalizedAnalysisOrderAuditBundle(enqueue, requestId),
        ).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith(
            '[analysis.order-audit] enqueue failed',
            expect.objectContaining({
                errorCode: 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED',
                retryable: true,
            }),
        );

        error.mockRestore();
    });

    it('claims and drains a bounded recovery page with lease release on assembly failure', async () => {
        const leaseToken = '223e4567-e89b-42d3-a456-426614174000';
        const rpc = vi.fn(async (name: string) => {
            if (name === 'list_analysis_order_audit_bundle_recovery') {
                return { data: [{ requestId }], error: null };
            }
            if (name === 'claim_analysis_order_audit_bundle') {
                return { data: { requestId, leaseToken }, error: null };
            }
            if (name === 'assemble_analysis_order_audit_bundle') {
                return { data: null, error: { message: 'temporary' } };
            }
            return { data: { requestId, status: 'queued' }, error: null };
        });

        await recoverQueuedAnalysisOrderAudits({ rpc }, 1);

        expect(rpc).toHaveBeenNthCalledWith(
            1,
            'list_analysis_order_audit_bundle_recovery',
            { p_limit: 1 },
        );
        expect(rpc).toHaveBeenCalledWith(
            'claim_analysis_order_audit_bundle',
            { p_request_id: requestId, p_lease_seconds: 300 },
        );
        expect(rpc).toHaveBeenCalledWith(
            'release_analysis_order_audit_bundle',
            {
                p_request_id: requestId,
                p_lease_token: leaseToken,
                p_error_code: 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED',
                p_retryable: true,
            },
        );
    });
});
