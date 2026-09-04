import { describe, expect, it, vi } from 'vitest';
import {
    captureAnalysisScoreAuditSource,
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
    isAnalysisAuditOperator,
    loadAnalysisScoreAudit,
    materializeQueuedAnalysisScoreAudit,
    parseAnalysisAuditQuery,
    recoverQueuedAnalysisScoreAudits,
} from './score-audit';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const otherId = '223e4567-e89b-42d3-a456-426614174000';

describe('analysis score audit operator boundary', () => {
    it.each([
        ['explicit 401 status', { status: 401, message: 'private details' }],
        ['typed missing-session name', { name: 'AuthSessionMissingError', status: 400 }],
        ['typed invalid JWT name', { name: 'AuthInvalidJwtError', status: 400 }],
        ['recognized expired-session code', { name: 'AuthApiError', status: 400, code: 'session_expired' }],
    ] as const)('classifies %s as unauthorized', (_label, error) => {
        expect(classifyOperatorAuthError(error)).toBe('unauthorized');
    });

    it.each([
        ['bare 403', { status: 403 }],
        ['unknown 400 with deceptive message', {
            status: 400,
            code: 'unknown_auth_failure',
            message: 'invalid token endpoint unavailable',
        }],
        ['429', { status: 429, code: 'invalid_token' }],
        ['5xx', { status: 503, code: 'invalid_token' }],
        ['transport exception', new Error('invalid token from transport')],
    ] as const)('classifies %s as unavailable', (_label, error) => {
        expect(classifyOperatorAuthError(error)).toBe('unavailable');
    });

    it('returns a tri-state decision that distinguishes unavailable configuration from a non-operator', () => {
        expect(getAnalysisAuditOperatorDecision(requestId, {})).toBe('unavailable');
        expect(getAnalysisAuditOperatorDecision(requestId, {
            ANALYSIS_AUDIT_OPERATOR_USER_IDS: '   ',
        })).toBe('unavailable');
        expect(getAnalysisAuditOperatorDecision(requestId, {
            ANALYSIS_AUDIT_OPERATOR_USER_IDS: 'not-a-uuid',
        })).toBe('unavailable');
        expect(getAnalysisAuditOperatorDecision(requestId, {
            ANALYSIS_AUDIT_OPERATOR_USER_IDS: `${requestId},${requestId}`,
        })).toBe('unavailable');
        expect(getAnalysisAuditOperatorDecision(requestId, {
            ANALYSIS_AUDIT_OPERATOR_USER_IDS: otherId,
        })).toBe('forbidden');
        expect(getAnalysisAuditOperatorDecision(requestId, {
            ANALYSIS_AUDIT_OPERATOR_USER_IDS: `${otherId}, ${requestId}`,
        })).toBe('authorized');
    });

    it('fails closed for absent, malformed, and nonmatching environment allowlists', () => {
        expect(isAnalysisAuditOperator(requestId, {})).toBe(false);
        expect(isAnalysisAuditOperator(requestId, { ANALYSIS_AUDIT_OPERATOR_USER_IDS: 'not-a-uuid' })).toBe(false);
        expect(isAnalysisAuditOperator(requestId, { ANALYSIS_AUDIT_OPERATOR_USER_IDS: otherId })).toBe(false);
        expect(isAnalysisAuditOperator(requestId, { ANALYSIS_AUDIT_OPERATOR_USER_IDS: `${requestId},` })).toBe(false);
        expect(isAnalysisAuditOperator(requestId, { ANALYSIS_AUDIT_OPERATOR_USER_IDS: `${requestId},${requestId}` })).toBe(false);
        expect(isAnalysisAuditOperator(requestId, { ANALYSIS_AUDIT_OPERATOR_USER_IDS: `${requestId},bad` })).toBe(false);
        expect(isAnalysisAuditOperator(requestId, { ANALYSIS_AUDIT_OPERATOR_USER_IDS: `${otherId}, ${requestId}` })).toBe(true);
    });

    it('bounds page input before a service RPC is reached', () => {
        expect(() => parseAnalysisAuditQuery(`https://example.test?a=x&requestId=${requestId}&pageSize=51`)).toThrow();
        expect(parseAnalysisAuditQuery(`https://example.test?requestId=${requestId}`)).toEqual({ requestId, cursor: 0, pageSize: 25 });
    });

    it('never materializes when the outbox claim is absent or malformed', async () => {
        const rpc = vi.fn(async () => ({ data: null, error: null }));
        await materializeQueuedAnalysisScoreAudit({ rpc }, requestId);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(rpc).toHaveBeenCalledWith('claim_analysis_v2_score_audit', { p_request_id: requestId });
    });

    it('captures the safe source through a dedicated pre-completion RPC', async () => {
        const rpc = vi.fn(async () => ({ data: { status: 'ready' }, error: null }));
        await captureAnalysisScoreAuditSource({ rpc }, requestId);
        expect(rpc).toHaveBeenCalledWith('capture_analysis_v2_score_audit_source', {
            p_request_id: requestId,
        });
    });

    it('maps every queue RPC failure to a stable non-sensitive error code', async () => {
        const failing = (expectedName: string) => ({
            rpc: vi.fn(async (name: string) => ({
                data: null,
                error: name === expectedName ? { message: 'secret provider detail' } : null,
            })),
        });
        await expect(captureAnalysisScoreAuditSource(
            failing('capture_analysis_v2_score_audit_source'), requestId
        )).rejects.toThrow('ANALYSIS_AUDIT_SOURCE_CAPTURE_FAILED');
        await expect(materializeQueuedAnalysisScoreAudit(
            failing('claim_analysis_v2_score_audit'), requestId
        )).rejects.toThrow('ANALYSIS_AUDIT_CLAIM_FAILED');

        const materializeFailure = {
            rpc: vi.fn(async (name: string) => name === 'claim_analysis_v2_score_audit'
                ? { data: { leaseToken: otherId }, error: null }
                : { data: null, error: { message: 'secret provider detail' } }),
        };
        await expect(materializeQueuedAnalysisScoreAudit(
            materializeFailure, requestId
        )).rejects.toThrow('ANALYSIS_AUDIT_MATERIALIZE_FAILED');

        await expect(recoverQueuedAnalysisScoreAudits(
            failing('purge_expired_analysis_v2_score_audit_evidence'), 5
        )).rejects.toThrow('ANALYSIS_AUDIT_EXPIRY_PURGE_FAILED');
        await expect(recoverQueuedAnalysisScoreAudits(
            failing('purge_failed_analysis_v2_score_audit_sources'), 5
        )).rejects.toThrow('ANALYSIS_AUDIT_PURGE_FAILED');
        await expect(recoverQueuedAnalysisScoreAudits(
            failing('list_analysis_v2_score_audit_candidates'), 5
        )).rejects.toThrow('ANALYSIS_AUDIT_LIST_FAILED');
    });

    it('uses only the safe server RPC and rejects invalid payloads', async () => {
        const rpc = vi.fn(async () => ({ data: { unsafe: true }, error: null }));
        await expect(loadAnalysisScoreAudit({ rpc }, { requestId })).rejects.toThrow();
        expect(rpc).toHaveBeenCalledWith('load_analysis_v2_score_audit', {
            p_request_id: requestId, p_cursor: 0, p_page_size: 25,
        });
    });

    it('recovers a bounded durable outbox without provider work', async () => {
        const rpc = vi.fn(async (name: string) => {
            if (name === 'list_analysis_v2_score_audit_candidates') {
                return { data: [{ request_id: requestId }, { request_id: 'not-a-uuid' }], error: null };
            }
            return { data: null, error: null };
        });
        await recoverQueuedAnalysisScoreAudits({ rpc }, 5);
        expect(rpc).toHaveBeenCalledWith('purge_expired_analysis_v2_score_audit_evidence', { p_limit: 100 });
        expect(rpc).toHaveBeenCalledWith('purge_failed_analysis_v2_score_audit_sources', { p_limit: 5 });
        expect(rpc).toHaveBeenCalledWith('list_analysis_v2_score_audit_candidates', { p_limit: 5 });
        expect(rpc).toHaveBeenCalledWith('claim_analysis_v2_score_audit', { p_request_id: requestId });
        expect(rpc).toHaveBeenCalledTimes(4);
    });
});
