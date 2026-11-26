import { NextResponse, type NextRequest } from 'next/server';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';

import { CHERRY_LANDING_PATH, CHERRY_PUBLIC_HOST, CHERRY_PUBLIC_URL } from '@/lib/constants/cherry-public-url';
export const CHERRY_LEGACY_URL = `${CANONICAL_APP_ORIGIN}/cherry`;

export function isCherryDomainLive(): boolean {
    return process.env.CHERRY_DOMAIN_LIVE === '1';
}

// Next may use its internal listener in nextUrl during proxy routing.
export function cherryRequestHostname(request: NextRequest): string {
    return request.headers.get('host')?.split(':')[0]?.toLowerCase() || request.nextUrl.hostname;
}

const PUBLIC_ASSET = /^\/cherry\/(?:(?:assets|3d)\/(?:[\w.-]+\/)*[\w.-]+|landing\.(?:css|js)|intro\.js|analytics\.js|campaign\.mjs|reservation-source\.mjs|logo\.png)$/;
const MAIN_PAGE = /^\/(?:privacy|cherry\/(?:start|home|reports\/[^/]+))$/;
const RESERVATIONS = '/api/cherry/reservations';

export function cherryDomainResponse(request: NextRequest): NextResponse | undefined {
    const { pathname, search } = request.nextUrl;
    const hostname = cherryRequestHostname(request);
    const reads = request.method === 'GET' || request.method === 'HEAD';
    if (pathname.replace(/%[\da-f]{2}/gi, (escape) => String.fromCharCode(parseInt(escape.slice(1), 16))) === CHERRY_LANDING_PATH) {
        return new NextResponse(null, { status: 404 });
    }
    const live = isCherryDomainLive();
    if (hostname === new URL(CANONICAL_APP_ORIGIN).hostname && reads && pathname === '/cherry' && live) {
        return NextResponse.redirect(CHERRY_PUBLIC_URL + search, {
            status: 308,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
    if (hostname !== CHERRY_PUBLIC_HOST) return;
    if (reads && (pathname === '/' || pathname === '/cherry')) {
        if (pathname === '/cherry') return NextResponse.redirect(CHERRY_PUBLIC_URL + search, 308);
        return NextResponse.next();
    }
    if (pathname === RESERVATIONS && (reads || request.method === 'POST')) return NextResponse.next();
    if (reads && PUBLIC_ASSET.test(pathname)) return NextResponse.next();
    if ((reads && pathname === '/_vercel/insights/script.js')
        || (request.method === 'POST' && /^\/_vercel\/insights\/(?:view|event)$/.test(pathname))) return NextResponse.next();
    if (reads && pathname === '/favicon.ico') return NextResponse.redirect(new URL('/cherry/logo.png', CHERRY_PUBLIC_URL), 308);
    if (reads && MAIN_PAGE.test(pathname)) {
        return NextResponse.redirect(CANONICAL_APP_ORIGIN + pathname + search, 308);
    }
    if (reads && pathname === '/robots.txt') {
        return new NextResponse(live
            ? `User-agent: *\nAllow: /$\nAllow: /?\nAllow: /cherry/\nAllow: /sitemap.xml$\nDisallow: /\nSitemap: ${CHERRY_PUBLIC_URL}sitemap.xml\n`
            : 'User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (reads && pathname === '/sitemap.xml' && live) {
        return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CHERRY_PUBLIC_URL}</loc></url></urlset>`, {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }
    return new NextResponse(null, { status: 404 });
}
