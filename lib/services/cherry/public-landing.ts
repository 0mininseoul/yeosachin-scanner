import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { parseCherryVariant, renderCherryLanding } from '@/lib/services/cherry/landing-variant';
import { CHERRY_PUBLIC_URL } from '@/lib/constants/cherry-public-url';
import { CHERRY_LEGACY_URL, isCherryDomainLive } from './public-domain';
import { parseReservationSource } from '@/public/cherry/reservation-source.mjs';

// Read once per instance: Meta ad clicks carry a unique fbclid, so most of them miss the CDN cache.
const landing = readFile(path.join(process.cwd(), 'public/cherry/landing.html'), 'utf8');

// The 전남친 page has its own path on the Cherry host, so organic links and search can reach it.
const EX_PAGE_URL = `${CHERRY_PUBLIC_URL}ex`;

export async function serveCherryLanding(request: NextRequest, onCherryHost: boolean, page?: 'ex') {
    const params = request.nextUrl.searchParams;
    const requested = parseCherryVariant(params.get('v'));
    // On /ex only ?v=ex marks the Meta ad arm; any other value still shows the 전남친 page as organic.
    const variant = page && requested !== page ? null : requested;
    const source = parseReservationSource(params.get('utm_source'));
    let html = renderCherryLanding(await landing, {
        variant: source ? null : variant,
        concept: page ?? variant ?? parseCherryVariant(params.get('concept')),
        pixelId: process.env.CHERRY_META_PIXEL_ID?.trim() || null,
    });
    if (onCherryHost && page === 'ex') {
        html = html
            .replace(/<title>[^<]*<\/title>/, '<title>체리 · 인스타 전남친 맞팔 알리미</title>')
            .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="헤어진 전남친의 인스타그램 새 맞팔이 궁금하다면, 체리가 카카오톡으로 알려드려요. 전남친 인스타 아이디 하나만 등록하면 돼요.">')
            .replace(`<link rel="canonical" href="${CHERRY_LEGACY_URL}">`, `<link rel="canonical" href="${EX_PAGE_URL}">`)
            .replace(`<meta property="og:url" content="${CHERRY_LEGACY_URL}">`, `<meta property="og:url" content="${EX_PAGE_URL}">`)
            .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, (schema) => schema
                .replaceAll(`"${CHERRY_LEGACY_URL}"`, `"${CHERRY_PUBLIC_URL}"`)
                .replaceAll(`"${CHERRY_LEGACY_URL}#`, `"${CHERRY_PUBLIC_URL}#`));
    } else if (onCherryHost) {
        // Apply shared search copy after variant substitution so the ad copy and OG card keep their variant.
        html = html
            .replace(/<title>[^<]*<\/title>/, '<title>체리 · 인스타 남친맞팔알리미, 짝남맞팔알리미, 전남친맞팔알리미</title>')
            .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="남친, 짝남, 전남친의 인스타그램 새 맞팔이 궁금하다면 체리 맞팔알리미에서 등록 가능한 계정과 카카오톡 알림 받는 방법을 확인하세요.">')
            .replace(/<summary>(?:남자친구|짝남|전남친) 말고 다른 사람도 되나요\?<\/summary>/, '<summary>전남친, 짝남, 썸남도 맞팔 알림을 받을 수 있나요?</summary>')
            .replace(`<link rel="canonical" href="${CHERRY_LEGACY_URL}">`, `<link rel="canonical" href="${CHERRY_PUBLIC_URL}">`)
            .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, (schema) => schema
                .replaceAll(`"${CHERRY_LEGACY_URL}"`, `"${CHERRY_PUBLIC_URL}"`)
                .replaceAll(`"${CHERRY_LEGACY_URL}#`, `"${CHERRY_PUBLIC_URL}#`));
        const naverVerification = process.env.CHERRY_NAVER_SITE_VERIFICATION?.trim();
        if (naverVerification && /^[a-f0-9]{40}$/i.test(naverVerification)) {
            html = html.replace('</head>', `  <meta name="naver-site-verification" content="${naverVerification}">\n  </head>`);
        }
    }
    const indexable = !onCherryHost || isCherryDomainLive();
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': indexable ? 'public, s-maxage=300, stale-while-revalidate=3600' : 'no-store',
            ...(!indexable && { 'X-Robots-Tag': 'noindex, nofollow' }),
        },
    });
}
