import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    loadPage: vi.fn(),
    resolve: vi.fn(),
    read: vi.fn(),
    captures: [] as Array<{ element: unknown; options: unknown }>,
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));
vi.mock('@/lib/services/share/v2-result-share', () => ({
    v2ShareResultService: { loadPage: mocks.loadPage },
}));
vi.mock('@/lib/services/media/result-image-resolver', () => ({
    resolveAnalysisV2ResultImageLocator: mocks.resolve,
    readAnalysisV2ResultImageObject: mocks.read,
}));
vi.mock('next/og', () => ({
    ImageResponse: class extends Response {
        constructor(element: unknown, options: unknown) {
            mocks.captures.push({ element, options });
            super('rendered-og', {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
    },
}));

import { GET } from '@/app/api/share/[token]/opengraph-image/route';
import { TINY_WEBP } from './tiny-image-fixture';

const token = 'a'.repeat(64);
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function record(value: Record<string, unknown> | null) {
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: value, error: null });
    return chain;
}

function context(rawToken = token) {
    return { params: Promise.resolve({ token: rawToken }) };
}

function textOf(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    const object = value as Record<string, unknown>;
    const props = object.props as Record<string, unknown> | undefined;
    return props ? textOf(props.children) : Array.isArray(value)
        ? value.map(textOf).join('')
        : '';
}

function containsImage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsImage);
    const object = value as Record<string, unknown>;
    if (object.type === 'img') return true;
    const props = object.props as Record<string, unknown> | undefined;
    return props ? containsImage(props.children) : false;
}

describe('V2 dynamic share Open Graph image', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.captures.length = 0;
        mocks.from.mockReturnValue(record({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'completed',
            share_enabled: true,
        }));
        mocks.loadPage.mockResolvedValue({
            summary: {
                targetInstagramId: 'target.user',
                targetFullName: '김준호',
            },
        });
        mocks.resolve.mockResolvedValue({
            source: 'r2',
            objectKey: `v1/${'b'.repeat(32)}/target/${'c'.repeat(32)}.webp`,
            sha256: 'd'.repeat(64),
            byteSize: 4,
            expiresAt: '2026-08-28T00:00:00.000Z',
        });
        mocks.read.mockResolvedValue(TINY_WEBP);
    });

    it('renders an 800x800 result-specific card with an inline R2 target image', async () => {
        const response = await GET(
            new Request(
                `https://example.com/api/share/${token}/opengraph-image`
            ),
            context()
        );

        expect(response.status).toBe(200);
        expect(mocks.captures[0]?.options).toMatchObject({
            width: 800,
            height: 800,
            fonts: [{
                name: 'Paperlogy',
                weight: 700,
                style: 'normal',
            }],
        });
        expect(textOf(mocks.captures[0]?.element)).toContain(
            '김준호님의 위장 여사친을 찾았어요'
        );
        expect(textOf(mocks.captures[0]?.element)).not.toMatch(
            /고위험\s*\d|주의\s*\d|점수\s*\d/u
        );
        expect(containsImage(mocks.captures[0]?.element)).toBe(true);
        expect(mocks.resolve).toHaveBeenCalledWith(
            { requestId, kind: 'target', candidateId: null },
            userId
        );
        expect(mocks.loadPage).toHaveBeenCalledWith({
            requestId,
            ownerUserId: userId,
            shareToken: token,
            femaleCursor: null,
            privateCursor: null,
            pageSize: 1,
        });
    });

    it('renders a status-200 text fallback when the target image cannot load', async () => {
        mocks.read.mockRejectedValue(new Error('r2 unavailable'));
        const response = await GET(
            new Request(
                `https://example.com/api/share/${token}/opengraph-image`
            ),
            context()
        );
        expect(response.status).toBe(200);
        expect(textOf(mocks.captures[0]?.element)).toContain(
            '김준호님의 위장 여사친을 찾았어요'
        );
        expect(containsImage(mocks.captures[0]?.element)).toBe(false);
    });

    it('fails closed for revoked tokens without loading result or R2 data', async () => {
        mocks.from.mockReturnValue(record(null));
        const response = await GET(
            new Request(
                `https://example.com/api/share/${token}/opengraph-image`
            ),
            context()
        );
        expect(response.status).toBe(404);
        expect(mocks.loadPage).not.toHaveBeenCalled();
        expect(mocks.resolve).not.toHaveBeenCalled();
    });
});
