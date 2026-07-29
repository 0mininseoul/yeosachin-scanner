import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    loadPage: vi.fn(),
    resolve: vi.fn(),
    read: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/share/v2-result-share', () => ({
    v2ShareResultService: { loadPage: mocks.loadPage },
}));
vi.mock('@/lib/services/media/result-image-resolver', () => ({
    resolveAnalysisV2ResultImageLocator: mocks.resolve,
    readAnalysisV2ResultImageObject: mocks.read,
}));
// next/og deliberately NOT mocked — the point is to run the real renderer.

import { GET } from '@/app/api/share/[token]/opengraph-image/route';
import { TINY_WEBP } from './tiny-image-fixture';

const token = 'a'.repeat(64);
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function record(value: Record<string, unknown> | null) {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: value, error: null });
    return chain;
}

describe('share OG image actually renders', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.from.mockReturnValue(record({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'completed',
            share_enabled: true,
        }));
        mocks.resolve.mockResolvedValue(null);
    });

    it('produces a real image for a plain Korean name', async () => {
        mocks.loadPage.mockResolvedValue({
            summary: { targetFullName: '박영민', targetInstagramId: 'youngmin' },
        });
        const response = await GET(new Request('https://yeosachin.com'), {
            params: Promise.resolve({ token }),
        });
        expect(response.status).toBe(200);
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(1000);
    }, 30000);

    /* The avatar is the branch production actually takes, and the one the
       first version of this test skipped by resolving the locator to null. */
    it('renders with the target avatar embedded', async () => {
        mocks.loadPage.mockResolvedValue({
            summary: { targetFullName: '박영민', targetInstagramId: 'youngmin' },
        });
        mocks.resolve.mockResolvedValue({ source: 'r2', key: 'x' });
        mocks.read.mockResolvedValue(TINY_WEBP);

        const response = await GET(new Request('https://yeosachin.com'), {
            params: Promise.resolve({ token }),
        });
        expect(response.status).toBe(200);
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(1000);
    }, 30000);

    it('survives a display name with an emoji in it', async () => {
        mocks.loadPage.mockResolvedValue({
            summary: { targetFullName: '영민 🌸✨', targetInstagramId: 'youngmin' },
        });
        const response = await GET(new Request('https://yeosachin.com'), {
            params: Promise.resolve({ token }),
        });
        expect(response.status).toBe(200);
    }, 30000);
});
