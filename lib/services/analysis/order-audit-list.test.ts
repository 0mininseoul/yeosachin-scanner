import { describe, expect, it, vi } from 'vitest';
import {
    loadAnalysisOrderAuditList,
    orderAuditListPayloadSchema,
    parseOrderAuditListQuery,
} from './order-audit-list';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const otherRequestId = '223e4567-e89b-42d3-a456-426614174000';
const assembledAt = '2026-09-04T00:00:00.000Z';

const stageStatus = {
    relationships: true,
    targetEvidence: false,
    candidateFeatures: false,
    riskScores: false,
    finalized: true,
};

const row = {
    requestId,
    orderId: null,
    targetInstagramId: 'target.account',
    planId: 'basic',
    version: 2,
    completenessStatus: 'partial',
    gapCodes: ['COST_USAGE_UNKNOWN'],
    cost: {
        status: 'unknown',
        knownUsd: null,
        conservativeUsd: 0.42,
        usageUnknown: true,
    },
    gender: { initialResolved: 0, finalResolved: 0 },
    risk: { declared: 0, collected: 0 },
    retention: {
        state: 'pending',
        queueStatus: 'processing',
        version: 2,
        assembledAt,
        purgeFencedAt: null,
        purgeFenceReason: null,
        purgedAt: null,
        queueUpdatedAt: assembledAt,
    },
    stageStatus,
    assembledAt,
};

describe('operator order-audit list service boundary', () => {
    it('parses a bounded keyset query and requires both cursor components', () => {
        expect(parseOrderAuditListQuery('https://example.test/api/admin/order-audit'))
            .toEqual({
                pageSize: 25,
                cursorAssembledAt: null,
                cursorRequestId: null,
            });
        expect(parseOrderAuditListQuery(
            `https://example.test/api/admin/order-audit?pageSize=1&cursorAssembledAt=${encodeURIComponent(assembledAt)}&cursorRequestId=${requestId}`,
        )).toEqual({
            pageSize: 1,
            cursorAssembledAt: assembledAt,
            cursorRequestId: requestId,
        });
        expect(() => parseOrderAuditListQuery(
            `https://example.test/api/admin/order-audit?cursorRequestId=${requestId}`,
        )).toThrow();
        expect(() => parseOrderAuditListQuery(
            `https://example.test/api/admin/order-audit?cursorAssembledAt=${encodeURIComponent(assembledAt)}`,
        )).toThrow();
        expect(() => parseOrderAuditListQuery(
            'https://example.test/api/admin/order-audit?pageSize=51',
        )).toThrow();
        expect(() => parseOrderAuditListQuery(
            'https://example.test/api/admin/order-audit?unexpected=true',
        )).toThrow();
    });

    it('loads only the redacted list RPC with a typed keyset cursor', async () => {
        const payload = {
            rows: [row],
            nextCursor: {
                assembledAt,
                requestId: otherRequestId,
            },
        };
        const rpc = vi.fn(async () => ({ data: payload, error: null }));
        const query = parseOrderAuditListQuery(
            `https://example.test/api/admin/order-audit?pageSize=1&cursorAssembledAt=${encodeURIComponent(assembledAt)}&cursorRequestId=${requestId}`,
        );

        await expect(loadAnalysisOrderAuditList({ rpc }, query)).resolves.toEqual(payload);
        expect(rpc).toHaveBeenCalledWith('list_analysis_order_audit_bundles', {
            p_cursor_assembled_at: assembledAt,
            p_cursor_request_id: requestId,
            p_page_size: 1,
        });
    });

    it('preserves unknown and null cost values while rejecting unsafe or oversized payloads', async () => {
        const rpc = vi.fn(async () => ({
            data: {
                rows: [{
                    ...row,
                    orderId: '423e4567-e89b-42d3-a456-426614174001',
                    cost: {
                        status: 'not_available',
                        knownUsd: null,
                        conservativeUsd: null,
                        usageUnknown: true,
                    },
                }],
                nextCursor: null,
            },
            error: null,
        }));
        const result = await loadAnalysisOrderAuditList({ rpc }, {
            pageSize: 25,
            cursorAssembledAt: null,
            cursorRequestId: null,
        });
        expect(result.rows[0]?.cost).toEqual({
            status: 'not_available',
            knownUsd: null,
            conservativeUsd: null,
            usageUnknown: true,
        });

        const unsafeRpc = vi.fn(async () => ({
            data: {
                rows: [{ ...row, providerRuns: [{ token: 'secret' }] }],
                nextCursor: null,
            },
            error: null,
        }));
        await expect(loadAnalysisOrderAuditList({ rpc: unsafeRpc }, {
            pageSize: 25,
            cursorAssembledAt: null,
            cursorRequestId: null,
        })).rejects.toThrow('ANALYSIS_ORDER_AUDIT_LIST_PAYLOAD_INVALID');

        expect(() => orderAuditListPayloadSchema.parse({
            rows: Array.from({ length: 51 }, () => row),
            nextCursor: null,
        })).toThrow();
    });

    it('maps RPC failures to a stable non-sensitive service error', async () => {
        const rpc = vi.fn(async () => ({
            data: null,
            error: { message: 'provider token and user id must not escape' },
        }));
        await expect(loadAnalysisOrderAuditList({ rpc }, {
            pageSize: 25,
            cursorAssembledAt: null,
            cursorRequestId: null,
        })).rejects.toThrow('ANALYSIS_ORDER_AUDIT_LIST_FAILED');
    });
});
