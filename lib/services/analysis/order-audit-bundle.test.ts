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

    it('rejects provider account and user identity fields in an RPC payload', async () => {
        const rpc = vi.fn(async () => ({
            data: {
                status: 'queued',
                requestId,
                providerRuns: [{
                    logicalProvider: 'apify',
                    credentialSlot: 'primary',
                    runId: 'Abcdefgh',
                    operationKey: 'relationship-followers:aaaaaaaa',
                    resultHash: 'a'.repeat(64),
                    actorId: 'apify/account-42',
                }],
            },
            error: null,
        }));

        await expect(enqueueAnalysisOrderAuditBundle({ rpc }, requestId))
            .rejects.toThrow('ANALYSIS_ORDER_AUDIT_REDACTION_VIOLATION');
    });

    it('rejects nested user UUID and provider token fields from an assembled payload', async () => {
        const rpc = vi.fn(async () => ({
            data: {
                status: 'partial',
                requestId,
                version: 1,
                bundleHash: 'a'.repeat(64),
                sourceSetHash: 'b'.repeat(64),
                gapCodes: [],
                cost: {
                    currency: 'USD',
                    status: 'unknown',
                    knownUsd: null,
                    conservativeUsd: null,
                    usageUnknown: true,
                    provenance: {
                        providerToken: 'must-not-cross-boundary',
                        userUuid: '423e4567-e89b-42d3-a456-426614174001',
                    },
                },
            },
            error: null,
        }));

        await expect(assembleAnalysisOrderAuditBundle({ rpc }, requestId))
            .rejects.toThrow('ANALYSIS_ORDER_AUDIT_REDACTION_VIOLATION');
    });

    it('assembles through the service RPC and preserves unknown cost state', async () => {
        const payload = {
            status: 'partial',
            requestId,
            version: 2,
            bundleHash: 'a'.repeat(64),
            sourceSetHash: 'b'.repeat(64),
            orderId: '423e4567-e89b-42d3-a456-426614174001',
            gapCodes: ['COST_USAGE_UNKNOWN'],
            cost: {
                currency: 'USD',
                knownUsd: null,
                conservativeUsd: 0,
                usageUnknown: true,
                status: 'unknown',
                provenance: {
                    provider: { actualUsd: 0.12 },
                    ai: { estimatedUsd: 0.3 },
                },
            },
        } satisfies OrderAuditBundlePayload;
        const rpc = vi.fn(async () => ({ data: payload, error: null }));

        await expect(assembleAnalysisOrderAuditBundle({ rpc }, requestId))
            .resolves.toEqual(payload);
        expect(payload.cost.knownUsd).toBeNull();
        expect(payload.cost.usageUnknown).toBe(true);
        expect(payload).toMatchObject({ orderId: '423e4567-e89b-42d3-a456-426614174001' });
        expect(payload).not.toHaveProperty('user_id');
        expect(payload.cost.provenance).toMatchObject({
            provider: { actualUsd: 0.12 },
            ai: { estimatedUsd: 0.3 },
        });
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
