import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { parseCherryVariant, renderCherryLanding } from '@/lib/services/cherry/landing-variant';

// Read once per instance: Meta ad clicks carry a unique fbclid, so most of them miss the CDN cache.
const landing = readFile(path.join(process.cwd(), 'public/cherry/landing.html'), 'utf8');

export async function GET(request: NextRequest) {
    const html = renderCherryLanding(await landing, {
        variant: parseCherryVariant(request.nextUrl.searchParams.get('v')),
        pixelId: process.env.CHERRY_META_PIXEL_ID?.trim() || null,
    });
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
        },
    });
}
