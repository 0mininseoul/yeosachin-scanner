import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    demoFind: vi.fn(),
    generateToken: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { findForOwner: mocks.demoFind },
}));
vi.mock('@/lib/services/share/generate-token', () => ({
    generateShareToken: mocks.generateToken,
}));

import { POST as enableShare } from '@/app/api/share/enable/route';
import { GET as sharedResult } from '@/app/api/share/[token]/route';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(64);

function requestChain(record: Record<string, unknown> | null) {
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        is: vi.fn(),
        or: vi.fn(),
        single: vi.fn(),
        maybeSingle: vi.fn(),
        update: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain);
    chain.or.mockReturnValue(chain);
    chain.update.mockReturnValue(chain);
    chain.single.mockResolvedValue({ data: record, error: record ? null : { code: 'PGRST116' } });
    chain.maybeSingle.mockResolvedValue({ data: record, error: null });
    return chain;
}

interface ConcurrentShareRecord {
    id: string;
    user_id: string;
    pipeline_version: string | null;
    status: string;
    share_token: string | null;
    share_enabled: boolean;
}

function installConcurrentShareStore(initial: ConcurrentShareRecord) {
    let state = { ...initial };
    let initialReadCount = 0;
    let releaseInitialReads: (() => void) | null = null;
    const initialReadGate = new Promise<void>(resolve => {
        releaseInitialReads = resolve;
    });
    const mutations: Array<{
        eq: Array<[string, unknown]>;
        is: Array<[string, unknown]>;
        or: string[];
    }> = [];

    mocks.from.mockImplementation(() => {
        let mode: 'read' | 'update' = 'read';
        let patch: Partial<ConcurrentShareRecord> = {};
        const conditions = {
            eq: [] as Array<[string, unknown]>,
            is: [] as Array<[string, unknown]>,
            or: [] as string[],
        };
        const chain = {
            select: vi.fn(() => chain),
            eq: vi.fn((column: string, value: unknown) => {
                conditions.eq.push([column, value]);
                return chain;
            }),
            is: vi.fn((column: string, value: unknown) => {
                conditions.is.push([column, value]);
                return chain;
            }),
            or: vi.fn((filter: string) => {
                conditions.or.push(filter);
                return chain;
            }),
            update: vi.fn((value: Partial<ConcurrentShareRecord>) => {
                mode = 'update';
                patch = value;
                mutations.push(conditions);
                return chain;
            }),
            single: vi.fn(async () => {
                const snapshot = { ...state };
                initialReadCount += 1;
                if (initialReadCount === 2) releaseInitialReads?.();
                await initialReadGate;
                return { data: snapshot, error: null };
            }),
            maybeSingle: vi.fn(async () => {
                if (mode === 'read') {
                    const shareEnabled = conditions.eq.find(([column]) => column === 'share_enabled')?.[1];
                    return {
                        data: shareEnabled === true && state.share_enabled ? { ...state } : null,
                        error: null,
                    };
                }
                const requiresNullToken = conditions.is.some(
                    ([column, value]) => column === 'share_token' && value === null
                );
                if (requiresNullToken && state.share_token !== null) {
                    return { data: null, error: null };
                }
                const expectedToken = conditions.eq.find(
                    ([column]) => column === 'share_token'
                )?.[1];
                if (expectedToken !== undefined && state.share_token !== expectedToken) {
                    return { data: null, error: null };
                }
                const requiresInactiveShare = conditions.or.includes(
                    'share_enabled.eq.false,share_enabled.is.null'
                );
                if (requiresInactiveShare && state.share_enabled) {
                    return { data: null, error: null };
                }
                state = { ...state, ...patch };
                return { data: { ...state }, error: null };
            }),
        };
        return chain;
    });

    return {
        mutations,
        record: () => ({ ...state }),
    };
}

describe('V2 share isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.demoFind.mockResolvedValue(null);
        mocks.generateToken.mockReturnValue('b'.repeat(64));
    });

    it('rejects a completed V2 owner request before token mutation', async () => {
        const request = requestChain({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'completed',
            share_token: null,
            share_enabled: false,
        });
        mocks.from.mockReturnValue(request);

        const response = await enableShare(new Request('https://example.com/api/share/enable', {
            method: 'POST',
            body: JSON.stringify({ requestId }),
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'V2_SHARE_UNSUPPORTED',
            error: '이 판독 결과는 아직 공유할 수 없습니다.',
        });
        expect(request.update).not.toHaveBeenCalled();
        expect(request.select).toHaveBeenCalledWith(
            'id, user_id, pipeline_version, status, share_token, share_enabled'
        );
    });

    it.each([null, 'v1'] as const)(
        'keeps an already-enabled completed legacy (%s) share token intact',
        async pipelineVersion => {
            const request = requestChain({
                id: requestId,
                user_id: userId,
                pipeline_version: pipelineVersion,
                status: 'completed',
                share_token: token,
                share_enabled: true,
            });
            mocks.from.mockReturnValue(request);

            const response = await enableShare(new Request('https://example.com/api/share/enable', {
                method: 'POST',
                body: JSON.stringify({ requestId }),
            }));

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({ success: true, shareToken: token });
            expect(request.update).not.toHaveBeenCalled();
        }
    );

    it.each(['v2', 'v3', '', 'malformed'] as const)(
        'rejects unsupported pipeline %s before token mutation',
        async pipelineVersion => {
            const request = requestChain({
                id: requestId,
                user_id: userId,
                pipeline_version: pipelineVersion,
                status: 'completed',
                share_token: null,
                share_enabled: false,
            });
            mocks.from.mockReturnValue(request);

            const response = await enableShare(new Request('https://example.com/api/share/enable', {
                method: 'POST',
                body: JSON.stringify({ requestId }),
            }));

            expect(response.status).toBe(409);
            await expect(response.json()).resolves.toMatchObject({
                code: pipelineVersion === 'v2'
                    ? 'V2_SHARE_UNSUPPORTED'
                    : 'SHARE_PIPELINE_UNSUPPORTED',
            });
            expect(request.update).not.toHaveBeenCalled();
        }
    );

    it('returns the one committed winner token to concurrent no-token requests', async () => {
        mocks.generateToken
            .mockReturnValueOnce('b'.repeat(64))
            .mockReturnValueOnce('c'.repeat(64));
        const store = installConcurrentShareStore({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v1',
            status: 'completed',
            share_token: null,
            share_enabled: false,
        });
        const post = () => enableShare(new Request('https://example.com/api/share/enable', {
            method: 'POST',
            body: JSON.stringify({ requestId }),
        }));

        const responses = await Promise.all([post(), post()]);
        const bodies = await Promise.all(responses.map(response => response.json()));

        expect(responses.map(response => response.status)).toEqual([200, 200]);
        expect(bodies[0].shareToken).toBe(bodies[1].shareToken);
        expect(bodies[0].shareUrl).toBe(bodies[1].shareUrl);
        expect(bodies[0].shareToken).toBe(store.record().share_token);
        expect(store.record().share_enabled).toBe(true);
        expect(store.mutations).toHaveLength(2);
        for (const mutation of store.mutations) {
            expect(mutation.eq).toEqual(expect.arrayContaining([
                ['id', requestId],
                ['user_id', userId],
                ['status', 'completed'],
            ]));
            expect(mutation.is).toContainEqual(['share_token', null]);
            expect(mutation.or).toContain('pipeline_version.eq.v1,pipeline_version.is.null');
        }
    });

    it('conditionally re-enables one stored token and rereads the winner under concurrency', async () => {
        const store = installConcurrentShareStore({
            id: requestId,
            user_id: userId,
            pipeline_version: null,
            status: 'completed',
            share_token: token,
            share_enabled: false,
        });
        const post = () => enableShare(new Request('https://example.com/api/share/enable', {
            method: 'POST',
            body: JSON.stringify({ requestId }),
        }));

        const responses = await Promise.all([post(), post()]);
        const bodies = await Promise.all(responses.map(response => response.json()));

        expect(responses.map(response => response.status)).toEqual([200, 200]);
        expect(bodies.map(body => body.shareToken)).toEqual([token, token]);
        expect(store.record()).toMatchObject({ share_token: token, share_enabled: true });
        expect(mocks.generateToken).not.toHaveBeenCalled();
        expect(store.mutations).toHaveLength(2);
        for (const mutation of store.mutations) {
            expect(mutation.eq).toContainEqual(['share_token', token]);
            expect(mutation.or).toEqual(expect.arrayContaining([
                'pipeline_version.eq.v1,pipeline_version.is.null',
                'share_enabled.eq.false,share_enabled.is.null',
            ]));
        }
    });

    it.each(['v2', 'future', 'malformed'] as const)(
        'fails closed for a stale %s public token before legacy result reads',
        async pipelineVersion => {
            const request = requestChain({
                id: requestId,
                pipeline_version: pipelineVersion,
                status: 'completed',
                share_token: token,
                share_enabled: true,
            });
            mocks.from.mockReturnValue(request);

            const response = await sharedResult(
                new Request(`https://example.com/api/share/${token}`),
                { params: Promise.resolve({ token }) },
            );

            expect(response.status).toBe(404);
            await expect(response.json()).resolves.toEqual({
                error: '공유 링크를 찾을 수 없거나 비활성화되었습니다.',
            });
            expect(mocks.from).toHaveBeenCalledTimes(1);
            expect(mocks.from).toHaveBeenCalledWith('analysis_requests');
            expect(request.select).toHaveBeenCalledWith('*');
        }
    );
});
