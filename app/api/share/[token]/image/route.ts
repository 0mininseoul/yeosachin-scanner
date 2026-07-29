import { z } from 'zod';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    readAnalysisV2ResultImageObject,
    resolveAnalysisV2ResultImageLocator,
} from '@/lib/services/media/result-image-resolver';
import type {
    AnalysisV2ResultImageLocator,
} from '@/lib/services/media/image-proxy-token';
import {
    openV2SharedImageLocator,
} from '@/lib/services/share/v2-share-privacy';

export const runtime = 'nodejs';

const shareTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
const shareRecordSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    pipeline_version: z.literal('v2'),
    status: z.literal('completed'),
    share_enabled: z.literal(true),
}).strip();

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#171412"/><circle cx="80" cy="58" r="28" fill="#514a45"/><ellipse cx="80" cy="132" rx="48" ry="38" fill="#514a45"/></svg>`;

const IMAGE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'private, no-store',
    'Vercel-CDN-Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
} as const;

function jsonError(status: number) {
    return NextResponse.json(
        { error: status === 400 ? 'Invalid image request.' : 'Image not found.' },
        { status, headers: IMAGE_HEADERS }
    );
}

function placeholder() {
    return new NextResponse(PLACEHOLDER_SVG, {
        status: 200,
        headers: {
            ...IMAGE_HEADERS,
            'Content-Type': 'image/svg+xml',
            'Content-Length': String(Buffer.byteLength(PLACEHOLDER_SVG)),
            'Content-Security-Policy': "default-src 'none'; sandbox",
        },
    });
}

function parseLocator(
    url: URL,
    shareToken: string
): Omit<AnalysisV2ResultImageLocator, 'requestId'> | null {
    const keys = [...url.searchParams.keys()];
    if (
        new Set(keys).size !== keys.length
        || keys.some(key => key !== 'kind' && key !== 'locator')
    ) {
        return null;
    }
    const kind = url.searchParams.get('kind');
    if (kind === 'target') {
        return url.searchParams.get('locator') === null
            ? { kind: 'target', candidateId: null }
            : null;
    }
    if (kind !== null) return null;
    const sealedLocator = url.searchParams.get('locator');
    return sealedLocator
        ? openV2SharedImageLocator(shareToken, sealedLocator)
        : null;
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    const token = shareTokenSchema.safeParse((await params).token);
    if (!token.success) return jsonError(400);
    const locator = parseLocator(new URL(request.url), token.data);
    if (!locator) return jsonError(400);

    const { data, error } = await supabaseAdmin
        .from('analysis_requests')
        .select('id, user_id, pipeline_version, status, share_enabled')
        .eq('share_token', token.data)
        .eq('share_enabled', true)
        .eq('status', 'completed')
        .eq('pipeline_version', 'v2')
        .maybeSingle();
    const shareRecord = error ? null : shareRecordSchema.safeParse(data);
    if (!shareRecord || !shareRecord.success) return jsonError(404);

    const resolved = await resolveAnalysisV2ResultImageLocator(
        {
            requestId: shareRecord.data.id,
            ...locator,
        },
        shareRecord.data.user_id
    );
    if (resolved?.source !== 'r2') return placeholder();

    try {
        const bytes = await readAnalysisV2ResultImageObject(resolved);
        const downsampled = await sharp(bytes, {
            failOn: 'error',
            limitInputPixels: 16_777_216,
        })
            .rotate()
            .resize(24, 24, {
                fit: 'cover',
                position: 'centre',
                withoutEnlargement: true,
            })
            .webp({ quality: 42, effort: 4 })
            .toBuffer();
        return new NextResponse(new Uint8Array(downsampled), {
            status: 200,
            headers: {
                ...IMAGE_HEADERS,
                'Content-Type': 'image/webp',
                'Content-Length': String(downsampled.byteLength),
            },
        });
    } catch {
        return placeholder();
    }
}
