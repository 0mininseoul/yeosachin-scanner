import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    insert: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
    operationalEmit: vi.fn(),
    flushOperationalLogs: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/feedback/store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/feedback/store')>()),
    insertResultFeedback: mocks.insert,
}));
vi.mock('@/lib/observability/server', () => ({
    flushOperationalLogs: mocks.flushOperationalLogs,
    operationalLogger: { emit: mocks.operationalEmit },
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { POST } from '@/app/api/result-feedback/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';
import { ResultFeedbackPersistenceError } from '@/lib/services/feedback/store';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';

function request() {
    return new Request('https://example.com/api/result-feedback', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'https://example.com',
        },
        body: JSON.stringify({ requestId, body: '결과 의견' }),
    });
}

describe('result feedback account admission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
        mocks.from.mockReturnValue({
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                            data: { id: requestId },
                            error: null,
                        }),
                    }),
                }),
            }),
        });
        mocks.insert.mockResolvedValue(undefined);
        mocks.operationalEmit.mockImplementation(() => undefined);
        mocks.flushOperationalLogs.mockResolvedValue(undefined);
    });

    it('emits a sanitized operational success event after persistence', async () => {
        const response = await POST(request());

        expect(response.status).toBe(201);
        expect(mocks.operationalEmit).toHaveBeenCalledWith({
            event: 'result_feedback.persisted',
            severity: 'info',
            fields: { request_id: requestId },
        });
        expect(JSON.stringify(mocks.operationalEmit.mock.calls)).not.toContain('결과 의견');
    });

    it('emits a bounded operational failure event for an insert error', async () => {
        mocks.insert.mockRejectedValue(new ResultFeedbackPersistenceError('private database detail'));

        const response = await POST(request());

        expect(response.status).toBe(500);
        expect(mocks.operationalEmit).toHaveBeenCalledWith({
            event: 'result_feedback.persistence_failed',
            severity: 'error',
            fields: {
                request_id: requestId,
                error_code: 'RESULT_FEEDBACK_INSERT_FAILED',
            },
        });
        expect(JSON.stringify(mocks.operationalEmit.mock.calls)).not.toContain('private database detail');
    });

    it('maps an unexpected insert exception to INTERNAL_ERROR without leaking its message', async () => {
        mocks.insert.mockRejectedValue(new Error('private database detail'));

        const response = await POST(request());

        expect(response.status).toBe(500);
        expect(mocks.operationalEmit).toHaveBeenCalledWith({
            event: 'result_feedback.persistence_failed',
            severity: 'error',
            fields: {
                request_id: requestId,
                error_code: 'INTERNAL_ERROR',
            },
        });
        expect(JSON.stringify(mocks.operationalEmit.mock.calls)).not.toContain('private database detail');
    });

    it('keeps a logger failure fail-open for a successful feedback response', async () => {
        mocks.operationalEmit.mockImplementation(() => {
            throw new Error('logger unavailable');
        });

        await expect(POST(request())).resolves.toMatchObject({ status: 201 });
    });

    it('keeps a deferred flush failure fail-open for a successful feedback response', async () => {
        mocks.flushOperationalLogs.mockRejectedValue(new Error('flush unavailable'));

        await expect(POST(request())).resolves.toMatchObject({ status: 201 });
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('fails closed before an owner feedback write for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await POST(request());

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
    });
});
