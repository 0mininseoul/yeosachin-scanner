import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import { v2ShareResultService } from '@/lib/services/share/v2-result-share';
import {
    readAnalysisV2ResultImageObject,
    resolveAnalysisV2ResultImageLocator,
} from '@/lib/services/media/result-image-resolver';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';

export const runtime = 'nodejs';

/** Rendered size of the avatar on the card; the source is re-encoded to match. */
const AVATAR_PX = 300;

const shareTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
const shareRecordSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    pipeline_version: z.union([z.literal('v1'), z.literal('v2'), z.null()]),
    status: z.literal('completed'),
    share_enabled: z.literal(true),
    target_instagram_id: z.string().min(1).max(255).optional(),
}).strip();

const NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'private, no-store',
    'Vercel-CDN-Cache-Control': 'private, no-store',
} as const;

/* The card image is fetched by chat clients, not by the owner's browser, and
 * they give it a short deadline. Rendering it costs a DB read, an R2 read, a
 * font read and a satori pass, so serving it no-store meant paying all of that
 * on every single scrape.
 *
 * Only reachable with the 64-hex share token, and only while the owner keeps
 * sharing enabled — revoking clears the token, so a cached copy can no longer
 * be addressed. Kept off the browser cache so a revoked link does not linger in
 * one, while the CDN absorbs the repeated scrapes. */
const SHARE_IMAGE_CACHE_HEADERS = {
    'Cache-Control': 'public, no-store, max-age=0',
    'CDN-Cache-Control': 'public, max-age=600',
    'Vercel-CDN-Cache-Control': 'public, max-age=600',
} as const;
const paperlogyFont = readFile(
    path.join(
        process.cwd(),
        'app',
        'fonts',
        'paperlogy',
        'Paperlogy-7Bold.woff'
    )
);

function notFound() {
    return NextResponse.json(
        { error: 'Share image not found.' },
        { status: 404, headers: NO_STORE_HEADERS }
    );
}

/* Square, because KakaoTalk renders the feed thumbnail square and centre-crops
   anything wider — a 2:1 card lost its avatar on one edge and its headline on
   the other. Laying the card out vertically means nothing has to survive a crop.
   Legacy V1 shares use the same card, instead of falling back to the site-wide
   1200x630 landing image. */
const CARD_PX = 800;

function ogCard(displayName: string, imageDataUrl: string | null) {
    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 56,
                padding: '72px 64px',
                color: '#f7f2ed',
                background:
                    'radial-gradient(circle at 50% 22%, #4a181f 0%, #17120f 46%, #0d0b0a 100%)',
                fontFamily: 'Paperlogy',
            }}
        >
            {imageDataUrl ? (
                <img
                    src={imageDataUrl}
                    alt=""
                    width={AVATAR_PX}
                    height={AVATAR_PX}
                    style={{
                        width: AVATAR_PX,
                        height: AVATAR_PX,
                        objectFit: 'cover',
                        borderRadius: AVATAR_PX / 2,
                        border: '8px solid #ef233c',
                        boxShadow: '0 24px 72px rgba(0,0,0,.5)',
                    }}
                />
            ) : (
                <div
                    style={{
                        width: AVATAR_PX,
                        height: AVATAR_PX,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: AVATAR_PX / 2,
                        border: '8px solid #ef233c',
                        color: '#ef233c',
                        background: '#211b18',
                        fontSize: 120,
                        fontWeight: 800,
                    }}
                >
                    ?
                </div>
            )}
            <div
                style={{
                    display: 'flex',
                    maxWidth: 640,
                    fontSize: 60,
                    fontWeight: 900,
                    lineHeight: 1.28,
                    textAlign: 'center',
                    wordBreak: 'keep-all',
                }}
            >
                {displayName}님의 위장 여사친을 찾았어요
            </div>
        </div>
    );
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    const token = shareTokenSchema.safeParse((await params).token);
    if (!token.success) return notFound();

    const { data, error } = await supabaseAdmin
        .from('analysis_requests')
        .select('id, user_id, pipeline_version, status, share_enabled, target_instagram_id')
        .eq('share_token', token.data)
        .eq('share_enabled', true)
        .eq('status', 'completed')
        .maybeSingle();
    const shareRecord = error ? null : shareRecordSchema.safeParse(data);
    if (!shareRecord || !shareRecord.success) return notFound();
    if (!await isAnalysisResultAuthoritativelyPublished(shareRecord.data.id)) {
        return notFound();
    }

    let displayName = shareRecord.data.target_instagram_id ?? '';
    if (shareRecord.data.pipeline_version !== 'v2' && !displayName) {
        return notFound();
    }
    let imageDataUrl: string | null = null;
    if (shareRecord.data.pipeline_version === 'v2') {
        let page: Awaited<ReturnType<typeof v2ShareResultService.loadPage>>;
        try {
            page = await v2ShareResultService.loadPage({
                requestId: shareRecord.data.id,
                ownerUserId: shareRecord.data.user_id,
                shareToken: token.data,
                femaleCursor: null,
                privateCursor: null,
                pageSize: 1,
            });
        } catch {
            return notFound();
        }
        if (!page) return notFound();

        displayName = page.summary.targetFullName?.trim()
            || page.summary.targetInstagramId;

        const resolved = await resolveAnalysisV2ResultImageLocator(
            {
                requestId: shareRecord.data.id,
                kind: 'target',
                candidateId: null,
            },
            shareRecord.data.user_id
        );
        if (resolved?.source === 'r2') {
            try {
                const bytes = await readAnalysisV2ResultImageObject(resolved);
                /* Result images are stored as WebP, which the OG renderer cannot
                   decode — it fails with "u2 is not iterable" while measuring the
                   image, taking the whole card down with it. Re-encoding as PNG at
                   the size the card actually draws also keeps the data URL small. */
                const png = await sharp(bytes, { animated: false, failOn: 'error' })
                    .resize(AVATAR_PX, AVATAR_PX, { fit: 'cover' })
                    .png()
                    .toBuffer();
                imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
            } catch {
                imageDataUrl = null;
            }
        }
    }

    let response: Response;
    try {
        const font = await paperlogyFont;
        response = new ImageResponse(
            ogCard(displayName, imageDataUrl),
            {
                width: CARD_PX,
                height: CARD_PX,
                fonts: [{
                    name: 'Paperlogy',
                    data: font,
                    weight: 700,
                    style: 'normal',
                }],
            }
        );
    } catch {
        /* The renderer rejects input this route cannot fully predict — a display
           name is whatever Instagram holds. A chat client showing the generic
           card beats one showing nothing, which is what a 500 gets you. */
        console.error('Share OG render failed');
        return NextResponse.redirect(new URL('/og.png', CANONICAL_APP_ORIGIN), 302);
    }
    for (const [name, value] of Object.entries(SHARE_IMAGE_CACHE_HEADERS)) {
        response.headers.set(name, value);
    }
    return response;
}
