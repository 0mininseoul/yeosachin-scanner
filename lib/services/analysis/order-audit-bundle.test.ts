import { describe, expect, it, vi } from 'vitest';
import {
    assembleAnalysisOrderAuditBundle,
    enqueueAnalysisOrderAuditBundle,
    loadAnalysisOrderAuditBundle,
    parseOrderAuditQuery,
    type OrderAuditBundlePayload,
} from './order-audit-bundle';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

describe('permanent order audit bundle service boundary', () => {
    it('enqueues an idempotent request without exposing provider credentials', async () => {
        const rpc = vi.fn(async () => ({
            data: { status: 'queued', requestId },
            error: null,
        }));

        await expect(enqueueAnalysisOrderAuditBundle({ rpc }, requestId))
            .resolves.toEqual({ status: 'queued', requestId });
        expect(rpc).toHaveBeenCalledWith('enqueue_analysis_order_audit_bundle', {
            p_request_id: requestId,
        });
    });

    it('assembles through the service RPC and preserves unknown cost state', async () => {
        const payload = {
            status: 'partial',
            requestId,
            version: 2,
            bundleHash: 'a'.repeat(64),
            sourceSetHash: 'b'.repeat(64),
            gapCodes: ['COST_USAGE_UNKNOWN'],
            cost: {
                currency: 'USD',
                knownUsd: null,
                conservativeUsd: 0,
                usageUnknown: true,
                status: 'unknown',
            },
        } satisfies OrderAuditBundlePayload;
        const rpc = vi.fn(async () => ({ data: payload, error: null }));

        await expect(assembleAnalysisOrderAuditBundle({ rpc }, requestId))
            .resolves.toEqual(payload);
        expect(payload.cost.knownUsd).toBeNull();
        expect(payload.cost.usageUnknown).toBe(true);
        expect(rpc).toHaveBeenCalledWith('assemble_analysis_order_audit_bundle', {
            p_request_id: requestId,
        });
    });

    it('bounds section pagination and uses a redacted stable payload schema', async () => {
        const rpc = vi.fn(async () => ({
            data: {
                summary: {
                    version: 1,
                    status: 'complete',
                    bundleHash: 'a'.repeat(64),
                    sourceSetHash: 'b'.repeat(64),
                    planId: 'basic',
                    accessMode: 'production',
                    completeness: 'complete',
                    gapCodes: [],
                    cost: {
                        currency: 'USD',
                        knownUsd: 0.12,
                        conservativeUsd: 0.12,
                        usageUnknown: false,
                        status: 'complete',
                    },
                },
                section: 'interactions',
                rows: [{
                    ordinal: 1,
                    candidateId: 'candidate:1',
                    username: 'candidate.one',
                    signal: 'target_post_comment',
                    sourcePostId: 'post-1',
                    evidenceId: 'comment-1',
                    commentText: '정말 멋져요',
                    details: { sentiment: 'warm' },
                    occurredAt: null,
                    completeness: 'complete',
                    gapCodes: [],
                }],
                total: 1,
                nextCursor: null,
            } satisfies OrderAuditBundlePayload,
            error: null,
        }));

        const query = parseOrderAuditQuery(
            `https://example.test/${requestId}?section=interactions&cursor=0&pageSize=25&filter=comments`,
        );
        const result = await loadAnalysisOrderAuditBundle({ rpc }, requestId, query);

        expect(result).not.toBeNull();
        if (!result) return;
        expect(result.section).toBe('interactions');
        expect(result.rows[0]).toMatchObject({
            username: 'candidate.one',
            commentText: '정말 멋져요',
        });
        expect(result).not.toHaveProperty('userId');
        expect(result).not.toHaveProperty('providerToken');
        expect(rpc).toHaveBeenCalledWith('load_analysis_order_audit_bundle', {
            p_request_id: requestId,
            p_section: 'interactions',
            p_cursor: 0,
            p_page_size: 25,
            p_filter: 'comments',
        });

        expect(() => parseOrderAuditQuery(
            `https://example.test/${requestId}?section=interactions&cursor=-1`,
        )).toThrow();
        expect(() => parseOrderAuditQuery(
            `https://example.test/${requestId}?section=risk&pageSize=51`,
        )).toThrow();
    });
});
