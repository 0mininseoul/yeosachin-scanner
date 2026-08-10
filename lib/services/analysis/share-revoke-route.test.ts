import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    demoFind: vi.fn(),
    generateToken: vi.fn(),
    loadPage: vi.fn(),
    resolveImage: vi.fn(),
    readImage: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { findForOwner: mocks.demoFind },
}));
vi.mock('@/lib/services/share/generate-token', () => ({
    generateShareToken: mocks.generateToken,
}));
vi.mock('@/lib/services/share/v2-result-share', () => ({
    v2ShareResultService: { loadPage: mocks.loadPage },
}));
vi.mock('@/lib/services/media/result-image-resolver', () => ({
    resolveAnalysisV2ResultImageLocator: mocks.resolveImage,
    readAnalysisV2ResultImageObject: mocks.readImage,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));
vi.mock('next/og', () => ({
    ImageResponse: class extends Response {
        constructor() {
            super('rendered-og', {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
    },
}));

import * as shareEnableRoute from '@/app/api/share/enable/route';
import { GET as sharedResult } from '@/app/api/share/[token]/route';
import { GET as sharedImage } from '@/app/api/share/[token]/image/route';
import { GET as sharedOpenGraphImage } from '@/app/api/share/[token]/opengraph-image/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';
const oldToken = 'a'.repeat(64);
const newToken = 'b'.repeat(64);

interface ShareRecord {
    id: string;
    user_id: string;
    pipeline_version: string | null;
    status: string;
    share_token: string | null;
    share_enabled: boolean | null;
}

interface Conditions {
    eq: Array<[string, unknown]>;
    is: Array<[string, unknown]>;
    or: string[];
}

function matches(record: ShareRecord, conditions: Conditions) {
    if (
        conditions.eq.some(
            ([column, value]) => record[column as keyof ShareRecord] !== value
        )
    ) {
        return false;
    }
    if (
        conditions.is.some(
            ([column, value]) => record[column as keyof ShareRecord] !== value
        )
    ) {
        return false;
    }
    return conditions.or.every(filter => {
        if (filter === 'pipeline_version.eq.v2') {
            return record.pipeline_version === 'v2';
        }
        if (filter === 'pipeline_version.eq.v1,pipeline_version.is.null') {
            return record.pipeline_version === 'v1'
                || record.pipeline_version === null;
        }
        if (filter === 'share_enabled.eq.false,share_enabled.is.null') {
            return record.share_enabled === false
                || record.share_enabled === null;
        }
        return false;
    });
}

function installShareStore(initial: ShareRecord) {
    let state = { ...initial };
    const mutations: Array<{
        patch: Partial<ShareRecord>;
        conditions: Conditions;
    }> = [];

    mocks.from.mockImplementation(() => {
        let mode: 'read' | 'update' = 'read';
        let patch: Partial<ShareRecord> = {};
        const conditions: Conditions = { eq: [], is: [], or: [] };
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
            update: vi.fn((value: Partial<ShareRecord>) => {
                mode = 'update';
                patch = value;
                return chain;
            }),
            single: vi.fn(async () => (
                matches(state, conditions)
                    ? { data: { ...state }, error: null }
                    : { data: null, error: { code: 'PGRST116' } }
            )),
            maybeSingle: vi.fn(async () => {
                if (!matches(state, conditions)) {
                    return { data: null, error: null };
                }
                if (mode === 'update') {
                    mutations.push({
                        patch: { ...patch },
                        conditions: {
                            eq: [...conditions.eq],
                            is: [...conditions.is],
                            or: [...conditions.or],
                        },
                    });
                    state = { ...state, ...patch };
                }
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

type RevokeHandler = (
    request: Request
) => Promise<Response>;

function revokeHandler(): RevokeHandler | undefined {
    return (
        shareEnableRoute as typeof shareEnableRoute & {
            DELETE?: RevokeHandler;
        }
    ).DELETE;
}

function tokenContext(token: string) {
    return { params: Promise.resolve({ token }) };
}

describe('owner share revoke lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({
            auth: { getUser: mocks.getUser },
        });
        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId } },
            error: null,
        });
        mocks.demoFind.mockResolvedValue(null);
        mocks.generateToken.mockReturnValue(newToken);
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    it('requires an authenticated owner before reading or mutating a share', async () => {
        mocks.getUser.mockResolvedValue({
            data: { user: null },
            error: new Error('not authenticated'),
        });
        const revoke = revokeHandler();

        expect(revoke).toBeTypeOf('function');
        if (!revoke) return;
        const response = await revoke(new Request(
            'https://example.com/api/share/enable',
            {
                method: 'DELETE',
                body: JSON.stringify({ requestId }),
            }
        ));

        expect(response.status).toBe(401);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('fails closed before revoking a share for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );
        const revoke = revokeHandler();

        expect(revoke).toBeTypeOf('function');
        if (!revoke) return;
        const response = await revoke(new Request(
            'https://example.com/api/share/enable',
            {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId }),
            },
        ));

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('CAS-revokes a completed V2 share, closes every public route, and rotates on re-enable', async () => {
        const store = installShareStore({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'completed',
            share_token: oldToken,
            share_enabled: true,
        });
        const revoke = revokeHandler();

        expect(revoke).toBeTypeOf('function');
        if (!revoke) return;
        const revokeResponse = await revoke(new Request(
            'https://example.com/api/share/enable',
            {
                method: 'DELETE',
                body: JSON.stringify({ requestId }),
            }
        ));

        expect(revokeResponse.status).toBe(200);
        await expect(revokeResponse.json()).resolves.toEqual({ success: true });
        expect(store.record()).toMatchObject({
            share_enabled: false,
            share_token: null,
        });
        expect(store.mutations).toEqual([{
            patch: {
                share_enabled: false,
                share_token: null,
            },
            conditions: {
                eq: expect.arrayContaining([
                    ['id', requestId],
                    ['user_id', userId],
                    ['status', 'completed'],
                    ['share_enabled', true],
                    ['share_token', oldToken],
                ]),
                is: [],
                or: ['pipeline_version.eq.v2'],
            },
        }]);

        const publicResponses = await Promise.all([
            sharedResult(
                new Request(`https://example.com/api/share/${oldToken}`),
                tokenContext(oldToken)
            ),
            sharedImage(
                new Request(
                    `https://example.com/api/share/${oldToken}/image?kind=target`
                ),
                tokenContext(oldToken)
            ),
            sharedOpenGraphImage(
                new Request(
                    `https://example.com/api/share/${oldToken}/opengraph-image`
                ),
                tokenContext(oldToken)
            ),
        ]);
        expect(publicResponses.map(response => response.status)).toEqual([
            404,
            404,
            404,
        ]);
        expect(mocks.loadPage).not.toHaveBeenCalled();
        expect(mocks.resolveImage).not.toHaveBeenCalled();

        const enableResponse = await shareEnableRoute.POST(new Request(
            'https://example.com/api/share/enable',
            {
                method: 'POST',
                body: JSON.stringify({ requestId }),
            }
        ));
        const enableBody = await enableResponse.json();

        expect(enableResponse.status).toBe(200);
        expect(enableBody.shareToken).toBe(newToken);
        expect(enableBody.shareToken).not.toBe(oldToken);
        expect(store.record()).toMatchObject({
            share_enabled: true,
            share_token: newToken,
        });
    });
});
