import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    loadPage: vi.fn(),
    isResultAuthoritativelyPublished: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));
vi.mock('@/lib/services/share/v2-result-share', () => ({
    v2ShareResultService: { loadPage: mocks.loadPage },
}));
vi.mock('@/lib/services/analysis/result-publication-authority', () => ({
    isAnalysisResultAuthoritativelyPublished: mocks.isResultAuthoritativelyPublished,
}));

import { generateMetadata } from '@/app/share/[token]/layout';

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

describe('shared result metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.from.mockReturnValue(record({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v1',
            status: 'completed',
            share_enabled: true,
            target_instagram_id: 'bhaa365p',
        }));
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
    });

    it('uses the result-specific square OG endpoint for a legacy share', async () => {
        const metadata = await generateMetadata({
            params: Promise.resolve({ token }),
        });

        expect(metadata.openGraph).toMatchObject({
            images: [{
                url: `https://yeosachin.com/api/share/${token}/opengraph-image`,
                width: 800,
                height: 800,
            }],
        });
        expect(metadata.openGraph).not.toMatchObject({
            images: [{ url: '/og.png' }],
        });
        expect(metadata.alternates).toEqual({
            canonical: `https://yeosachin.com/share/${token}`,
        });
    });

    it('uses a lighter avatar blur in shared reports', () => {
        const caseUi = readFileSync(new URL('../../../components/case-ui.tsx', import.meta.url), 'utf8');
        expect(caseUi).toMatch(/export const MASK_AVATAR_BLUR_PX = 3;/);
    });
});
