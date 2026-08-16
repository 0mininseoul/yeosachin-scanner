import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import { v2ShareResultService } from '@/lib/services/share/v2-result-share';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';

/* The page itself is a client component and so cannot carry metadata. This
 * layout exists only to give the link its own card.
 *
 * Kakao is handed the card directly by the SDK and never reads these tags, but
 * every other surface does — Instagram DM, iMessage, Slack — and until now they
 * all fell back to the site-wide og.png, so a shared result looked identical to
 * the homepage. */

const shareTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
const shareRecordSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    pipeline_version: z.union([z.literal('v1'), z.literal('v2'), z.null()]),
    status: z.literal('completed'),
    share_enabled: z.literal(true),
    target_instagram_id: z.string().min(1).max(255).optional(),
}).strip();

const FALLBACK: Metadata = {
    title: '위장여사친 판독기',
    openGraph: {
        title: '위장여사친 판독기',
        images: [{ url: '/og.png', width: 1200, height: 630 }],
    },
};

async function displayNameFor(token: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin
        .from('analysis_requests')
        .select('id, user_id, pipeline_version, status, share_enabled, target_instagram_id')
        .eq('share_token', token)
        .eq('share_enabled', true)
        .eq('status', 'completed')
        .maybeSingle();
    if (error) return null;
    const record = shareRecordSchema.safeParse(data);
    if (!record.success) return null;
    if (!await isAnalysisResultAuthoritativelyPublished(record.data.id)) return null;

    if (record.data.pipeline_version !== 'v2') {
        return record.data.target_instagram_id ?? null;
    }

    const page = await v2ShareResultService.loadPage({
        requestId: record.data.id,
        ownerUserId: record.data.user_id,
        shareToken: token,
        femaleCursor: null,
        privateCursor: null,
        pageSize: 1,
    });
    if (!page) return null;
    return page.summary.targetFullName?.trim() || page.summary.targetInstagramId;
}

export async function generateMetadata(
    { params }: { params: Promise<{ token: string }> },
): Promise<Metadata> {
    const token = shareTokenSchema.safeParse((await params).token);
    if (!token.success) return FALLBACK;

    let displayName: string | null = null;
    try {
        displayName = await displayNameFor(token.data);
    } catch {
        // A revoked or unreadable link still gets the generic card.
    }
    if (!displayName) return FALLBACK;

    /* No `robots: noindex` here. Instagram's preview fetcher stopped at the
       title and never asked for the image while it was set, and the 64-hex token
       is what keeps this page unreachable — a crawler cannot guess a URL it has
       never seen, and a directive is not what was protecting it. */
    // Same words the Kakao card and the OG image already use.
    const title = `${displayName}님의 위장 여사친 판독 결과`;
    const description = '지금 바로 확인해보세요!';
    const image = `${CANONICAL_APP_ORIGIN}/api/share/${token.data}/opengraph-image`;

    return {
        title,
        description,
        openGraph: {
            type: 'website',
            locale: 'ko_KR',
            siteName: '위장여사친 판독기',
            title,
            description,
            url: `${CANONICAL_APP_ORIGIN}/share/${token.data}`,
            images: [{ url: image, width: 800, height: 800, alt: title }],
        },
        twitter: { card: 'summary_large_image', title, description, images: [image] },
    };
}

export default function ShareLayout({ children }: { children: ReactNode }) {
    return children;
}
